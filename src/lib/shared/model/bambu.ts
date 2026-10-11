/**
 * Bambu Studio / OrcaSlicer project files inside a 3MF:
 * - `Metadata/model_settings.config`: object and part names, part subtypes (normal_part,
 *   modifier_part, negative_part, support_blocker, support_enforcer), plates and their instances,
 *   and "assemble view" placements.
 * - `Metadata/slice_info.config`: per-plate print time, grams and filaments, only after slicing.
 * Plate names carry MakerWorld print tags such as "[Print x4]" and "[Optional]".
 */

import { parseDecimalString, parseIntegerString, parseNumberList } from './numbers'
import { parseTransform } from './transform'
import type { Transform3x4, Vec3 } from './types'
import { childElements, firstChild, type XmlElement } from './xml'

export const NORMAL_PART = 'normal_part'

export type ThreeMfProducer = 'bambu-studio' | 'orca-slicer' | 'prusa-slicer' | 'other'

export interface PartInfo {
  /** Bambu/Orca: the object id of the component holding the part. PrusaSlicer: the volume index. */
  id: number
  name?: string
  /** Bambu/Orca subtype (normal_part, modifier_part, ...) or PrusaSlicer volume type (ModelPart, ...). */
  subtype: string
  faceCount?: number
  /** PrusaSlicer: inclusive triangle range of the volume within the object's mesh. */
  triangles?: [number, number]
}

export interface SettingsObject {
  name?: string
  faceCount?: number
  parts: Map<number, PartInfo>
}

export interface PrintTags {
  /** From "[Print x4]"-style tags; 1 when there is none. */
  copies: number
  /** From an "[Optional]" tag. */
  optional: boolean
  /** The name without tags and without leading/trailing separators. */
  cleanName: string
}

export interface PlateInstance {
  objectId: number
  instanceId: number
  /** The build item of this instance: the instanceId-th item of objectId, in build order. */
  buildItemIndex?: number
}

export interface PlateInfo {
  id: number
  name: string
  tags: PrintTags
  instances: PlateInstance[]
}

/** Bambu "assemble view" placement of an object instance. */
export interface AssembleItem {
  objectId: number
  instanceId: number
  transform?: Transform3x4
  offset?: Vec3
}

export interface ModelSettings {
  objects: Map<number, SettingsObject>
  plates: PlateInfo[]
  assembly: AssembleItem[]
}

export interface SliceFilament {
  id?: number
  type?: string
  color?: string
  usedG?: number
  usedM?: number
}

export interface SlicePlate {
  index: number
  predictionSec?: number
  weightG?: number
  filaments: SliceFilament[]
}

export interface SliceInfo {
  clientVersion?: string
  plates: SlicePlate[]
}

const COPIES_PATTERNS: readonly RegExp[] = [
  /[[(]\s*print\s*[x×*]\s*(\d{1,4})\s*[\])]/i, // [Print x4], (Print ×4)
  /[[(]\s*print\s*(\d{1,4})\s*[x×]?\s*[\])]/i, // [Print 4x], [Print 4]
  /[[(]\s*[x×]\s*(\d{1,4})\s*[\])]/i, // [x4]
  /[[(]\s*(\d{1,4})\s*[x×]\s*[\])]/i, // [4x]
]
const OPTIONAL_PATTERN = /[[(]\s*optional\s*[\])]/i
const TAG_PATTERN =
  /[[(]\s*(?:optional|print\s*[x×*]?\s*\d{1,4}\s*[x×]?|[x×]\s*\d{1,4}|\d{1,4}\s*[x×])\s*[\])]/gi
const EDGE_SEPARATORS = /^[\s\-–—:|_,.]+|[\s\-–—:|_,]+$/g

/**
 * Print tags in plate names, as MakerWorld designers write them:
 * "[Print x4] - Magnetic frame - 6U" -> 4 copies; "[Optional] - Extension connectors" -> optional.
 */
