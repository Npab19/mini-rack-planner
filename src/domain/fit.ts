/**
 * "Fit it for me" (M3b): make room for the Equipment-to-fit tray and place it, as one undoable
 * step, plus the spot search the mount chooser shares with it.
 *
 * - `fitItForMe`: every tray device goes on its best mount (or itself when ear-mounted), largest
 *   first, at the lowest free spot. When the free space is not enough, planned sections are added
 *   at one end: the smallest growth that lets the most devices in, never past `stack.maxU` and
 *   never touching sections the user has (`setHeight` rebuilds only the planned run at that end).
 * - `findDeviceSpot` / `checkDeviceAt`: where a mount holding a device (or ear-mounted gear) can
 *   go, checked with the device in it, as `placeEquipmentOnMount` checks it (a shelf counts up to
 *   the device's top, a deep device reaches further back).
 *
 * Pure: inputs are never mutated.
 */
import type { StackOpResult } from './api'
import { mountSuggestions, placeEquipmentOnMount, slotForDevice } from './devices'
import {
  remap,
  sectionSpans,
  setHeight,
  totalHeightSixths,
  totalHeightU,
  type StackEnd,
} from './frame'
import { formatU, SIXTHS_PER_U } from './geometry'
import {
  allowedPhases,
  boxesOverlap,
  canPlace,
  occupiedBox,
  resolvePlaceable,
  snapY,
  type OccupiedBox,
  type Placeable,
} from './placement'
import {
  deviceName,
  withCustomEntries,
  type CatalogLookup,
  type Device,
  type Frame,
} from './schema/catalog'
import type { Face } from './schema/common'
import type { PlacedDevice, Placement, PlacementBay, Plan, PlanEquipment } from './schema/plan'

export interface FitItForMeResult extends StackOpResult {
  /** Tray entries that got a place, with the placement holding them. */
  placed: Array<{ equipmentId: string; placementId: string }>
  /** Tray entries that still have no place (no fitting mount, or the frame's max height). */
  unplaced: Array<{ equipmentId: string; reason: string }>
  /** U added to the stack (0 when everything fit in free space). */
  addedU: number
}

// ---------------------------------------------------------------------------------------------
// Spots for a device

/** Where a new placement goes. */
export interface DeviceSpot {
  y: number
  face: Face
  bay: PlacementBay
}

/** Id of the stand-in placement and device entry used for checks (never stored). */
const PREVIEW_ID = 'fit-preview'

/**
 * The device as it would sit in a new placement of `itemId`, as `placeEquipmentOnMount` puts it:
 * in the mount's first slot that takes it (`slotForDevice`), or nothing for the device's own
 * ear-mounted placement. Undefined when the item is unknown, has no slot for the device, or is
 * another device's ear-mounted gear. Pass a lookup that includes the plan's own entries.
 */
export function mountedDevicePreview(
  catalog: CatalogLookup,
  itemId: string,
  device: Device,
  have = false,
): PlacedDevice[] | undefined {
  const placeable = resolvePlaceable(catalog, itemId)
  if (placeable === undefined) return undefined
  if (placeable.source === 'rackmount') return placeable.id === device.id ? [] : undefined
  const choice = slotForDevice(placeable.slots, device)
  if (choice === undefined) return undefined
  return [
    {
      id: PREVIEW_ID,
      deviceId: device.id,
      slotId: choice.slot.id,
      ...(choice.slot.kind === 'area' ? { xMm: 0 } : {}),
      orientation: choice.orientation,
      have,
    },
  ]
}

export interface DeviceSpotOptions {
  /** Only this face (default: each face the mount allows, in its order). */
  face?: Face
  /** Only this bay (default: full width, or left then right for half-width mounts). */
  bay?: PlacementBay
  /** The free spot nearest to this start (sixths; ties go to the lower one) instead of the lowest. */
  near?: number
}

/** A plan's stack top and placed boxes, computed once for many candidate spots. */
interface SpotContext {
  plan: Plan
  lookup: CatalogLookup
  frame: Frame
  topSixths: number
  boxes: OccupiedBox[]
}

function spotContext(plan: Plan, catalog: CatalogLookup, frame: Frame): SpotContext {
  const lookup = withCustomEntries(catalog, plan.custom)
  return {
    plan,
    lookup,
    frame,
    topSixths: totalHeightSixths(plan, frame),
    boxes: plan.placements.map((placement) => occupiedBox(plan, lookup, placement, frame)),
  }
}

function baysFor(placeable: Placeable): PlacementBay[] {
  return placeable.bay === 'half' ? ['left', 'right'] : ['full']
}

