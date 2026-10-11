/**
 * 3MF packages: the core spec, the Production extension (`p:path` components) and Bambu Studio /
 * OrcaSlicer project files.
 *
 * - `parseStructure`: facts about a package (metadata, objects, components, build items, plates with
 *   print tags, slice info, assembly placements). Geometry is counted and bounded, never kept.
 * - `parseMeshes`: one mesh per root object in its OBJECT-LOCAL frame: component transforms applied,
 *   the build-item transform NOT applied (it is returned separately), units scaled to millimetres,
 *   winding reversed under mirroring transforms, modifier / negative / support volumes skipped.
 *
 * Objects are always addressed by (model part, object id): ids are unique only within one model
 * part, and Bambu/Orca reuse id 1 in every `3D/Objects/*.model` part.
 */

import {
  type AssembleItem,
  detectProducer,
  type ModelSettings,
  NORMAL_PART,
  parseModelSettings,
  parseSliceInfo,
  type PartInfo,
  type PlateInfo,
  type SliceInfo,
  type ThreeMfProducer,
} from './bambu'
import { GrowableFloat32Array, GrowableUint32Array } from './growable'
import { appendTransformedMesh, computeBBox, selectTriangles } from './mesh'
import {
  type BuildItemRecord,
  type ComponentRecord,
  type GeometryBudget,
  type MeshRecord,
  type ModelPart,
  type ObjectRecord,
  parseModelPart,
} from './modelPart'
import { dirOf, PartIndex, parseRelationships } from './opc'
import { parsePrusaModelConfig, PRUSA_MODEL_PART, type PrusaVolume } from './prusa'
import { composeTransforms, IDENTITY_TRANSFORM } from './transform'
import {
  type BBox,
  LimitExceededError,
  ModelError,
  type ModelLimits,
  type RandomAccessSource,
  resolveLimits,
  type Transform3x4,
} from './types'
import { parseXml, type XmlElement } from './xml'
import { openZip, type ZipArchive, type ZipEntry } from './zip'

export type {
  AssembleItem,
  PartInfo,
  PlateInfo,
  PlateInstance,
  PrintTags,
  SliceFilament,
  SliceInfo,
  SlicePlate,
  ThreeMfProducer,
} from './bambu'
export { parsePrintTags } from './bambu'

export interface ThreeMfOptions {
  limits?: Partial<ModelLimits>
}

export interface MeshOptions extends ThreeMfOptions {
  /** Root object ids to build; every build-item object when omitted. */
  objectIds?: readonly number[]
}

export interface ComponentInfo {
  /** ZIP entry name of the model part holding the referenced object (raw p:path if unresolved). */
  path: string
  objectId: number
  /** Millimetres. */
  transform: Transform3x4
  /** Bambu/Orca part subtype from model_settings.config. */
  subtype?: string
  /** False for modifier/negative/support parts, non-solid object types and missing objects. */
  included: boolean
  unresolved?: boolean
}

export interface ObjectInfo {
  modelPath: string
  id: number
  name?: string
  /** 3MF object type: model, solidsupport, support, surface or other. */
  type: string
  /** Defined in the root model part (build items and plates refer to these). */
  isRoot: boolean
  components: ComponentInfo[]
  /** From model_settings.config (root objects only). */
  partNames?: string[]
  parts?: PartInfo[]
  /** Face count Bambu/Orca recorded in model_settings.config. */
  faceCount?: number
  /** Triangles parseMeshes would produce for this object (included parts only). */
  triangleCount: number
  vertexCount: number
  /** Triangles of the object's own mesh, included or not; objects made of components have none. */
  meshTriangleCount?: number
  /** Bounds of the object's own mesh in millimetres. */
  bbox?: BBox
}

export interface BuildItemInfo {
  index: number
  objectId: number
  /** Model part of the object: the root part unless the item has its own p:path. */
  path: string
  /** Millimetres. Places the object on the plate; parseMeshes never applies it. */
  transform: Transform3x4
  printable: boolean
}