export function parsePrintTags(name: string): PrintTags {
  let copies = 1
  for (const pattern of COPIES_PATTERNS) {
    const match = pattern.exec(name)
    if (match) {
      copies = Math.max(1, Number(match[1]))
      break
    }
  }
  const cleanName = name
    .replace(TAG_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .replace(EDGE_SEPARATORS, '')
    .trim()
  return { copies, optional: OPTIONAL_PATTERN.test(name), cleanName }
}

export function detectProducer(application: string | undefined): ThreeMfProducer {
  if (!application) return 'other'
  if (/bambu/i.test(application)) return 'bambu-studio'
  if (/orca/i.test(application)) return 'orca-slicer'
  if (/prusa|slic3r/i.test(application)) return 'prusa-slicer'
  return 'other'
}

/** Bambu's `<metadata key="k" value="v"/>` children. */
function metadataValue(element: XmlElement, key: string): string | undefined {
  const match = childElements(element, 'metadata').find((child) => child.attrs.get('key') === key)
  return match?.attrs.get('value')
}

function optionalNumber(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const value = parseDecimalString(text)
  return Number.isFinite(value) ? value : undefined
}

function toVec3(values: number[] | undefined): Vec3 | undefined {
  if (values?.length !== 3) return undefined
  const [x = 0, y = 0, z = 0] = values
  return [x, y, z]
}

function parseSettingsObject(element: XmlElement): SettingsObject {
  const parts = new Map<number, PartInfo>()
  for (const partElement of childElements(element, 'part')) {
    const id = parseIntegerString(partElement.attrs.get('id'))
    if (id === undefined) continue
    parts.set(id, {
      id,
      name: metadataValue(partElement, 'name'),
      subtype: partElement.attrs.get('subtype') ?? NORMAL_PART,
      faceCount: parseIntegerString(firstChild(partElement, 'mesh_stat')?.attrs.get('face_count')),
    })
  }
  // The object face count is written as <metadata face_count="N"/>, not as key/value.
  const faceCountElement = childElements(element, 'metadata').find((child) =>
    child.attrs.has('face_count'),
  )
  return {
    name: metadataValue(element, 'name'),
    faceCount: parseIntegerString(faceCountElement?.attrs.get('face_count')),
    parts,
  }
}

function parsePlate(element: XmlElement, ordinal: number): PlateInfo {
  const name = metadataValue(element, 'plater_name') ?? ''
  const instances = childElements(element, 'model_instance').flatMap((instance) => {
    const objectId = parseIntegerString(metadataValue(instance, 'object_id'))
    const instanceId = parseIntegerString(metadataValue(instance, 'instance_id')) ?? 0
    return objectId === undefined ? [] : [{ objectId, instanceId }]
  })
  return {
    id: parseIntegerString(metadataValue(element, 'plater_id')) ?? ordinal + 1,
    name,
    tags: parsePrintTags(name),
    instances,
  }
}

function parseAssembleItem(element: XmlElement): AssembleItem | undefined {
  const objectId = parseIntegerString(element.attrs.get('object_id'))
  if (objectId === undefined) return undefined
  const transform = element.attrs.get('transform')
  const offset = element.attrs.get('offset')
  return {
    objectId,
    instanceId: parseIntegerString(element.attrs.get('instance_id')) ?? 0,
    transform: transform === undefined ? undefined : parseTransform(transform),
    offset: offset === undefined ? undefined : toVec3(parseNumberList(offset)),
  }
}

/** Root element of `Metadata/model_settings.config`. */
export function parseModelSettings(root: XmlElement): ModelSettings {
  const objects = new Map<number, SettingsObject>()
  for (const element of childElements(root, 'object')) {
    const id = parseIntegerString(element.attrs.get('id'))
    if (id !== undefined) objects.set(id, parseSettingsObject(element))
  }
  const assemble = firstChild(root, 'assemble')
  const assembly = assemble
    ? childElements(assemble, 'assemble_item').flatMap((item) => parseAssembleItem(item) ?? [])
    : []
  return { objects, plates: childElements(root, 'plate').map(parsePlate), assembly }
}

function parseFilament(filament: XmlElement): SliceFilament {
  return {
    id: parseIntegerString(filament.attrs.get('id')),
    type: filament.attrs.get('type'),
    color: filament.attrs.get('color'),
    usedG: optionalNumber(filament.attrs.get('used_g')),
    usedM: optionalNumber(filament.attrs.get('used_m')),
  }
}

function parseSlicePlate(plate: XmlElement, ordinal: number): SlicePlate {
  return {
    index: parseIntegerString(metadataValue(plate, 'index')) ?? ordinal + 1,
    predictionSec: optionalNumber(metadataValue(plate, 'prediction')),
    weightG: optionalNumber(metadataValue(plate, 'weight')),
    filaments: childElements(plate, 'filament').map(parseFilament),
  }
}

/** Root element of `Metadata/slice_info.config`. */
export function parseSliceInfo(root: XmlElement): SliceInfo {
  const header = firstChild(root, 'header')
  const version = header
    ? childElements(header, 'header_item').find(
        (item) => item.attrs.get('key') === 'X-BBL-Client-Version',
      )
    : undefined
  return {
    clientVersion: version?.attrs.get('value'),
    plates: childElements(root, 'plate').map(parseSlicePlate),
  }
}
