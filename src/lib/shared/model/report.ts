/**
 * Facts-only structure reports for model files (3MF, STL, ZIP of models): what spike S1 needs from
 * real files, and what the app can attach to a problem report when an import fails. Plain-text
 * rendering lives in reportText.ts.
 *
 * A report never contains vertices or description text. Metadata values (title, designer, licence)
 * are facts and are included only when asked for.
 */

import { geometryKeyG1, geometrySignature, type GeometrySignature, sha256OfSource } from './hash'
import { analyzeIslands, bboxSize } from './mesh'
import { roundTo } from './numbers'
import { parseStl, type StlGroup } from './stl'
import { parseMeshes, parseStructure, type ThreeMfStructure } from './threemf'
import {
  type BBox,
  LimitExceededError,
  ModelError,
  type ModelLimits,
  type RandomAccessSource,
  resolveLimits,
  type Vec3,
} from './types'
import { bytesSource, looksLikeZip, openZip, type ZipArchive } from './zip'

export interface ReportOptions {
  /** Include metadata values (Title, Designer, License...). Off: keys only. Descriptions never. */
  metadataValues?: boolean
  /** Parse meshes for bounds, islands, signature and g1 key. */
  geometry?: boolean
  /** SHA-256 of each file (the key that relinks a re-dropped file). */
  fileHash?: boolean
  /** Islands listed per object, largest first (the count is always given). */
  maxIslands?: number
  limits?: Partial<ModelLimits>
}

export interface ZipEntryFacts {
  name: string
  size: number
  compressedSize: number
  method: string
  encrypted?: boolean
}

export interface ZipFacts {
  entryCount: number
  zip64: boolean
  prefixBytes: number
  entries: ZipEntryFacts[]
}

export interface IslandFacts {
  triangleCount: number
  bbox: BBox
  sizeMm: Vec3
  volumeMm3: number
  /** A cavity has inward-facing normals: an enclosed void such as a magnet pocket. */
  kind: 'solid' | 'cavity'
}

export interface MeshFacts {
  triangleCount: number
  vertexCount: number
  bbox?: BBox
  sizeMm?: Vec3
  signature: GeometrySignature
  g1: string
  islandCount: number
  islands: IslandFacts[]
}

export interface ObjectMeshFacts extends MeshFacts {
  objectId: number
  modelPath: string
  name?: string
  skippedTriangleCount: number
  buildItemIndices: number[]
}

interface ReportBase {
  name: string
  sizeBytes: number
  sha256?: string
}

export interface ThreeMfReport extends ReportBase {
  kind: '3mf'
  zip: ZipFacts
  metadataKeys: string[]
  /** Only with `metadataValues`. */
  metadata?: Record<string, string>
  structure: Omit<ThreeMfStructure, 'metadata'>
  /** One per root object, object-local frame. Only with `geometry`. */
  meshes?: ObjectMeshFacts[]
}

export interface StlReport extends ReportBase {
  kind: 'stl'
  format: 'binary' | 'ascii'
  groups: StlGroup[]
  header?: string
  /** Counts and bounds always; signature, g1 and islands only with `geometry`. */
  mesh: Partial<MeshFacts> & { triangleCount: number; vertexCount: number }
  skippedTriangleCount: number
  warnings: string[]
}

export interface ArchiveReport extends ReportBase {
  kind: 'zip'
  zip: ZipFacts
  /** STL and 3MF members, each described like a file of its own. */
  members: ModelReport[]
}

export interface FailedReport extends ReportBase {
  kind: 'error'
  error: { code: string; message: string }
  /** The archive listing, when the file was a readable ZIP. */
  zip?: ZipFacts
}

export type ModelReport = ThreeMfReport | StlReport | ArchiveReport | FailedReport

const MODEL_FILE = /\.(3mf|stl|zip)$/i
const DEFAULT_MAX_ISLANDS = 12

export function isModelFileName(name: string): boolean {
  return MODEL_FILE.test(name)
}

function methodName(method: number): string {
  if (method === 0) return 'stored'
  if (method === 8) return 'deflate'
  return `method ${method}`
}

function describeZip(zip: ZipArchive): ZipFacts {
  return {
    entryCount: zip.entries.length,
    zip64: zip.zip64,
    prefixBytes: zip.prefixBytes,
    entries: zip.entries.map((entry) => ({
      name: entry.name,
      size: entry.size,
      compressedSize: entry.compressedSize,
      method: methodName(entry.method),
      ...(entry.encrypted ? { encrypted: true } : {}),
    })),
  }
}

/** A ZIP is a 3MF package when it has OPC relationships or a 3D model part. */
function isThreeMfPackage(zip: ZipArchive): boolean {
  return zip.entries.some(
    ({ name }) => /^_rels\/\.rels$/i.test(name) || /^3D\/.+\.model$/i.test(name),
  )
}

/** Coordinates and sizes in reports: 0.001 mm is far below print resolution. */
const MM_DECIMALS = 3

function roundVec(vector: readonly number[]): Vec3 {
  return [
    roundTo(vector[0] ?? 0, MM_DECIMALS),
    roundTo(vector[1] ?? 0, MM_DECIMALS),
    roundTo(vector[2] ?? 0, MM_DECIMALS),
  ]
}

function roundBBox(bbox: BBox): BBox {
  return { min: roundVec(bbox.min), max: roundVec(bbox.max) }
}

