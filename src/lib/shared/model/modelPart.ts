/**
 * One 3MF model part (`3D/*.model`): streamed from the ZIP through the byte-level XML scanner into
 * records of objects (meshes or components), build items, metadata and units.
 *
 * Coordinates and translations are converted to millimetres here, using the part's own unit.
 */

import { GrowableFloat32Array, GrowableUint32Array } from './growable'
import { BoundsBuilder, computeBBox } from './mesh'
import { parseDecimalString, parseIntegerString } from './numbers'
import { IDENTITY_TRANSFORM, parseTransform, scaleTranslation } from './transform'
import {
  type BBox,
  LimitExceededError,
  ModelError,
  type ModelLimits,
  type Transform3x4,
} from './types'
import { localName, type ModelXmlHandler, ModelXmlScanner, type XmlAttributes } from './xml'
import type { ZipArchive, ZipEntry } from './zip'

const PRODUCTION_NAMESPACE = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06'
const UNIT_SCALE_MM: ReadonlyMap<string, number> = new Map([
  ['micron', 0.001],
  ['millimeter', 1],
  ['centimeter', 10],
  ['inch', 25.4],
  ['foot', 304.8],
  ['meter', 1000],
])
const TEXT_ELEMENTS: ReadonlySet<string> = new Set(['metadata'])

export interface MeshRecord {
  vertexCount: number
  triangleCount: number
  /** Millimetres. */
  bbox?: BBox
  /** Only when the part was parsed with geometry. Millimetres. */
  geometry?: { positions: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> }
}

export interface ComponentRecord {
  objectId: number
  /** p:path as written, if any. */
  rawPath?: string
  /** Entry name of the model part holding the object; undefined while (or if) unresolved. */
  path?: string
  /** Millimetres. */
  transform: Transform3x4
}

export interface ObjectRecord {
  modelPath: string
  id: number
  /** Lower-cased 3MF object type (default "model"). */
  type: string
  name?: string
  components: ComponentRecord[]
  mesh?: MeshRecord
}

export interface BuildItemRecord {
  objectId: number
  rawPath?: string
  path?: string
  /** Millimetres. */
  transform: Transform3x4
  printable: boolean
}

export interface ModelPart {
  path: string
  unit: string
  /** Factor from the part's unit to millimetres. */
  scale: number
  metadata: Map<string, string>
  objects: Map<number, ObjectRecord>
  items: BuildItemRecord[]
}

/** Geometry caps shared by every model part of one parse call. */
export interface GeometryBudget {
  triangles: number
  vertices: number
  readonly limits: ModelLimits
}

function invalid(message: string): ModelError {
  return new ModelError('invalid-3mf', message)
}

function checkIndices(maxIndex: number, vertexCount: number, where: string): void {
  if (maxIndex >= vertexCount) {
    throw invalid(`${where}: a triangle uses vertex ${maxIndex} of ${vertexCount}`)
  }
}

function max3(a: number, b: number, c: number): number {
  return a > b ? (a > c ? a : c) : b > c ? b : c
}

interface MeshAccumulator {
  addVertex(x: number, y: number, z: number): void
  addTriangle(a: number, b: number, c: number): void
  finish(where: string): MeshRecord
}

/** Counts and bounds only (parseStructure). */
class MeshStatsAccumulator implements MeshAccumulator {
  private readonly scale: number
  private readonly bounds = new BoundsBuilder()
  private vertexCount = 0
  private triangleCount = 0
  private maxIndex = -1

  constructor(scale: number) {
    this.scale = scale
  }

  addVertex(x: number, y: number, z: number): void {
    this.vertexCount++
    this.bounds.add(x * this.scale, y * this.scale, z * this.scale)
  }

  addTriangle(a: number, b: number, c: number): void {
    this.triangleCount++
    const highest = max3(a, b, c)
    if (highest > this.maxIndex) this.maxIndex = highest
  }

  finish(where: string): MeshRecord {
    checkIndices(this.maxIndex, this.vertexCount, where)
    return {
      vertexCount: this.vertexCount,
      triangleCount: this.triangleCount,
      bbox: this.bounds.build(),
    }
  }
}

/** Keeps the geometry, scaled to millimetres as it arrives (parseMeshes). */
class MeshGeometryAccumulator implements MeshAccumulator {
  private readonly scale: number
  private readonly positions = new GrowableFloat32Array()
  private readonly indices = new GrowableUint32Array()
  private maxIndex = -1

  constructor(scale: number) {
    this.scale = scale
  }