export interface ThreeMfStructure {
  rootModelPath: string
  /** Unit of the root model part. */
  unit: string
  unitScaleMm: number
  producer: ThreeMfProducer
  /** Root model metadata without description-like keys (see omittedMetadataKeys). */
  metadata: Record<string, string>
  omittedMetadataKeys: string[]
  /** Model parts that were parsed: the root, then referenced parts, then declared-only parts. */
  modelPaths: string[]
  /** Model parts the root part's own relationships declare (e.g. 3D/_rels/3dmodel.model.rels). */
  declaredModelPaths: string[]
  objects: ObjectInfo[]
  buildItems: BuildItemInfo[]
  plates: PlateInfo[]
  assembly: AssembleItem[]
  /** Present only when Metadata/slice_info.config exists. */
  sliceInfo?: SliceInfo
  warnings: string[]
}

export interface ObjectMesh {
  objectId: number
  modelPath: string
  name?: string
  /** Millimetres, object-local frame. */
  positions: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
  vertexCount: number
  triangleCount: number
  bbox?: BBox
  /** Triangles left out: modifier, negative and support volumes, non-solid object types. */
  skippedTriangleCount: number
  /** Indices into `buildItems` of the items that place this object. */
  buildItemIndices: number[]
}

export interface ThreeMfMeshes {
  rootModelPath: string
  unit: string
  unitScaleMm: number
  objects: ObjectMesh[]
  buildItems: BuildItemInfo[]
  warnings: string[]
}

const START_PART_TYPE_SUFFIX = '/3dmodel'
const ROOT_RELS_PATH = '_rels/.rels'
const DEFAULT_ROOT_PATH = '3D/3dmodel.model'
const MODEL_SETTINGS_PATH = 'Metadata/model_settings.config'
const SLICE_INFO_PATH = 'Metadata/slice_info.config'
const PRUSA_CONFIG_PATH = 'Metadata/Slic3r_PE_model.config'
/** 3MF object types printed as solid geometry; support, surface and other are not parts. */
const SOLID_TYPES: ReadonlySet<string> = new Set(['model', 'solidsupport'])
/** Descriptions are never kept: the catalog stores facts and links, not copied text. */
const OMITTED_METADATA = /description/i

function invalid(message: string): ModelError {
  return new ModelError('invalid-3mf', message)
}

function warnOnce(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message)
}

function objectKey(path: string, id: number): string {
  return `${path}#${id}`
}

// ---------------------------------------------------------------------------------------------
// Package context and model part loading
// ---------------------------------------------------------------------------------------------

interface PackageContext {
  zip: ZipArchive
  limits: ModelLimits
  parts: PartIndex
  budget: GeometryBudget
  warnings: string[]
}

function isZipArchive(input: RandomAccessSource | ZipArchive): input is ZipArchive {
  return 'entries' in input
}

async function openPackage(
  input: RandomAccessSource | ZipArchive,
  overrides: Partial<ModelLimits> | undefined,
): Promise<PackageContext> {
  const zip = isZipArchive(input) ? input : await openZip(input, overrides)
  const limits = resolveLimits({ ...zip.limits, ...overrides })
  return {
    zip,
    limits,
    parts: new PartIndex(zip.entries),
    budget: { triangles: 0, vertices: 0, limits },
    warnings: [],
  }
}

/** Parses model parts on demand, each once, and resolves the p:path references between them. */
class ModelLoader {
  private readonly ctx: PackageContext
  private readonly withGeometry: boolean
  private readonly loaded = new Map<string, ModelPart>()
  private readonly resolved = new Map<string, string | null>()

  constructor(ctx: PackageContext, withGeometry: boolean) {
    this.ctx = ctx
    this.withGeometry = withGeometry
  }

  parts(): ModelPart[] {
    return [...this.loaded.values()]
  }

  lookup(path: string | undefined, id: number): ObjectRecord | undefined {
    return path === undefined ? undefined : this.loaded.get(path)?.objects.get(id)
  }

  async load(entry: ZipEntry): Promise<ModelPart> {
    const cached = this.loaded.get(entry.name)
    if (cached) return cached
    const part = await parseModelPart(this.ctx.zip, entry, {
      withGeometry: this.withGeometry,
      budget: this.ctx.budget,
    })
    this.loaded.set(entry.name, part)
    for (const object of part.objects.values()) {
      for (const component of object.components) {
        if (component.rawPath !== undefined)
          component.path = this.resolvePath(component.rawPath, part.path)
      }
    }
    for (const item of part.items) {
      if (item.rawPath !== undefined) item.path = this.resolvePath(item.rawPath, part.path)
    }
    return part
  }

