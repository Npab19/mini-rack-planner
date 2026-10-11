/**
 * Devices in slots and the "Equipment to fit" tray (M3a).
 *
 * - What a device needs: `mountSuggestions` (catalog mounts that take it, frame-specific first),
 *   `estimateDeviceSixths` and `equipmentUSummary` ("Needs ~10U · rack 9U → +3U").
 * - The tray: `addEquipment`, `removeEquipment`.
 * - Devices in a placement's slots: `assignDevice` / `assignEquipment` (fit-checked; area slots
 *   re-pack), `removeDevice`, and `placeEquipmentOnMount` (a new placement that takes a tray
 *   device, or the device itself when it is ear-mounted gear).
 *
 * Pure: inputs are never mutated. Edits that cannot run return the input plan with a user-facing
 * `error` (the `StackOpResult` contract); plain `Plan` edits return the same plan for unknown ids.
 * Catalog lookups get the plan's own entries layered on (`withCustomEntries`, idempotent).
 */
import type { StackOpResult } from './api'
import { placementName, totalHeightSixths } from './frame'
import { formatU, mmToSixthsCeil, phaseOf, SIXTHS_PER_U, U_MM, uNumberAt } from './geometry'
import { ID_PREFIX, KEBAB_PATTERN, newId } from './ids'
import {
  addPlacement,
  canPlace,
  DEVICE_GAP_MM,
  fitDeviceInSlot,
  fitsSlot,
  occupiedBox,
  orientedDims,
  packAreaSlot,
  resolvePlaceable,
  SHELF_HEADROOM_MM,
  type PackItem,
  type PackResult,
  type PlaceReason,
} from './placement'
import {
  deviceName,
  withCustomEntries,
  type CatalogLookup,
  type Device,
  type Frame,
  type Item,
  type SectionType,
  type Slot,
} from './schema/catalog'
import { CUSTOM_ID_PREFIX, type Face, type Orientation } from './schema/common'
import type { PlacedDevice, Placement, PlacementBay, Plan } from './schema/plan'

/** How many mounts `mountSuggestions` returns by default. */
export const DEFAULT_MOUNT_SUGGESTIONS = 5
/** Room added above a device's height when its U is estimated without a mount. */
export const ESTIMATE_CLEARANCE_MM = 6

// Same rule as `IdSchema` (schema/common.ts), without building a zod schema here.
const ID_PATTERN = new RegExp(`^(?:${CUSTOM_ID_PREFIX})?${KEBAB_PATTERN}$`)
const MAX_ID_LENGTH = 100
const EPSILON = 1e-9

// ---------------------------------------------------------------------------------------------
// Results

/** A device edit's result: the `StackOpResult` contract plus the ids it created or used. */
export interface DeviceOpResult extends StackOpResult {
  /** The placement that holds the device (new for `placeEquipmentOnMount`). */
  placementId?: string
  /** The device entry inside that placement. */
  deviceEntryId?: string
}

/** The plan unchanged with a user-facing error (first letter capitalized: some reasons are reused). */
function failed(plan: Plan, error: string): DeviceOpResult {
  const message = error.trim()
  return { plan, conflicts: [], error: message.charAt(0).toUpperCase() + message.slice(1) }
}

// ---------------------------------------------------------------------------------------------
// Mount suggestions and U estimates

export interface MountSuggestion {
  itemId: string
  slotId: string
  /**
   * Rack space the mount takes with the device in it: the item's height, or more when the device
   * stands taller than it (counted like `occupiedBox`: slot floor + device + headroom).
   */
  heightSixths: number
  /** Made for this frame (item.compat.frames) rather than generic 10". */
  frameSpecific: boolean
}

/** A slot that takes a device, and the first allowed orientation the device fits in. */
export interface SlotChoice {
  slot: Slot
  orientation: Orientation
}

/** The first slot (in the item's order) that accepts the device and fits it. */
export function slotForDevice(slots: readonly Slot[], device: Device): SlotChoice | undefined {
  for (const slot of slots) {
    const fit = fitDeviceInSlot(device, slot)
    if (fit.ok && fit.orientation !== undefined) return { slot, orientation: fit.orientation }
  }
  return undefined
}