function boundsFacts(bbox: BBox | undefined): { bbox?: BBox; sizeMm?: Vec3 } {
  return bbox ? { bbox: roundBBox(bbox), sizeMm: roundVec(bboxSize(bbox)) } : {}
}

async function describeMesh(
  mesh: { positions: Float32Array; indices: Uint32Array; bbox?: BBox },
  maxIslands: number,
): Promise<MeshFacts> {
  const islands = analyzeIslands(mesh)
  return {
    triangleCount: mesh.indices.length / 3,
    vertexCount: mesh.positions.length / 3,
    ...boundsFacts(mesh.bbox),
    signature: geometrySignature(mesh),
    g1: await geometryKeyG1(mesh),
    islandCount: islands.count,
    islands: islands.islands.slice(0, maxIslands).map((island) => ({
      triangleCount: island.triangleCount,
      bbox: roundBBox(island.bbox),
      sizeMm: roundVec(bboxSize(island.bbox)),
      volumeMm3: roundTo(island.signedVolumeMm3, 2),
      kind: island.signedVolumeMm3 < 0 ? 'cavity' : 'solid',
    })),
  }
}

async function describeThreeMf(
  base: ReportBase,
  zip: ZipArchive,
  options: ReportOptions,
): Promise<ThreeMfReport> {
  const { metadata, ...structure } = await parseStructure(zip, { limits: options.limits })
  const report: ThreeMfReport = {
    ...base,
    kind: '3mf',
    zip: describeZip(zip),
    metadataKeys: Object.keys(metadata),
    structure,
  }
  if (options.metadataValues) report.metadata = metadata
  if (options.geometry) {
    const meshes = await parseMeshes(zip, { limits: options.limits })
    const maxIslands = options.maxIslands ?? DEFAULT_MAX_ISLANDS
    report.meshes = []
    for (const mesh of meshes.objects) {
      report.meshes.push({
        objectId: mesh.objectId,
        modelPath: mesh.modelPath,
        name: mesh.name,
        skippedTriangleCount: mesh.skippedTriangleCount,
        buildItemIndices: mesh.buildItemIndices,
        ...(await describeMesh(mesh, maxIslands)),
      })
    }
  }
  return report
}

async function describeStl(
  base: ReportBase,
  bytes: Uint8Array,
  options: ReportOptions,
): Promise<StlReport> {
  const stl = parseStl(bytes, { maxTriangles: options.limits?.maxTriangles })
  const mesh = options.geometry
    ? await describeMesh(stl, options.maxIslands ?? DEFAULT_MAX_ISLANDS)
    : { triangleCount: stl.triangleCount, vertexCount: stl.vertexCount, ...boundsFacts(stl.bbox) }
  return {
    ...base,
    kind: 'stl',
    format: stl.format,
    groups: stl.groups,
    header: stl.header,
    mesh,
    skippedTriangleCount: stl.skippedTriangleCount,
    warnings: stl.warnings,
  }
}

async function describeArchive(
  base: ReportBase,
  zip: ZipArchive,
  options: ReportOptions,
  depth: number,
): Promise<ArchiveReport> {
  const members: ModelReport[] = []
  for (const entry of zip.entries) {
    if (entry.isDirectory || !/\.(stl|3mf)$/i.test(entry.name)) continue
    try {
      const bytes = await zip.read(entry)
      members.push(await describeSource(entry.name, bytesSource(bytes), options, depth + 1))
    } catch (error) {
      if (!(error instanceof ModelError)) throw error
      members.push(failure({ name: entry.name, sizeBytes: entry.size }, error))
    }
  }
  return { ...base, kind: 'zip', zip: describeZip(zip), members }
}

function failure(base: ReportBase, error: ModelError, zip?: ZipArchive): FailedReport {
  return {
    ...base,
    kind: 'error',
    error: { code: error.code, message: error.message },
    zip: zip && describeZip(zip),
  }
}

async function describeSource(
  name: string,
  source: RandomAccessSource,
  options: ReportOptions,
  depth: number,
): Promise<ModelReport> {
  const base: ReportBase = { name, sizeBytes: source.size }
  if (options.fileHash) base.sha256 = await sha256OfSource(source)
  let zip: ZipArchive | undefined
  try {
    const head = await source.read(0, Math.min(4, source.size))
    if (looksLikeZip(head) || /\.(3mf|zip)$/i.test(name)) {
      zip = await openZip(source, options.limits)
      if (isThreeMfPackage(zip)) return await describeThreeMf(base, zip, options)
      // Archives inside archives are listed, not opened: one level is all MakerWorld uses.
      if (depth > 0) return { ...base, kind: 'zip', zip: describeZip(zip), members: [] }
      return await describeArchive(base, zip, options, depth)
    }
    // An STL is parsed in memory, so the per-entry cap applies to the whole file.
    const maxBytes = resolveLimits(options.limits).maxEntryInflatedBytes
    if (source.size > maxBytes) throw new LimitExceededError('entry-bytes', source.size, maxBytes)
    return await describeStl(base, await source.read(0, source.size), options)
  } catch (error) {
    if (!(error instanceof ModelError)) throw error
    return failure(base, error, zip)
  }
}

/**
 * Describes one model file. Parse failures become a `kind: 'error'` report (with the archive
 * listing when there is one) instead of a rejection.
 */
export async function describeModel(
  name: string,
  source: RandomAccessSource,
  options: ReportOptions = {},
): Promise<ModelReport> {
  return describeSource(name, source, options, 0)
}