  /** Loads the model parts that the build items point into (only p:path items leave the root). */
  async loadItemParts(items: readonly BuildItemRecord[]): Promise<void> {
    for (const item of items) await this.ensureLoaded(item.path)
  }

  /** Loads every model part reachable from `objects` through components, in reference order. */
  async loadReachable(objects: Iterable<ObjectRecord>): Promise<void> {
    const queue = [...objects]
    const seen = new Set<string>()
    for (let next = 0; next < queue.length; next++) {
      const object = queue[next]!
      const key = objectKey(object.modelPath, object.id)
      if (seen.has(key)) continue
      seen.add(key)
      for (const component of object.components) {
        await this.ensureLoaded(component.path)
        const child = this.lookup(component.path, component.objectId)
        if (child) queue.push(child)
      }
    }
  }

  private async ensureLoaded(path: string | undefined): Promise<void> {
    if (path === undefined || this.loaded.has(path)) return
    const entry = this.ctx.zip.get(path)
    if (entry) await this.load(entry)
  }

  private resolvePath(rawPath: string, fromPart: string): string | undefined {
    const baseDir = dirOf(fromPart)
    const key = `${baseDir}\u0000${rawPath}`
    const cached = this.resolved.get(key)
    if (cached !== undefined) return cached ?? undefined
    const hit = this.ctx.parts.resolve(rawPath, baseDir)
    if (!hit) {
      this.ctx.warnings.push(`Model part "${rawPath}" referenced from ${fromPart} is missing`)
    } else if (hit.match === 'case-insensitive' || hit.match === 'id-suffix') {
      this.ctx.warnings.push(`Model part "${rawPath}" matched ${hit.entry.name} (${hit.match})`)
    }
    this.resolved.set(key, hit ? hit.entry.name : null)
    return hit?.entry.name
  }
}

/** `3D/3dmodel.model` -> `3D/_rels/3dmodel.model.rels` (OPC part relationships). */
function relationshipsPathOf(partPath: string): string {
  const dir = dirOf(partPath)
  return `${dir}_rels/${partPath.slice(dir.length)}.rels`
}

/**
 * Model parts the root part declares in its own relationships (Bambu/Orca list every
 * 3D/Objects/*.model there). Missing targets become warnings.
 */
async function declaredModelParts(ctx: PackageContext, rootPath: string): Promise<ZipEntry[]> {
  const rels = ctx.parts.resolve(relationshipsPathOf(rootPath))
  if (!rels) return []
  let relationships
  try {
    relationships = parseRelationships(await ctx.zip.readText(rels.entry), ctx.limits.maxXmlDepth)
  } catch (error) {
    if (!(error instanceof ModelError) || error.code !== 'xml-malformed') throw error
    ctx.warnings.push(`${rels.entry.name} is malformed and was ignored: ${error.message}`)
    return []
  }
  const entries: ZipEntry[] = []
  for (const relationship of relationships) {
    if (!relationship.type.toLowerCase().endsWith(START_PART_TYPE_SUFFIX)) continue
    const hit = ctx.parts.resolve(relationship.target, dirOf(rootPath))
    if (hit) entries.push(hit.entry)
    else ctx.warnings.push(`${rels.entry.name} names a missing model part "${relationship.target}"`)
  }
  return entries
}

/** The StartPart from _rels/.rels, falling back to 3D/3dmodel.model and then any *.model. */
async function findRootModel(ctx: PackageContext): Promise<ZipEntry> {
  const rels = ctx.parts.resolve(ROOT_RELS_PATH)
  if (rels) {
    try {
      const relationships = parseRelationships(
        await ctx.zip.readText(rels.entry),
        ctx.limits.maxXmlDepth,
      )
      for (const relationship of relationships) {
        if (!relationship.type.toLowerCase().endsWith(START_PART_TYPE_SUFFIX)) continue
        const hit = ctx.parts.resolve(relationship.target)
        if (hit) return hit.entry
        ctx.warnings.push(`_rels/.rels names a missing root model "${relationship.target}"`)
      }
    } catch (error) {
      if (!(error instanceof ModelError) || error.code !== 'xml-malformed') throw error
      ctx.warnings.push(`_rels/.rels is malformed: ${error.message}`)
    }
  } else {
    ctx.warnings.push('No _rels/.rels; looking for the root model by name')
  }
  const fallback =
    ctx.parts.resolve(DEFAULT_ROOT_PATH)?.entry ?? shallowest(ctx.parts.modelEntries())
  if (!fallback) throw invalid('No 3D model part in the package')
  return fallback
}