  addVertex(x: number, y: number, z: number): void {
    const scale = this.scale
    this.positions.push3(x * scale, y * scale, z * scale)
  }

  addTriangle(a: number, b: number, c: number): void {
    this.indices.push3(a, b, c)
    const highest = max3(a, b, c)
    if (highest > this.maxIndex) this.maxIndex = highest
  }

  finish(where: string): MeshRecord {
    const positions = this.positions.toArray()
    const indices = this.indices.toArray()
    checkIndices(this.maxIndex, positions.length / 3, where)
    return {
      vertexCount: positions.length / 3,
      triangleCount: indices.length / 3,
      bbox: computeBBox(positions),
      geometry: { positions, indices },
    }
  }
}

function parseVertexAttributes(attrs: XmlAttributes): [number, number, number] | undefined {
  const x = parseDecimalString(attrs.get('x') ?? '')
  const y = parseDecimalString(attrs.get('y') ?? '')
  const z = parseDecimalString(attrs.get('z') ?? '')
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? [x, y, z] : undefined
}

function parseTriangleAttributes(attrs: XmlAttributes): [number, number, number] | undefined {
  const a = parseIntegerString(attrs.get('v1'))
  const b = parseIntegerString(attrs.get('v2'))
  const c = parseIntegerString(attrs.get('v3'))
  return a === undefined || b === undefined || c === undefined ? undefined : [a, b, c]
}

/** Receives scanner events for one model part and builds its ModelPart record. */
class ModelPartHandler implements ModelXmlHandler {
  readonly part: ModelPart
  private readonly withGeometry: boolean
  private readonly budget: GeometryBudget
  private readonly elements: string[] = []
  private productionPrefix = 'p'
  private object: ObjectRecord | undefined
  private mesh: MeshAccumulator | undefined
  private metadataName: string | undefined

  constructor(path: string, withGeometry: boolean, budget: GeometryBudget) {
    this.part = {
      path,
      unit: 'millimeter',
      scale: 1,
      metadata: new Map(),
      objects: new Map(),
      items: [],
    }
    this.withGeometry = withGeometry
    this.budget = budget
  }

  open(name: string, attrs: XmlAttributes): void {
    const local = localName(name)
    const parent = this.elements[this.elements.length - 1]
    this.elements.push(local)
    if (parent === undefined) {
      if (local !== 'model')
        throw invalid(`${this.part.path}: root element is <${name}>, not <model>`)
      this.openModel(attrs)
    } else if (local === 'metadata' && parent === 'model') {
      this.metadataName = attrs.get('name')
    } else if (local === 'object' && parent === 'resources') {
      this.openObject(attrs)
    } else if (local === 'mesh' && parent === 'object' && this.object) {
      this.mesh = this.withGeometry
        ? new MeshGeometryAccumulator(this.part.scale)
        : new MeshStatsAccumulator(this.part.scale)
    } else if (local === 'component' && parent === 'components') {
      this.addComponent(attrs)
    } else if (local === 'item' && parent === 'build') {
      this.addBuildItem(attrs)
    } else if (this.mesh && local === 'vertex' && parent === 'vertices') {
      // Prefixed core elements (rare) miss the scanner's fast path and arrive here.
      const vertex = parseVertexAttributes(attrs)
      if (!vertex) throw invalid(`${this.part.path}: invalid <${name}>`)
      this.vertex(...vertex)
    } else if (this.mesh && local === 'triangle' && parent === 'triangles') {
      const triangle = parseTriangleAttributes(attrs)
      if (!triangle) throw invalid(`${this.part.path}: invalid <${name}>`)
      this.triangle(...triangle)
    }
  }

  close(_name: string, text: string | undefined): void {
    const local = this.elements.pop()
    if (local === 'metadata' && this.metadataName !== undefined) {
      this.part.metadata.set(this.metadataName, text ?? '')
      this.metadataName = undefined
    } else if (local === 'mesh' && this.mesh && this.object) {
      this.object.mesh = this.mesh.finish(`${this.part.path} object ${this.object.id}`)
      this.mesh = undefined
    } else if (local === 'object' && this.object) {
      const object = this.object
      this.object = undefined
      if (this.part.objects.has(object.id))
        throw invalid(`${this.part.path} defines object ${object.id} twice`)
      this.part.objects.set(object.id, object)
    }
  }

  vertex(x: number, y: number, z: number): void {
    const mesh = this.mesh
    if (!mesh) throw invalid(`${this.part.path}: <vertex> outside a <mesh>`)
    const budget = this.budget
    if (++budget.vertices > budget.limits.maxVertices) {
      throw new LimitExceededError('vertices', budget.vertices, budget.limits.maxVertices)
    }
    mesh.addVertex(x, y, z)
  }