/** Height of a mount with a device in a slot, as `occupiedBox` counts it. */
function mountedSixths(heightSixths: number, choice: SlotChoice, device: Device): number {
  const deviceH = orientedDims(device.dims, choice.orientation).h
  const topMm = choice.slot.layout.yMm + deviceH + SHELF_HEADROOM_MM
  return Math.max(heightSixths, mmToSixthsCeil(topMm))
}

/** Items made for other frames only (`compat.frames` without this one) are left out. */
function compatibleWith(item: Item, frame: Frame): boolean {
  const frames = item.compat?.frames ?? []
  return frames.length === 0 || frames.includes(frame.id)
}

interface RankedSuggestion extends MountSuggestion {
  name: string
}

function bySuggestionRank(a: RankedSuggestion, b: RankedSuggestion): number {
  return (
    Number(b.frameSpecific) - Number(a.frameSpecific) ||
    a.heightSixths - b.heightSixths ||
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }) ||
    (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0)
  )
}

/**
 * Catalog mounts (`kind: 'item'`) with a slot that accepts and fits the device (`fitDeviceInSlot`,
 * the first such slot each), best first: made for this frame, then the least rack space, then by
 * name. Items whose `compat.frames` leaves this frame out are skipped. Pass a lookup that includes
 * the plan's own entries to suggest the user's custom mounts too.
 */
export function mountSuggestions(
  device: Device,
  catalog: CatalogLookup,
  frame: Frame,
  limit: number = DEFAULT_MOUNT_SUGGESTIONS,
): MountSuggestion[] {
  const max = Math.floor(limit)
  if (!(max > 0)) return []
  const ranked: RankedSuggestion[] = []
  for (const item of catalog.allItems()) {
    if (item.kind !== 'item' || !compatibleWith(item, frame)) continue
    const choice = slotForDevice(item.slots, device)
    if (choice === undefined) continue
    ranked.push({
      itemId: item.id,
      slotId: choice.slot.id,
      heightSixths: mountedSixths(item.heightSixths, choice, device),
      frameSpecific: (item.compat?.frames ?? []).includes(frame.id),
      name: item.name,
    })
  }
  return ranked
    .toSorted(bySuggestionRank)
    .slice(0, max)
    .map(({ itemId, slotId, heightSixths, frameSpecific }) => ({
      itemId,
      slotId,
      heightSixths,
      frameSpecific,
    }))
}

export interface DeviceUEstimate {
  sixths: number
  via: 'rackmount' | 'mount' | 'estimate'
  itemId?: string
}

/** Whole U that hold `heightMm` plus `ESTIMATE_CLEARANCE_MM`, in sixths (at least 1U). */
export function estimateSixthsFromHeight(heightMm: number): number {
  const units = Math.ceil((heightMm + ESTIMATE_CLEARANCE_MM) / U_MM - EPSILON)
  return Math.max(1, units) * SIXTHS_PER_U
}

/**
 * Rack space a device needs:
 * - ear-mounted gear: its own `rackmount.heightSixths` (via 'rackmount');
 * - else the best mount suggestion's height (via 'mount', with its `itemId`);
 * - else an estimate: the whole U that hold the device's height + 6 mm (via 'estimate').
 */
export function estimateDeviceSixths(
  device: Device,
  catalog: CatalogLookup,
  frame: Frame,
): DeviceUEstimate {
  if (device.rackmount !== undefined) {
    return { sixths: device.rackmount.heightSixths, via: 'rackmount' }
  }
  const best = mountSuggestions(device, catalog, frame, 1)[0]
  if (best !== undefined) return { sixths: best.heightSixths, via: 'mount', itemId: best.itemId }
  return { sixths: estimateSixthsFromHeight(device.dims.h), via: 'estimate' }
}

export interface EquipmentUSummary {
  rackSixths: number
  usedSixths: number
  freeSixths: number
  /** Space the unplaced equipment needs (sum of estimates). */
  neededSixths: number
  /** max(0, needed - free), rounded up to the frame's section steps when possible. */
  shortfallSixths: number
  perDevice: Array<{ equipmentId: string; deviceId: string } & DeviceUEstimate>
}