function shallowest(entries: ZipEntry[]): ZipEntry | undefined {
  const depth = (entry: ZipEntry): number => entry.name.split('/').length
  return entries.toSorted((a, b) => depth(a) - depth(b) || a.name.localeCompare(b.name))[0]
}

/** Parses a small XML config. A malformed config becomes a warning, not a failed import. */
async function readConfig(ctx: PackageContext, path: string): Promise<XmlElement | undefined> {
  const hit = ctx.parts.resolve(path)
  if (!hit) return undefined
  try {
    return parseXml(await ctx.zip.readText(hit.entry), ctx.limits.maxXmlDepth)
  } catch (error) {
    if (!(error instanceof ModelError) || error.code !== 'xml-malformed') throw error
    ctx.warnings.push(`${hit.entry.name} is malformed and was ignored: ${error.message}`)
    return undefined
  }
}

async function readModelSettings(ctx: PackageContext): Promise<ModelSettings | undefined> {
  const root = await readConfig(ctx, MODEL_SETTINGS_PATH)
  return root && parseModelSettings(root)
}

async function readSliceInfo(ctx: PackageContext): Promise<SliceInfo | undefined> {
  const root = await readConfig(ctx, SLICE_INFO_PATH)
  return root && parseSliceInfo(root)
}

async function readPrusaVolumes(
  ctx: PackageContext,
): Promise<Map<number, PrusaVolume[]> | undefined> {
  const root = await readConfig(ctx, PRUSA_CONFIG_PATH)
  return root && parsePrusaModelConfig(root)
}

// ---------------------------------------------------------------------------------------------
// Walking component trees
// ---------------------------------------------------------------------------------------------

interface WalkContext {
  loader: ModelLoader
  rootPath: string
  settings: ModelSettings | undefined
  prusaVolumes: Map<number, PrusaVolume[]> | undefined
  limits: ModelLimits
  /** Missing objects throw when true (parseMeshes) and only warn otherwise (parseStructure). */
  strict: boolean
  warnings: string[]
}

/** Inclusive triangle index range. */
type TriangleRange = readonly [number, number]

/**
 * `excluded` lists triangle ranges of this mesh that are not printed geometry (PrusaSlicer
 * modifiers and other non-part volumes merged into an object's mesh).
 */
type MeshVisitor = (
  mesh: MeshRecord,
  transform: Transform3x4,
  included: boolean,
  excluded: readonly TriangleRange[],
) => void

const NO_RANGES: readonly TriangleRange[] = []

/** PrusaSlicer volumes of a root object's own mesh that are not model parts. */
function excludedVolumeRanges(walk: WalkContext, object: ObjectRecord): readonly TriangleRange[] {
  if (object.modelPath !== walk.rootPath) return NO_RANGES
  const volumes = walk.prusaVolumes?.get(object.id)
  if (!volumes) return NO_RANGES
  return volumes
    .filter((volume) => volume.type !== PRUSA_MODEL_PART)
    .map((volume): TriangleRange => [volume.firstTriangle, volume.lastTriangle])
}

function isInRanges(triangle: number, ranges: readonly TriangleRange[]): boolean {
  return ranges.some(([first, last]) => triangle >= first && triangle <= last)
}

function countInRanges(ranges: readonly TriangleRange[], triangleCount: number): number {
  let count = 0
  for (let t = 0; t < triangleCount; t++) if (isInRanges(t, ranges)) count++
  return count
}

/** Bambu/Orca part subtype of a root object's component: the part id is the component's object id. */
function partSubtype(
  walk: WalkContext,
  owner: ObjectRecord,
  component: ComponentRecord,
): string | undefined {
  if (owner.modelPath !== walk.rootPath) return undefined
  return walk.settings?.objects.get(owner.id)?.parts.get(component.objectId)?.subtype
}

function isNormalPart(subtype: string | undefined): boolean {
  return subtype === undefined || subtype === NORMAL_PART
}

