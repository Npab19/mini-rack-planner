/**
 * What the mount chooser offers for a device dropped on the rack, as plain functions: the device's
 * own ears (ear-mounted gear), the catalog mounts that take it (`mountSuggestions`, best first),
 * and a generic shelf when one holds it. Each option says whether it fits where the device was
 * dropped (`checkDeviceAt`) and, when not, the nearest free spot (`findDeviceSpot`).
 *
 * Also the "Needs a mount?" helper's prefill for a custom mount sized for the device.
 */
import type { CustomItemInput } from '@/domain/customParts'
import { mountSuggestions, type MountSuggestion } from '@/domain/devices'
import { checkDeviceAt, findDeviceSpot, type DeviceSpot } from '@/domain/fit'
import { GENERATOR_TOLERANCE_MM, suggestedMountSixths } from '@/domain/mountGenerator'
import {
  catalogBundle,
  createCatalogLookup,
  deviceName,
  withCustomEntries,
  type CatalogLookup,
  type Device,
  type Frame,
} from '@/domain/schema/catalog'
import type { Face } from '@/domain/schema/common'
import type { Plan } from '@/domain/schema/plan'

/** Generic shelves offered when no listed mount is one (catalog ids, smallest first). */
export const GENERIC_SHELF_IDS: readonly string[] = ['generic-shelf-1u', 'generic-shelf-2u']
/** Catalog mounts listed at most (a generic shelf may be added after them). */
export const CHOOSER_SUGGESTIONS = 6

export type ChooserOptionKind = 'own-ears' | 'mount' | 'generic-shelf'

export interface ChooserOption {
  kind: ChooserOptionKind
  /** What the new placement holds: the mount, or the device itself (its own ears). */
  itemId: string
  name: string
  /** Rack space it takes with the device in it, in sixths. */
  heightSixths: number
  /** Made for this frame (listed first). */
  frameSpecific: boolean
  /** Where it would go: where the device was dropped when that is free, else the nearest free spot. */
  spot: DeviceSpot | null
  /** `spot` is the position the device was dropped at. */
  atDrop: boolean
  /** Why the dropped position does not work for it (when it does not). */
  dropReason?: string
}

function isGenericShelf(itemId: string): boolean {
  return GENERIC_SHELF_IDS.includes(itemId)
}

/** The smallest generic shelf that holds the device, as a mount suggestion. */
function genericShelf(device: Device, lookup: CatalogLookup, frame: Frame) {
  for (const id of GENERIC_SHELF_IDS) {
    const item = lookup.item(id)
    if (item === undefined || item.kind !== 'item') continue
    const only = createCatalogLookup(catalogBundle([item]))
    const [suggestion] = mountSuggestions(device, only, frame, 1)
    if (suggestion !== undefined) return suggestion
  }
  return undefined
}

type Candidate = Omit<ChooserOption, 'spot' | 'atDrop' | 'dropReason'>

function fromSuggestion(suggestion: MountSuggestion, lookup: CatalogLookup): Candidate {
  return {
    kind: isGenericShelf(suggestion.itemId) ? 'generic-shelf' : 'mount',
    itemId: suggestion.itemId,
    name: lookup.item(suggestion.itemId)?.name ?? suggestion.itemId,
    heightSixths: suggestion.heightSixths,
    frameSpecific: suggestion.frameSpecific,
  }
}

/**
 * The chooser's options for `device` dropped with its bottom at `y` on `face`: its own ears
 * first (ear-mounted gear), then the catalog mounts that take it (best first, up to
 * `CHOOSER_SUGGESTIONS`), then the smallest generic shelf that holds it when none of those is
 * one. Each comes with the spot it would take: the dropped position when free (snapped to its
 * holes), else the nearest free spot on that face (or on its own face when it does not mount on
 * this one), else none.
 */
export function chooserOptions(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  device: Device,
  face: Face,
  y: number,
): ChooserOption[] {
  const lookup = withCustomEntries(catalog, plan.custom)
  const candidates: Candidate[] = []
  if (device.rackmount !== undefined) {
    candidates.push({
      kind: 'own-ears',
      itemId: device.id,
      name: deviceName(device),
      heightSixths: device.rackmount.heightSixths,
      frameSpecific: false,
    })
  }
  for (const suggestion of mountSuggestions(device, lookup, frame, CHOOSER_SUGGESTIONS)) {
    candidates.push(fromSuggestion(suggestion, lookup))
  }
  if (!candidates.some((candidate) => candidate.kind === 'generic-shelf')) {
    const shelf = genericShelf(device, lookup, frame)
    if (shelf !== undefined) candidates.push(fromSuggestion(shelf, lookup))
  }
  return candidates.map((candidate) => {
    const check = checkDeviceAt(plan, lookup, frame, candidate.itemId, device, y, face)
    if (check.spot !== null) return { ...candidate, spot: check.spot, atDrop: true }
    const faces = mountFaces(lookup, candidate.itemId, device)
    const nearest = findDeviceSpot(plan, lookup, frame, candidate.itemId, device, {
      near: check.y,
      ...(faces.includes(face) ? { face } : {}),
    })
    const reason = check.reasons[0]
    return {
      ...candidate,
      spot: nearest,
      atDrop: false,
      ...(reason === undefined ? {} : { dropReason: reason }),
    }
  })
}

function mountFaces(lookup: CatalogLookup, itemId: string, device: Device): readonly Face[] {
  if (itemId === device.id) return device.rackmount === undefined ? [] : [device.rackmount.face]
  return lookup.item(itemId)?.faces ?? []
}

// ---------------------------------------------------------------------------------------------
// "Create a custom mount sized for it"

function mm(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * A custom mount sized for the device, as the custom part editor's prefill (the fields
 * `customMountForDevice` fills in): "<device> mount", the suggested height, one fixed slot of the
 * device's size plus the generators' tolerance, for its category.
 */
export function customMountPrefill(device: Device, frame: Frame): Partial<CustomItemInput> {
  const room = GENERATOR_TOLERANCE_MM
  return {
    name: `${deviceName(device)} mount`,
    category: `${device.category}-mount`,
    heightSixths: suggestedMountSixths(device, frame),
    depthMm: mm(device.dims.d + room),
    faces: ['front'],
    holds: {
      kind: 'device',
      maxW: mm(device.dims.w + room),
      maxD: mm(device.dims.d + room),
      maxH: mm(device.dims.h + room),
      categories: [device.category],
    },
  }
}