/**
 * The tray's "Needs ~5U · rack 9U → +3U" numbers:
 * - rackSixths: the whole stack, planned sections included;
 * - usedSixths: sixths within the stack where something holds the front rail (front-face
 *   placements and items also screwed to the front rail), merged; shelves count up to their
 *   tallest device (`occupiedBox`). Free space is not checked for fragmentation.
 * - neededSixths: the sum of `estimateDeviceSixths` over the tray (unknown devices are skipped);
 * - shortfallSixths: max(0, needed − free) rounded up to whole U, then to the smallest height the
 *   frame's section types add up to (KWS: 3U and 6U sections, so multiples of 3U); whole U when no
 *   combination works. It is not capped by `stack.maxU`: compare against it before growing.
 */
export function equipmentUSummary(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
): EquipmentUSummary {
  const lookup = withCustomEntries(catalog, plan.custom)
  const rackSixths = totalHeightSixths(plan, frame)
  const usedSixths = frontUsedSixths(plan, lookup, frame, rackSixths)
  const freeSixths = Math.max(0, rackSixths - usedSixths)
  const estimates = new Map<string, DeviceUEstimate>()
  const perDevice: EquipmentUSummary['perDevice'] = []
  for (const entry of plan.equipment) {
    const device = lookup.device(entry.deviceId)
    if (device === undefined) continue
    let estimate = estimates.get(device.id)
    if (estimate === undefined) {
      estimate = estimateDeviceSixths(device, lookup, frame)
      estimates.set(device.id, estimate)
    }
    perDevice.push({ equipmentId: entry.id, deviceId: entry.deviceId, ...estimate })
  }
  const neededSixths = perDevice.reduce((total, estimate) => total + estimate.sixths, 0)
  return {
    rackSixths,
    usedSixths,
    freeSixths,
    neededSixths,
    shortfallSixths: shortfallInSections(neededSixths - freeSixths, frame.sectionTypes),
    perDevice,
  }
}

function frontUsedSixths(
  plan: Plan,
  lookup: CatalogLookup,
  frame: Frame,
  rackSixths: number,
): number {
  const ranges: Array<[number, number]> = []
  for (const placement of plan.placements) {
    const box = occupiedBox(plan, lookup, placement, frame)
    if (box.claimsFrontColumns) ranges.push([box.y0, box.y1])
  }
  return mergedLength(ranges, rackSixths)
}

/** Total length of the union of [start, end) ranges, clipped to [0, top). */
function mergedLength(ranges: ReadonlyArray<[number, number]>, top: number): number {
  const clipped = ranges
    .map(([start, end]): [number, number] => [Math.max(0, start), Math.min(top, end)])
    .filter(([start, end]) => end > start)
    .toSorted((a, b) => a[0] - b[0])
  let total = 0
  let runEnd = Number.NEGATIVE_INFINITY
  for (const [start, end] of clipped) {
    if (end <= runEnd) continue
    total += end - Math.max(start, runEnd)
    runEnd = end
  }
  return total
}

function shortfallInSections(missingSixths: number, sectionTypes: readonly SectionType[]): number {
  if (!(missingSixths > 0)) return 0
  const wholeU = Math.ceil(missingSixths / SIXTHS_PER_U - EPSILON)
  return (smallestStackU(wholeU, sectionTypes) ?? wholeU) * SIXTHS_PER_U
}

/** Tallest height `smallestStackU` searches up to; beyond it callers fall back to whole U. */
export const MAX_STACK_SEARCH_U = 1000

/**
 * The smallest height of at least `minU` that sections of these types add up to (fixed heights,
 * and every height in a range type's min..max), or undefined when none can, or when the search
 * would go past `MAX_STACK_SEARCH_U`.
 */