/**
 * Visits every mesh under `root` with its accumulated component transform and whether it is printed
 * geometry. Guards against component cycles and runaway nesting.
 */
function walkObject(walk: WalkContext, root: ObjectRecord, visit: MeshVisitor): void {
  const active = new Set<string>()
  const step = (
    object: ObjectRecord,
    transform: Transform3x4,
    included: boolean,
    depth: number,
  ): void => {
    if (depth > walk.limits.maxComponentDepth) {
      throw new LimitExceededError('component-depth', depth, walk.limits.maxComponentDepth)
    }
    const key = objectKey(object.modelPath, object.id)
    if (active.has(key))
      throw invalid(`Component cycle through object ${object.id} of ${object.modelPath}`)
    active.add(key)
    const solid = included && SOLID_TYPES.has(object.type)
    if (object.mesh) {
      const excluded = depth === 0 ? excludedVolumeRanges(walk, object) : NO_RANGES
      visit(object.mesh, transform, solid, excluded)
    }
    for (const component of object.components) {
      const child = walk.loader.lookup(component.path, component.objectId)
      if (!child) {
        const message = `Object ${component.objectId} of ${component.path ?? component.rawPath} is missing`
        if (walk.strict) throw invalid(message)
        warnOnce(walk.warnings, message)
        continue
      }
      const normal = depth > 0 || isNormalPart(partSubtype(walk, object, component))
      step(child, composeTransforms(component.transform, transform), solid && normal, depth + 1)
    }
    active.delete(key)
  }
  step(root, IDENTITY_TRANSFORM, true, 0)
}

// ---------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------

function describeComponent(
  walk: WalkContext,
  owner: ObjectRecord,
  component: ComponentRecord,
): ComponentInfo {
  const subtype = partSubtype(walk, owner, component)
  const child = walk.loader.lookup(component.path, component.objectId)
  const info: ComponentInfo = {
    path: component.path ?? component.rawPath ?? '',
    objectId: component.objectId,
    transform: component.transform,
    subtype,
    included: child !== undefined && SOLID_TYPES.has(child.type) && isNormalPart(subtype),
  }
  if (component.path === undefined) info.unresolved = true
  return info
}

/** Vertices are counted per included mesh, so meshes trimmed to their parts still count whole. */
function countIncluded(
  walk: WalkContext,
  object: ObjectRecord,
): { triangles: number; vertices: number } {
  let triangles = 0
  let vertices = 0
  try {
    walkObject(walk, object, (mesh, _transform, included, excluded) => {
      if (!included) return
      triangles += mesh.triangleCount - countInRanges(excluded, mesh.triangleCount)
      vertices += mesh.vertexCount
    })
  } catch (error) {
    if (!(error instanceof ModelError)) throw error
    warnOnce(walk.warnings, error.message)
  }
  return { triangles, vertices }
}

/** Parts from Bambu/Orca model settings, or PrusaSlicer volumes. */
function describeParts(walk: WalkContext, object: ObjectRecord): PartInfo[] | undefined {
  if (object.modelPath !== walk.rootPath) return undefined
  const settings = walk.settings?.objects.get(object.id)
  if (settings) return [...settings.parts.values()]
  return walk.prusaVolumes?.get(object.id)?.map((volume, index) => ({
    id: index,
    name: volume.name,
    subtype: volume.type,
    triangles: [volume.firstTriangle, volume.lastTriangle],
  }))
}

function describeObject(walk: WalkContext, object: ObjectRecord): ObjectInfo {
  const isRoot = object.modelPath === walk.rootPath
  const settings = isRoot ? walk.settings?.objects.get(object.id) : undefined
  const counts = countIncluded(walk, object)
  const parts = describeParts(walk, object)
  return {
    modelPath: object.modelPath,
    id: object.id,
    name: settings?.name ?? object.name,
    type: object.type,
    isRoot,
    components: object.components.map((component) => describeComponent(walk, object, component)),
    parts,
    partNames: parts?.flatMap((part) => (part.name === undefined ? [] : [part.name])),
    faceCount: settings?.faceCount,
    triangleCount: counts.triangles,
    vertexCount: counts.vertices,
    meshTriangleCount: object.mesh?.triangleCount,
    bbox: object.mesh?.bbox,
  }
}