/** Every start inside the stack at an allowed phase, bottom to top. */
function startPositions(phases: readonly number[], heightSixths: number, top: number): number[] {
  const ys: number[] = []
  for (let base = 0; base < top; base += SIXTHS_PER_U) {
    for (const phase of phases) {
      const y = base + phase
      if (y + heightSixths <= top) ys.push(y)
    }
  }
  return ys
}

/**
 * Whether a spot passes `canPlace` with the devices in the new placement. A quick test against
 * the boxes already placed skips most taken spots before the full check runs.
 */
function spotFits(
  ctx: SpotContext,
  itemId: string,
  spot: DeviceSpot,
  devices: readonly PlacedDevice[],
): boolean {
  const preview: Placement = { id: PREVIEW_ID, itemId, ...spot, devices: [...devices] }
  const box = occupiedBox(ctx.plan, ctx.lookup, preview, ctx.frame)
  if (box.y0 < 0 || box.y1 > ctx.topSixths) return false
  if (ctx.boxes.some((other) => boxesOverlap(box, other))) return false
  return canPlace(ctx.plan, ctx.lookup, ctx.frame, { itemId, ...spot, devices }).ok
}

function findSpotIn(
  ctx: SpotContext,
  placeable: Placeable,
  devices: readonly PlacedDevice[],
  options: DeviceSpotOptions,
): DeviceSpot | null {
  const { phases } = allowedPhases(placeable, ctx.frame)
  const upward = startPositions(phases, placeable.heightSixths, ctx.topSixths)
  const near = options.near
  const ys =
    near === undefined
      ? upward
      : upward.toSorted((a, b) => Math.abs(a - near) - Math.abs(b - near) || a - b)
  const faces = options.face === undefined ? placeable.faces : [options.face]
  const bays = options.bay === undefined ? baysFor(placeable) : [options.bay]
  for (const face of faces) {
    for (const y of ys) {
      for (const bay of bays) {
        const spot = { y, face, bay }
        if (spotFits(ctx, placeable.id, spot, devices)) return spot
      }
    }
  }
  return null
}

/**
 * Where a new placement of `itemId` holding `device` can go (a mount with the device in its
 * first fitting slot, or the device itself when `itemId` is its ear-mounted gear), checked with
 * the device in it. The lowest free spot (faces in the mount's order, left before right), or the
 * one nearest to `options.near`. Null when there is none, or when the mount cannot hold it.
 */
export function findDeviceSpot(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  itemId: string,
  device: Device,
  options: DeviceSpotOptions = {},
): DeviceSpot | null {
  const ctx = spotContext(plan, catalog, frame)
  const placeable = resolvePlaceable(ctx.lookup, itemId)
  const devices = mountedDevicePreview(ctx.lookup, itemId, device)
  if (placeable === undefined || devices === undefined) return null
  return findSpotIn(ctx, placeable, devices, options)
}

export interface DeviceSpotCheck {
  /** The requested start snapped to a start the mount's holes allow. */
  y: number
  /** The spot there (with the bay that fits), or null when it is blocked. */
  spot: DeviceSpot | null
  /** Why it cannot go there, in plain language (empty when it can). */
  reasons: string[]
}

/**
 * Whether a new placement of `itemId` holding `device` fits with its bottom at `y` on `face`
 * (snapped to a start its holes allow; half-width mounts try the left bay, then the right).
 */
export function checkDeviceAt(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  itemId: string,
  device: Device,
  y: number,
  face: Face,
): DeviceSpotCheck {
  const lookup = withCustomEntries(catalog, plan.custom)
  const placeable = resolvePlaceable(lookup, itemId)
  if (placeable === undefined) {
    return { y, spot: null, reasons: [`"${itemId}" is not a mount in the catalog.`] }
  }
  const devices = mountedDevicePreview(lookup, itemId, device)
  if (devices === undefined) {
    return {
      y,
      spot: null,
      reasons: [`The ${deviceName(device)} does not go in ${placeable.name}.`],
    }
  }
  const snapped = snapY(y, allowedPhases(placeable, frame).phases)
  let firstReasons: string[] | undefined
  for (const bay of baysFor(placeable)) {
    const check = canPlace(plan, lookup, frame, { itemId, y: snapped, face, bay, devices })
    if (check.ok) return { y: snapped, spot: { y: snapped, face, bay }, reasons: [] }
    firstReasons ??= check.reasons.map((reason) => reason.message)
  }
  return { y: snapped, spot: null, reasons: firstReasons ?? [] }
}

// ---------------------------------------------------------------------------------------------
// Fit it for me