export function smallestStackU(
  minU: number,
  sectionTypes: readonly SectionType[],
): number | undefined {
  if (!Number.isFinite(minU)) return undefined
  const target = Math.max(0, Math.ceil(minU))
  if (target === 0) return 0
  const fixed: number[] = []
  const ranges: Array<[number, number]> = []
  for (const type of sectionTypes) {
    if (typeof type.heightU === 'number') {
      if (type.heightU > 0) fixed.push(type.heightU)
      continue
    }
    const min = Math.max(1, type.heightU.min)
    if (min <= type.heightU.max) ranges.push([min, type.heightU.max])
  }
  const smallest = Math.min(...fixed, ...ranges.map(([min]) => min))
  if (!Number.isFinite(smallest)) return undefined
  // With r the tallest reachable height below the target, r + the smallest section is reachable
  // and at least the target: the answer is at most target - 1 + smallest.
  const limit = target - 1 + smallest
  if (limit > MAX_STACK_SEARCH_U) return undefined
  const steps = new Set(fixed.filter((u) => u <= limit))
  for (const [min, max] of ranges) {
    for (let u = min; u <= Math.min(max, limit); u++) steps.add(u)
  }
  const stepList = [...steps]
  const reachable: boolean[] = [true]
  for (let u = 1; u <= limit; u++) {
    reachable[u] = stepList.some((step) => step <= u && reachable[u - step] === true)
    if (u >= target && reachable[u]) return u
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------
// The tray

function isPlanId(id: string): boolean {
  return id.length <= MAX_ID_LENGTH && ID_PATTERN.test(id)
}

/** Adds a device to "Equipment to fit" (owned or to get). A malformed id leaves the plan as it is. */
export function addEquipment(plan: Plan, deviceId: string, have: boolean): Plan {
  if (!isPlanId(deviceId)) return plan
  const entry = { id: newId(ID_PREFIX.equipment), deviceId, have }
  return { ...plan, equipment: [...plan.equipment, entry] }
}

/** Removes a tray entry (owned or not: the user asked for it). Unknown ids return the same plan. */
export function removeEquipment(plan: Plan, equipmentId: string): Plan {
  if (!plan.equipment.some((entry) => entry.id === equipmentId)) return plan
  return { ...plan, equipment: plan.equipment.filter((entry) => entry.id !== equipmentId) }
}

// ---------------------------------------------------------------------------------------------
// Devices in a placement's slots

function slotName(slot: Slot): string {
  return slot.label ?? `slot "${slot.id}"`
}

function formatMm(value: number): string {
  return `${Math.round(value * 10) / 10} mm`
}

/** Narrowest width the device takes in any allowed orientation that fits the slot's depth/height. */
function narrowestWidthMm(device: Device, slot: Slot): number | undefined {
  const widths = slot.orientations
    .map((orientation) => orientedDims(device.dims, orientation))
    .filter((size) => fitsSlot(size, slot, Number.POSITIVE_INFINITY))
    .map((size) => size.w)
  return widths.length === 0 ? undefined : Math.min(...widths)
}

/** Width left at the right of packed devices (one gap after the last one). */
function freeWidthMm(packed: PackResult, slot: Slot, lookup: CatalogLookup): number {
  let usedMm = 0
  for (const position of packed.positions) {
    const device = lookup.device(position.deviceId)
    if (device === undefined) continue
    const right = position.xMm + orientedDims(device.dims, position.orientation).w
    usedMm = Math.max(usedMm, right + DEVICE_GAP_MM)
  }
  return Math.max(0, slot.maxW - usedMm)
}

/**
 * The placement with `entry` added to `slotId`, or a user-facing reason it cannot be:
 * - the placement's item must have the slot, and the slot must accept and fit the device in one
 *   of its orientations (`fitDeviceInSlot`);
 * - a fixed slot holds one device;
 * - an area slot re-packs left to right (`packAreaSlot`, devices in plan order with the new one
 *   last; stored orientations are kept) and every device in it gets `xMm` and `orientation`.
 */
function withDeviceInSlot(
  lookup: CatalogLookup,
  placement: Placement,
  slotId: string,
  device: Device,
  entry: PlacedDevice,
): Placement | string {
  const holder = placementName(placement, lookup)
  const item = lookup.item(placement.itemId)
  if (item === undefined || item.kind !== 'item' || item.slots.length === 0) {
    return `${holder} has no slots for devices.`
  }
  const slot = item.slots.find((candidate) => candidate.id === slotId)
  if (slot === undefined) return `${holder} has no slot "${slotId}".`
  const fit = fitDeviceInSlot(device, slot)
  if (!fit.ok || fit.orientation === undefined) {
    return fit.reason ?? `The ${deviceName(device)} does not fit ${slotName(slot)}.`
  }
  const inSlot = placement.devices.filter((placed) => placed.slotId === slot.id)
  if (slot.kind === 'fixed') {
    const occupant = inSlot[0]
    if (occupant !== undefined) {
      const other = lookup.device(occupant.deviceId)
      const what = other === undefined ? `"${occupant.deviceId}"` : `the ${deviceName(other)}`
      return `${slotName(slot)} of ${holder} already holds ${what}; it takes one device.`
    }
    const added: PlacedDevice = { ...entry, slotId: slot.id, orientation: fit.orientation }
    return { ...placement, devices: [...placement.devices, added] }
  }
  return packedInto(lookup, placement, slot, inSlot, device, entry, holder)
}

function packedInto(
  lookup: CatalogLookup,
  placement: Placement,
  slot: Slot,
  inSlot: readonly PlacedDevice[],
  device: Device,
  entry: PlacedDevice,
  holder: string,
): Placement | string {
  const items: PackItem[] = []
  for (const placed of inSlot) {
    const other = lookup.device(placed.deviceId)
    // Unknown devices cannot be measured: they keep their spot and are left out of the packing.
    if (other === undefined) continue
    items.push({
      id: placed.id,
      device: other,
      ...(placed.orientation === undefined ? {} : { orientation: placed.orientation }),
    })
  }
  const before = packAreaSlot(items, slot)
  const packed = packAreaSlot([...items, { id: entry.id, device }], slot)
  if (packed.overflowIds.includes(entry.id)) {
    const needs = narrowestWidthMm(device, slot)
    const free = freeWidthMm(before, slot, lookup)
    const need = needs === undefined ? '' : ` (it needs ${formatMm(needs)})`
    return `No room left in ${slotName(slot)} of ${holder} for the ${deviceName(device)}: ${formatMm(free)} of ${formatMm(slot.maxW)} is free${need}.`
  }
  if (!packed.ok) {
    const names = packed.overflowIds.map((id) => {
      const placed = inSlot.find((candidate) => candidate.id === id)
      const other = placed === undefined ? undefined : lookup.device(placed.deviceId)
      return other === undefined ? (placed?.deviceId ?? id) : deviceName(other)
    })
    return `${slotName(slot)} of ${holder} is already over-full (${names.join(', ')} ${names.length === 1 ? 'does' : 'do'} not fit), so nothing more can go in.`
  }
  const positions = new Map(packed.positions.map((position) => [position.id, position]))
  const devices = placement.devices.map((placed) => {
    const position = positions.get(placed.id)
    return position === undefined
      ? placed
      : { ...placed, xMm: position.xMm, orientation: position.orientation }
  })
  const own = positions.get(entry.id)
  const added: PlacedDevice = {
    ...entry,
    slotId: slot.id,
    ...(own === undefined ? {} : { xMm: own.xMm, orientation: own.orientation }),
  }
  return { ...placement, devices: [...devices, added] }
}

/**
 * Puts a catalog device into a placement's slot (fit-checked; area slots auto-pack, see
 * `withDeviceInSlot`). The new device entry is owned when `have` is true. On failure the plan is
 * unchanged and `error` says why in plain language.
 */
export function assignDevice(
  plan: Plan,
  catalog: CatalogLookup,
  placementId: string,
  slotId: string,
  deviceId: string,
  have: boolean,
): DeviceOpResult {
  const lookup = withCustomEntries(catalog, plan.custom)
  const index = plan.placements.findIndex((placement) => placement.id === placementId)
  const placement = plan.placements[index]
  if (placement === undefined) return failed(plan, `There is no placement "${placementId}" here.`)
  const device = lookup.device(deviceId)
  if (device === undefined) return failed(plan, `"${deviceId}" is not in the catalog.`)
  const entry: PlacedDevice = { id: newId(ID_PREFIX.placedDevice), deviceId, slotId, have }
  const updated = withDeviceInSlot(lookup, placement, slotId, device, entry)
  if (typeof updated === 'string') return failed(plan, updated)
  return {
    plan: { ...plan, placements: plan.placements.with(index, updated) },
    conflicts: [],
    placementId,
    deviceEntryId: entry.id,
  }
}

/**
 * Moves a tray device into an existing placement's slot (as `assignDevice`), keeping its Have
 * flag, and removes it from "Equipment to fit".
 */
export function assignEquipment(
  plan: Plan,
  catalog: CatalogLookup,
  placementId: string,
  slotId: string,
  equipmentId: string,
): DeviceOpResult {
  const entry = plan.equipment.find((candidate) => candidate.id === equipmentId)
  if (entry === undefined) return failed(plan, `There is no "${equipmentId}" in Equipment to fit.`)
  const result = assignDevice(plan, catalog, placementId, slotId, entry.deviceId, entry.have)
  if (result.error !== undefined) return result
  return { ...result, plan: removeEquipment(result.plan, equipmentId) }
}

export interface RemoveDeviceOptions {
  /**
   * Put the device back in "Equipment to fit" (keeping its Have flag) instead of dropping it.
   * Default: owned devices go to the tray (nothing the user owns silently disappears), planned
   * ones are dropped.
   */
  toTray?: boolean
}

/**
 * Takes a device out of its placement. Devices left in an area slot keep their positions. Unknown
 * ids return the same plan.
 */
export function removeDevice(
  plan: Plan,
  placementId: string,
  deviceEntryId: string,
  options: RemoveDeviceOptions = {},
): Plan {
  const index = plan.placements.findIndex((placement) => placement.id === placementId)
  const placement = plan.placements[index]
  const device = placement?.devices.find((candidate) => candidate.id === deviceEntryId)
  if (placement === undefined || device === undefined) return plan
  const devices = placement.devices.filter((candidate) => candidate.id !== deviceEntryId)
  const next: Plan = { ...plan, placements: plan.placements.with(index, { ...placement, devices }) }
  if (!(options.toTray ?? device.have)) return next
  const entry = { id: newId(ID_PREFIX.equipment), deviceId: device.deviceId, have: device.have }
  return { ...next, equipment: [...next.equipment, entry] }
}

// ---------------------------------------------------------------------------------------------
// Placing a tray device

export interface PlaceEquipmentOptions {
  /** Have snapshot time when an owned ear-mounted device becomes a placement; default now. */
  at?: string
  /**
   * Only this bay (checked like the rest of the spot). Default: full width, or for half-width
   * items the left bay, then the right.
   */
  bay?: PlacementBay
}

/** "U3", or "U3 + ½U" for a start inside a U. */
function positionLabel(y: number): string {
  const phase = phaseOf(y)
  return `U${uNumberAt(y)}${phase === 0 ? '' : ` + ${formatU(phase)}`}`
}

function baysFor(bay: Item['bay']): PlacementBay[] {
  return bay === 'half' ? ['left', 'right'] : ['full']
}

function blockedMessage(name: string, y: number, face: Face, reasons: readonly PlaceReason[]) {
  const why = reasons.map((reason) => reason.message).join(' ')
  return `${name} cannot go at ${positionLabel(y)} on the ${face}. ${why}`.trim()
}

/**
 * Creates a placement of `itemId` at `y` on `face` that holds the tray device `equipmentId`, and
 * removes that device from the tray:
 * - the device goes into the item's first slot that accepts and fits it (`slotForDevice`);
 * - the spot is checked with `canPlace` (device included, so a shelf's height counts); half-width
 *   items try the left bay, then the right, unless `options.bay` names one;
 * - the device keeps its Have flag; the new mount itself is planned (Need), as `addPlacement`
 *   makes it.
 * `itemId` may also be the tray device's own id when it is ear-mounted gear (`device.rackmount`):
 * the device then becomes the placement (owned devices get a Have snapshot stamped `options.at`).
 * Errors (`error`, plan unchanged) carry every reason in plain language.
 */
export function placeEquipmentOnMount(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  equipmentId: string,
  itemId: string,
  y: number,
  face: Face,
  options: PlaceEquipmentOptions = {},
): DeviceOpResult {
  const lookup = withCustomEntries(catalog, plan.custom)
  const entry = plan.equipment.find((candidate) => candidate.id === equipmentId)
  if (entry === undefined) return failed(plan, `There is no "${equipmentId}" in Equipment to fit.`)
  const device = lookup.device(entry.deviceId)
  if (device === undefined) {
    return failed(plan, `"${entry.deviceId}" is not in the catalog, so it cannot be placed.`)
  }
  const placeable = resolvePlaceable(lookup, itemId)
  if (placeable === undefined) return failed(plan, `"${itemId}" is not a mount in the catalog.`)
  const name = deviceName(device)
  const bays = options.bay === undefined ? baysFor(placeable.bay) : [options.bay]

  if (placeable.source === 'rackmount') {
    if (placeable.id !== device.id) {
      return failed(plan, `${placeable.name} has no slots, so the ${name} cannot go in it.`)
    }
    const spot = firstOpenBay(plan, lookup, frame, itemId, y, face, bays, [])
    if (!('bay' in spot)) {
      return failed(plan, blockedMessage(placeable.name, y, face, spot.reasons))
    }
    const added = addPlacement(plan, lookup, { itemId, y, face, bay: spot.bay })
    if (added.placementId === undefined) return failed(plan, `"${itemId}" cannot be placed.`)
    const placementId = added.placementId
    const placed = entry.have
      ? mapPlacement(added.plan, placementId, (placement) => ({
          ...placement,
          have: { at: options.at ?? new Date().toISOString(), itemId, options: {} },
        }))
      : added.plan
    return { plan: removeEquipment(placed, equipmentId), conflicts: [], placementId }
  }

  if (placeable.slots.length === 0) {
    return failed(
      plan,
      `${placeable.name} has no slots for devices, so the ${name} cannot go in it.`,
    )
  }
  const choice = slotForDevice(placeable.slots, device)
  if (choice === undefined) {
    const reasons = placeable.slots.map((slot) => fitDeviceInSlot(device, slot).reason)
    const why = reasons.find((reason) => reason !== undefined) ?? ''
    return failed(plan, `The ${name} does not fit ${placeable.name}. ${why}`.trim())
  }
  const deviceEntry: PlacedDevice = {
    id: newId(ID_PREFIX.placedDevice),
    deviceId: device.id,
    slotId: choice.slot.id,
    ...(choice.slot.kind === 'area' ? { xMm: 0 } : {}),
    orientation: choice.orientation,
    have: entry.have,
  }
  const spot = firstOpenBay(plan, lookup, frame, itemId, y, face, bays, [deviceEntry])
  if (!('bay' in spot)) {
    return failed(plan, blockedMessage(placeable.name, y, face, spot.reasons))
  }
  const added = addPlacement(plan, lookup, { itemId, y, face, bay: spot.bay })
  if (added.placementId === undefined) return failed(plan, `"${itemId}" cannot be placed.`)
  const placementId = added.placementId
  const withDevice = mapPlacement(added.plan, placementId, (placement) => ({
    ...placement,
    devices: [...placement.devices, deviceEntry],
  }))
  return {
    plan: removeEquipment(withDevice, equipmentId),
    conflicts: [],
    placementId,
    deviceEntryId: deviceEntry.id,
  }
}

/** The first of `bays` where `canPlace` passes, else the reasons the first bay failed. */
function firstOpenBay(
  plan: Plan,
  lookup: CatalogLookup,
  frame: Frame,
  itemId: string,
  y: number,
  face: Face,
  bays: readonly PlacementBay[],
  devices: readonly PlacedDevice[],
): { bay: PlacementBay } | { reasons: PlaceReason[] } {
  let firstReasons: PlaceReason[] | undefined
  for (const candidateBay of bays) {
    const check = canPlace(plan, lookup, frame, { itemId, y, face, bay: candidateBay, devices })
    if (check.ok) return { bay: candidateBay }
    firstReasons ??= check.reasons
  }
  return { reasons: firstReasons ?? [] }
}

function mapPlacement(
  plan: Plan,
  placementId: string,
  update: (placement: Placement) => Placement,
): Plan {
  return {
    ...plan,
    placements: plan.placements.map((placement) =>
      placement.id === placementId ? update(placement) : placement,
    ),
  }
}