function describeBuildItems(part: ModelPart): BuildItemInfo[] {
  return part.items.map((item, index) => ({
    index,
    objectId: item.objectId,
    path: item.path ?? item.rawPath ?? '',
    transform: item.transform,
    printable: item.printable,
  }))
}

/** Bambu instance ids count the build items of one object, in build order. */
function linkPlateInstances(
  plates: PlateInfo[],
  buildItems: BuildItemInfo[],
  rootPath: string,
): PlateInfo[] {
  const itemsByObject = new Map<number, number[]>()
  for (const item of buildItems) {
    if (item.path !== rootPath) continue
    const list = itemsByObject.get(item.objectId) ?? []
    list.push(item.index)
    itemsByObject.set(item.objectId, list)
  }
  return plates.map((plate) => ({
    ...plate,
    instances: plate.instances.map((instance) => ({
      ...instance,
      buildItemIndex: itemsByObject.get(instance.objectId)?.[instance.instanceId],
    })),
  }))
}

function splitMetadata(metadata: Map<string, string>): {
  kept: Record<string, string>
  omitted: string[]
} {
  const kept: [string, string][] = []
  const omitted: string[] = []
  for (const [key, value] of metadata) {
    if (OMITTED_METADATA.test(key)) omitted.push(key)
    else kept.push([key, value])
  }
  return { kept: Object.fromEntries(kept), omitted }
}

/** Notes model parts that the package contains but nothing references (stale leftovers). */
function noteUnreferencedParts(ctx: PackageContext, loader: ModelLoader): void {
  const loaded = new Set(loader.parts().map((part) => part.path))
  const unreferenced = ctx.parts.modelEntries().filter((entry) => !loaded.has(entry.name))
  if (unreferenced.length > 0) {
    ctx.warnings.push(
      `Unreferenced model parts: ${unreferenced.map((entry) => entry.name).join(', ')}`,
    )
  }
}

/**
 * Facts about a 3MF package without keeping geometry: metadata, every object of every reachable
 * model part, build items, Bambu/Orca plates with print tags, assembly placements and slice info.
 */
export async function parseStructure(
  input: RandomAccessSource | ZipArchive,
  options: ThreeMfOptions = {},
): Promise<ThreeMfStructure> {
  const ctx = await openPackage(input, options.limits)
  const loader = new ModelLoader(ctx, false)
  const rootPart = await loader.load(await findRootModel(ctx))
  await loader.loadItemParts(rootPart.items)
  const allObjects = (): ObjectRecord[] =>
    loader.parts().flatMap((part) => [...part.objects.values()])
  await loader.loadReachable(allObjects())
  // Declared parts come after referenced ones, so modelPaths stays in reference order.
  const declared = await declaredModelParts(ctx, rootPart.path)
  for (const entry of declared) await loader.load(entry)
  await loader.loadReachable(allObjects())
  noteUnreferencedParts(ctx, loader)
  const settings = await readModelSettings(ctx)
  const sliceInfo = await readSliceInfo(ctx)
  const prusaVolumes = await readPrusaVolumes(ctx)
  const walk: WalkContext = {
    loader,
    rootPath: rootPart.path,
    settings,
    prusaVolumes,
    limits: ctx.limits,
    strict: false,
    warnings: ctx.warnings,
  }
  const objects = loader.parts().flatMap((part) => [...part.objects.values()])
  const buildItems = describeBuildItems(rootPart)
  const { kept, omitted } = splitMetadata(rootPart.metadata)
  const producer = detectProducer(rootPart.metadata.get('Application'))
  return {
    rootModelPath: rootPart.path,
    unit: rootPart.unit,
    unitScaleMm: rootPart.scale,
    producer: producer === 'other' && prusaVolumes ? 'prusa-slicer' : producer,
    metadata: kept,
    omittedMetadataKeys: omitted,
    modelPaths: loader.parts().map((part) => part.path),
    declaredModelPaths: declared.map((entry) => entry.name),
    objects: objects.map((object) => describeObject(walk, object)),
    buildItems,
    plates: linkPlateInstances(settings?.plates ?? [], buildItems, rootPart.path),
    assembly: settings?.assembly ?? [],
    sliceInfo,
    warnings: ctx.warnings,
  }
}

// ---------------------------------------------------------------------------------------------
// Meshes
// ---------------------------------------------------------------------------------------------