interface FitOption {
  itemId: string
  name: string
  heightSixths: number
}

/** A tray device waiting for a place, with the mounts to try, best first. */
interface FitJob {
  entry: PlanEquipment
  /** Position in the tray, so results come back in tray order. */
  index: number
  device: Device
  options: FitOption[]
}

interface Skipped {
  equipmentId: string
  index: number
  reason: string
}

/**
 * What can be fitted: known devices with their own ears or at least one catalog mount
 * (`mountSuggestions`, best first), largest first (the best option's height), then in tray order.
 */
function fitJobs(
  plan: Plan,
  lookup: CatalogLookup,
  frame: Frame,
): { jobs: FitJob[]; skipped: Skipped[] } {
  const jobs: FitJob[] = []
  const skipped: Skipped[] = []
  for (const [index, entry] of plan.equipment.entries()) {
    const device = lookup.device(entry.deviceId)
    if (device === undefined) {
      const reason = `"${entry.deviceId}" is not in the catalog, so its size is unknown.`
      skipped.push({ equipmentId: entry.id, index, reason })
      continue
    }
    const options: FitOption[] =
      device.rackmount === undefined
        ? mountSuggestions(device, lookup, frame).map((suggestion) => ({
            itemId: suggestion.itemId,
            name: lookup.item(suggestion.itemId)?.name ?? suggestion.itemId,
            heightSixths: suggestion.heightSixths,
          }))
        : [
            {
              itemId: device.id,
              name: deviceName(device),
              heightSixths: device.rackmount.heightSixths,
            },
          ]
    if (options.length === 0) {
      const reason = `No mount in the catalog takes the ${deviceName(device)} yet.`
      skipped.push({ equipmentId: entry.id, index, reason })
      continue
    }
    jobs.push({ entry, index, device, options })
  }
  const largestFirst = jobs.toSorted(
    (a, b) =>
      (b.options[0]?.heightSixths ?? 0) - (a.options[0]?.heightSixths ?? 0) || a.index - b.index,
  )
  return { jobs: largestFirst, skipped }
}

interface Attempt {
  plan: Plan
  heightU: number
  placed: Array<{ equipmentId: string; placementId: string; index: number }>
  /** Jobs that found no free spot on any of their mounts. */
  noRoom: FitJob[]
}

/** The first of the job's mounts that has a free spot, placed there with the device in it. */
function placeJob(
  plan: Plan,
  lookup: CatalogLookup,
  frame: Frame,
  job: FitJob,
  at: string,
): { plan: Plan; placementId: string } | undefined {
  const ctx = spotContext(plan, lookup, frame)
  for (const option of job.options) {
    const placeable = resolvePlaceable(ctx.lookup, option.itemId)
    const devices = mountedDevicePreview(ctx.lookup, option.itemId, job.device, job.entry.have)
    if (placeable === undefined || devices === undefined) continue
    const spot = findSpotIn(ctx, placeable, devices, {})
    if (spot === null) continue
    const result = placeEquipmentOnMount(
      plan,
      lookup,
      frame,
      job.entry.id,
      option.itemId,
      spot.y,
      spot.face,
      { bay: spot.bay, at },
    )
    if (result.error === undefined && result.placementId !== undefined) {
      return { plan: result.plan, placementId: result.placementId }
    }
  }
  return undefined
}

function placeJobs(
  start: Plan,
  lookup: CatalogLookup,
  frame: Frame,
  jobs: readonly FitJob[],
  heightU: number,
  at: string,
): Attempt {
  let plan = start
  const placed: Attempt['placed'] = []
  const noRoom: FitJob[] = []
  for (const job of jobs) {
    const result = placeJob(plan, lookup, frame, job, at)
    if (result === undefined) {
      noRoom.push(job)
      continue
    }
    plan = result.plan
    placed.push({ equipmentId: job.entry.id, placementId: result.placementId, index: job.index })
  }
  return { plan, heightU, placed, noRoom }
}

/**
 * The stack grown to `targetU` at one end: `setHeight` (fixed-height section types), else, on
 * frames whose sections have a height range (plain rails), the planned end section made taller,
 * with the new space at that end.
 */
function growTo(
  plan: Plan,
  frame: Frame,
  lookup: CatalogLookup,
  targetU: number,
  at: StackEnd,
): StackOpResult {
  const result = setHeight(plan, frame, targetU, at, { catalog: lookup })
  if (result.error === undefined) return result
  return growRangeSection(plan, frame, lookup, targetU, at) ?? result
}