  triangle(v1: number, v2: number, v3: number): void {
    const mesh = this.mesh
    if (!mesh) throw invalid(`${this.part.path}: <triangle> outside a <mesh>`)
    const budget = this.budget
    if (++budget.triangles > budget.limits.maxTriangles) {
      throw new LimitExceededError('triangles', budget.triangles, budget.limits.maxTriangles)
    }
    mesh.addTriangle(v1, v2, v3)
  }

  private openModel(attrs: XmlAttributes): void {
    const unit = (attrs.get('unit') ?? 'millimeter').trim().toLowerCase()
    const scale = UNIT_SCALE_MM.get(unit)
    if (scale === undefined) throw invalid(`${this.part.path}: unknown unit "${unit}"`)
    this.part.unit = unit
    this.part.scale = scale
    for (const [key, value] of attrs) {
      if (key.startsWith('xmlns:') && value === PRODUCTION_NAMESPACE)
        this.productionPrefix = key.slice(6)
    }
  }

  private openObject(attrs: XmlAttributes): void {
    const id = parseIntegerString(attrs.get('id'))
    if (id === undefined) throw invalid(`${this.part.path}: <object> without a valid id`)
    this.object = {
      modelPath: this.part.path,
      id,
      type: (attrs.get('type') ?? 'model').trim().toLowerCase(),
      name: attrs.get('name'),
      components: [],
    }
  }

  private addComponent(attrs: XmlAttributes): void {
    if (!this.object) return
    const objectId = parseIntegerString(attrs.get('objectid'))
    if (objectId === undefined)
      throw invalid(`${this.part.path}: <component> without a valid objectid`)
    const rawPath = this.productionAttribute(attrs, 'path')
    this.object.components.push({
      objectId,
      rawPath,
      path: rawPath === undefined ? this.part.path : undefined,
      transform: this.transformAttribute(attrs),
    })
  }

  private addBuildItem(attrs: XmlAttributes): void {
    const objectId = parseIntegerString(attrs.get('objectid'))
    if (objectId === undefined)
      throw invalid(`${this.part.path}: build <item> without a valid objectid`)
    const rawPath = this.productionAttribute(attrs, 'path')
    const printable = (attrs.get('printable') ?? '1').trim().toLowerCase()
    this.part.items.push({
      objectId,
      rawPath,
      path: rawPath === undefined ? this.part.path : undefined,
      transform: this.transformAttribute(attrs),
      printable: printable !== '0' && printable !== 'false',
    })
  }

  /** Production-extension attribute, whatever prefix the file bound that namespace to. */
  private productionAttribute(attrs: XmlAttributes, local: string): string | undefined {
    const direct = attrs.get(`${this.productionPrefix}:${local}`)
    if (direct !== undefined) return direct
    for (const [key, value] of attrs) {
      if (!key.startsWith('xmlns:') && key.endsWith(`:${local}`)) return value
    }
    return undefined
  }

  /** The transform attribute with its translation converted to millimetres. */
  private transformAttribute(attrs: XmlAttributes): Transform3x4 {
    const text = attrs.get('transform')
    if (text === undefined) return IDENTITY_TRANSFORM
    const transform = parseTransform(text)
    if (!transform) throw invalid(`${this.part.path}: invalid transform "${text}"`)
    return scaleTranslation(transform, this.part.scale)
  }
}

export interface ModelPartOptions {
  /** Keep vertex and index arrays (parseMeshes) or only counts and bounds (parseStructure). */
  withGeometry: boolean
  budget: GeometryBudget
}

/** Streams one model part out of the archive and parses it. */
export async function parseModelPart(
  zip: ZipArchive,
  entry: ZipEntry,
  options: ModelPartOptions,
): Promise<ModelPart> {
  const { limits } = options.budget
  const handler = new ModelPartHandler(entry.name, options.withGeometry, options.budget)
  const scanner = new ModelXmlScanner(handler, {
    textElements: TEXT_ELEMENTS,
    maxTokenBytes: limits.maxXmlTokenBytes,
    maxDepth: limits.maxXmlDepth,
  })
  try {
    await zip.stream(entry, (chunk) => {
      scanner.push(chunk)
    })
    scanner.finish()
  } catch (error) {
    if (error instanceof ModelError && error.code === 'xml-malformed') {
      throw new ModelError('xml-malformed', `${entry.name}: ${error.message}`, { cause: error })
    }
    throw error
  }
  return handler.part
}