interface MeshTarget {
  object: ObjectRecord
  buildItemIndices: number[]
}

/** Root objects no other root object uses as a component: the parts when there is no build. */
function topLevelObjects(rootPart: ModelPart): ObjectRecord[] {
  const used = new Set<number>()
  for (const object of rootPart.objects.values()) {
    for (const component of object.components) {
      if (component.path === rootPart.path) used.add(component.objectId)
    }
  }
  return [...rootPart.objects.values()].filter((object) => !used.has(object.id))
}

/** Build-item objects in build order (or top-level objects without a build), filtered by id. */
function selectTargets(
  walk: WalkContext,
  rootPart: ModelPart,
  objectIds?: readonly number[],
): MeshTarget[] {
  const targets = new Map<string, MeshTarget>()
  rootPart.items.forEach((item, index) => {
    const object = walk.loader.lookup(item.path, item.objectId)
    if (!object) throw invalid(`Build item ${index} refers to missing object ${item.objectId}`)
    const key = objectKey(object.modelPath, object.id)
    const target = targets.get(key) ?? { object, buildItemIndices: [] }
    target.buildItemIndices.push(index)
    targets.set(key, target)
  })
  if (targets.size === 0) {
    for (const object of topLevelObjects(rootPart)) {
      targets.set(objectKey(object.modelPath, object.id), { object, buildItemIndices: [] })
    }
  }
  const wanted = objectIds ? new Set(objectIds) : undefined
  return [...targets.values()].filter((target) => !wanted || wanted.has(target.object.id))
}

function assembleObject(walk: WalkContext, target: MeshTarget): ObjectMesh {
  const positions = new GrowableFloat32Array()
  const indices = new GrowableUint32Array()
  let skippedTriangleCount = 0
  walkObject(walk, target.object, (mesh, transform, included, excluded) => {
    if (!included) {
      skippedTriangleCount += mesh.triangleCount
      return
    }
    if (!mesh.geometry) return
    // Trimmed meshes keep only the vertices their triangles use, so bounds stay exact.
    const kept =
      excluded.length === 0
        ? mesh.geometry
        : selectTriangles(mesh.geometry, (triangle) => !isInRanges(triangle, excluded))
    skippedTriangleCount += mesh.triangleCount - kept.indices.length / 3
    appendTransformedMesh(positions, indices, kept, transform)
  })
  const { object } = target
  const isRoot = object.modelPath === walk.rootPath
  const positionArray = positions.toArray()
  const indexArray = indices.toArray()
  return {
    objectId: object.id,
    modelPath: object.modelPath,
    name: (isRoot ? walk.settings?.objects.get(object.id)?.name : undefined) ?? object.name,
    positions: positionArray,
    indices: indexArray,
    vertexCount: positionArray.length / 3,
    triangleCount: indexArray.length / 3,
    bbox: computeBBox(positionArray),
    skippedTriangleCount,
    buildItemIndices: target.buildItemIndices,
  }
}

/**
 * One mesh per root object (the build-item objects, optionally narrowed to `objectIds`) in its
 * object-local frame: component transforms applied, build-item transforms returned separately.
 * Only the model parts those objects reach are inflated.
 */
export async function parseMeshes(
  input: RandomAccessSource | ZipArchive,
  options: MeshOptions = {},
): Promise<ThreeMfMeshes> {
  const ctx = await openPackage(input, options.limits)
  const loader = new ModelLoader(ctx, true)
  const rootPart = await loader.load(await findRootModel(ctx))
  await loader.loadItemParts(rootPart.items)
  const walk: WalkContext = {
    loader,
    rootPath: rootPart.path,
    settings: await readModelSettings(ctx),
    prusaVolumes: await readPrusaVolumes(ctx),
    limits: ctx.limits,
    strict: true,
    warnings: ctx.warnings,
  }
  const targets = selectTargets(walk, rootPart, options.objectIds)
  await loader.loadReachable(targets.map((target) => target.object))
  return {
    rootModelPath: rootPart.path,
    unit: rootPart.unit,
    unitScaleMm: rootPart.scale,
    objects: targets.map((target) => assembleObject(walk, target)),
    buildItems: describeBuildItems(rootPart),
    warnings: ctx.warnings,
  }
}