function growRangeSection(
  plan: Plan,
  frame: Frame,
  lookup: CatalogLookup,
  targetU: number,
  at: StackEnd,
): StackOpResult | undefined {
  if (targetU > frame.stack.maxU) return undefined
  const spans = sectionSpans(plan, frame)
  const span = at === 'top' ? spans.at(-1) : spans[0]
  if (span === undefined || span.have) return undefined
  const type = frame.sectionTypes.find((candidate) => candidate.id === span.typeId)
  if (type === undefined || typeof type.heightU === 'number') return undefined
  const heightU = span.heightU + targetU - totalHeightU(plan, frame)
  if (heightU < type.heightU.min || heightU > type.heightU.max) return undefined
  const sections = plan.frame.sections.map((section) =>
    section.id === span.sectionId ? { ...section, heightU } : section,
  )
  return remap(plan, sections, frame, {
    catalog: lookup,
    replacements: [
      { from: [span.sectionId], to: [span.sectionId], align: at === 'top' ? 'start' : 'end' },
    ],
  })
}

function byTrayOrder(a: { index: number }, b: { index: number }): number {
  return a.index - b.index
}

/** Why a device found no free spot, given how far the rack could grow. */
function noRoomReason(
  job: FitJob,
  frame: Frame,
  startU: number,
  tallestU: number,
  at: StackEnd,
): string {
  const best = job.options[0]
  const needs =
    best === undefined
      ? ''
      : ` (it needs ${formatU(best.heightSixths)}${job.device.rackmount === undefined ? ` on ${best.name}` : ''})`
  if (tallestU >= frame.stack.maxU) {
    return `There is no room for it${needs}, even at ${frame.stack.maxU}U, the tallest ${frame.name} stack.`
  }
  if (tallestU > startU) return `There is no room for it${needs}, even at ${tallestU}U.`
  const end = at === 'top' ? 'top' : 'bottom'
  return `There is no room for it${needs}, and the rack cannot grow at the ${end}.`
}

/**
 * Adds planned sections at `at` when the tray needs more space (never touching Have sections,
 * capped at the frame's max height), then places every tray device on its best mount (or itself
 * when ear-mounted) bottom-up from the free space. Pure; one result = one undo step.
 *
 * - Devices go largest first (their best mount's height, then tray order), each on the first of
 *   its mounts (`mountSuggestions`, frame-specific first) that has a free spot, at the lowest such
 *   spot, through `placeEquipmentOnMount`: devices keep their Have flag, new mounts are To get, and
 *   owned ear-mounted gear gets a Have snapshot stamped `nowIso`.
 * - Heights are tried from the current one up (each height `setHeight` can make at that end, or a
 *   taller planned end section on frames with a height range); the first that places the most
 *   devices wins, so the rack grows only as far as it helps, and not at all when the free space
 *   is enough. (The tray's "Needs ~10U" estimate counts a U per device; the search also finds
 *   half-width mounts sharing a U and space split by what is already placed.)
 * - Unknown devices, devices no catalog mount takes, and devices with no room even at the
 *   tallest height are `unplaced`, each with a plain-language reason. `placed` and `unplaced`
 *   follow tray order. An empty tray returns the same plan.
 */
export function fitItForMe(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  at: StackEnd,
  nowIso: string,
): FitItForMeResult {
  const lookup = withCustomEntries(catalog, plan.custom)
  const { jobs, skipped } = fitJobs(plan, lookup, frame)
  const startU = totalHeightU(plan, frame)
  let best = placeJobs(plan, lookup, frame, jobs, startU, nowIso)
  let tallestU = startU
  for (let heightU = startU + 1; best.noRoom.length > 0 && heightU <= frame.stack.maxU; heightU++) {
    const grown = growTo(plan, frame, lookup, heightU, at)
    if (grown.error !== undefined || grown.conflicts.length > 0) continue
    tallestU = heightU
    const attempt = placeJobs(grown.plan, lookup, frame, jobs, heightU, nowIso)
    if (attempt.placed.length > best.placed.length) best = attempt
  }
  const noRoom: Skipped[] = best.noRoom.map((job) => ({
    equipmentId: job.entry.id,
    index: job.index,
    reason: noRoomReason(job, frame, startU, tallestU, at),
  }))
  return {
    plan: best.plan,
    conflicts: [],
    placed: best.placed
      .toSorted(byTrayOrder)
      .map(({ equipmentId, placementId }) => ({ equipmentId, placementId })),
    unplaced: [...skipped, ...noRoom]
      .toSorted(byTrayOrder)
      .map(({ equipmentId, reason }) => ({ equipmentId, reason })),
    addedU: best.heightU - startU,
  }
}
