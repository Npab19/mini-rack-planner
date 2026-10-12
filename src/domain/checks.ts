/**
 * Plan checks for placements, their devices and printed parts.
 *
 * - Errors: overlap, out-of-rack, slot-fit (nothing fits, no room left), phase-invalid (holes
 *   miss the rails).
 * - Warnings: depth-overhang (rear open) / too-deep (rear closed), too-wide, clearance-mismatch,
 *   rear-support-missing, dead-zone, printer-bed, unknown-part, frame-mismatch, phase-invalid for
 *   items without hole data, and power-ac / power-poe / power-usbc (only when the plan's own power
 *   gear falls short).
 * - Info: unverified-holes, wide-guideline.
 *
 * Occupancy, hole phases and slot packing come from placement.ts, so the checks agree with what
 * the editor allows (`canPlace`). Stack problems (section types, heights, stack limits) come from
 * `validateStack` (frame.ts).
 */
import type { Issue, IssueSeverity, RunChecks } from './api'
import { placementLabel, resolvePlacedEntry, type PlacedEntry } from './bom'
import { stackJoints, totalHeightSixths } from './frame'
import { GEAR_WIDTH_GUIDE_MM, phaseOf, SIXTHS_PER_U, uNumberAt } from './geometry'
import {
  allowedPhases,
  boxesOverlap,
  fitsSlot,
  occupiedBox,
  orientedDims,
  packAreaSlot,
  resolvePlaceable,
  slotAccepts,
  type OccupiedBox,
  type PackItem,
} from './placement'
import { powerSummary } from './power'
import { effectiveFrameSize, expandFrameRecipe, frameConfigFromPlan } from './recipe'
import {
  deviceName,
  withCustomEntries,
  type CatalogLookup,
  type Device,
  type Frame,
  type Item,
  type Part3D,
  type Slot,
} from './schema/catalog'
import type { Dims, Orientation, Thread } from './schema/common'
import type { PlacedDevice, Placement, Plan } from './schema/plan'
import type { Settings } from './schema/settings'

const EPSILON = 1e-6

/** A rear-supported item counts as reaching the rear rails within this distance (mm). */
export const REAR_REACH_TOLERANCE_MM = 10

/** Nominal major diameters, to tell a too-small clearance hole from a loose one. */
const THREAD_DIAMETER_MM: Record<Thread, number> = {
  M3: 3,
  M4: 4,
  M5: 5,
  M6: 6,
  '10-32': 4.83,
  '12-24': 5.49,
}

const SEVERITY_ORDER: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 }

interface Context {
  plan: Plan
  catalog: CatalogLookup
  settings: Settings
  frame: Frame | undefined
  /** Frame depth after rack options such as 320 mm connectors. */
  depthMm: number | undefined
  innerWidthMm: number | undefined
  totalSixths: number
  issues: Issue[]
}

interface Placed {
  placement: Placement
  entry: PlacedEntry
  label: string
  /** The space it claims (placement.ts): a shelf reaches up to its tallest device. */
  box: OccupiedBox
  /** How far the item or its deepest device reaches from the mounting face (mm, no plugs). */
  depthMm: number
}

function report(
  ctx: Context,
  severity: IssueSeverity,
  code: string,
  message: string,
  targetId?: string,
): void {
  ctx.issues.push({ severity, code, message, ...(targetId === undefined ? {} : { targetId }) })
}

function mm(value: number): string {
  return `${Math.round(value * 10) / 10} mm`
}

// ---------------------------------------------------------------------------------------------
// Devices in slots

/**
 * The device's orientation in the slot: the stored one when the slot allows it and it fits, else
 * (nothing stored) the first allowed orientation that fits.
 */
export function slotOrientation(
  slot: Slot,
  device: Device,
  stored?: Orientation,
): Orientation | undefined {
  const candidates = stored === undefined ? slot.orientations : [stored]
  return candidates.find(
    (orientation) =>
      slot.orientations.includes(orientation) &&
      fitsSlot(orientedDims(device.dims, orientation), slot),
  )
}

function slotName(item: Item, slot: Slot): string {
  return `${item.name} slot "${slot.label ?? slot.id}"`
}

function slotOf(item: Item, slotId: string): Slot | undefined {
  return item.slots.find((slot) => slot.id === slotId)
}

function deviceReachMm(ctx: Context, item: Item, placed: PlacedDevice): number {
  const slot = slotOf(item, placed.slotId)
  const device = ctx.catalog.device(placed.deviceId)
  if (slot === undefined || device === undefined) return 0
  const orientation = slotOrientation(slot, device, placed.orientation) ?? placed.orientation
  // Slot z points toward the viewer from the rail face: a slot further forward reaches less deep.
  return orientedDims(device.dims, orientation ?? 'flat').d - slot.layout.zMm
}

function placedDepthMm(ctx: Context, placement: Placement, entry: PlacedEntry): number {
  if (entry.kind === 'device') return entry.rackmount.depthMm
  if (entry.kind === 'unknown') return 0
  const reaches = placement.devices.map((placed) => deviceReachMm(ctx, entry.item, placed))
  return Math.max(entry.item.depthMm, ...reaches)
}

function describePlacement(ctx: Context, placement: Placement): Placed {
  const entry = resolvePlacedEntry(ctx.catalog, placement.itemId)
  return {
    placement,
    entry,
    label: placementLabel(placement, entry),
    box: occupiedBox(ctx.plan, ctx.catalog, placement, ctx.frame),
    depthMm: placedDepthMm(ctx, placement, entry),
  }
}

function checkWidth(ctx: Context, name: string, widthMm: number, targetId: string): void {
  const inner = ctx.innerWidthMm
  if (inner !== undefined && widthMm > inner + EPSILON) {
    const message = `${name} is ${mm(widthMm)} wide, wider than the frame opening (${mm(inner)}).`
    report(ctx, 'warning', 'too-wide', message, targetId)
  } else if (widthMm > GEAR_WIDTH_GUIDE_MM + EPSILON) {
    const message = `${name} is ${mm(widthMm)} wide; gear over ${GEAR_WIDTH_GUIDE_MM} mm may not fit every 10" frame.`
    report(ctx, 'info', 'wide-guideline', message, targetId)
  }
}

/** Checks one device on its own; returns what the slot packing needs when it fits. */
function checkDeviceInSlot(
  ctx: Context,
  item: Item,
  slot: Slot,
  placed: PlacedDevice,
): PackItem | undefined {
  const device = ctx.catalog.device(placed.deviceId)
  if (device === undefined) {
    const message = `Device "${placed.deviceId}" in ${slotName(item, slot)} is not in the catalog.`
    report(ctx, 'warning', 'unknown-part', message, placed.id)
    return undefined
  }
  const name = deviceName(device)
  if (!slotAccepts(slot, device)) {
    const message = `${name} is not what ${slotName(item, slot)} is made for.`
    report(ctx, 'warning', 'slot-fit', message, placed.id)
  }
  const orientation = slotOrientation(slot, device, placed.orientation)
  if (orientation === undefined) {
    const { w, d, h } = device.dims
    const limit = `${slot.maxW} × ${slot.maxD}${slot.maxH === undefined ? '' : ` × ${slot.maxH}`} mm`
    const how =
      placed.orientation === undefined
        ? 'in any allowed orientation'
        : `placed ${placed.orientation}`
    const message = `${name} (${w} × ${d} × ${h} mm) does not fit ${slotName(item, slot)} (${limit}) ${how}.`
    report(ctx, 'error', 'slot-fit', message, placed.id)
    return undefined
  }
  checkWidth(ctx, name, orientedDims(device.dims, orientation).w, placed.id)
  // Only a stored orientation is pinned: packing may turn the others to make room.
  return {
    id: placed.id,
    device,
    ...(placed.orientation === undefined ? {} : { orientation: placed.orientation }),
  }
}

function groupBySlot(devices: readonly PlacedDevice[]): Map<string, PlacedDevice[]> {
  const groups = new Map<string, PlacedDevice[]>()
  for (const device of devices) {
    groups.set(device.slotId, [...(groups.get(device.slotId) ?? []), device])
  }
  return groups
}

function checkRoom(ctx: Context, item: Item, slot: Slot, fitting: readonly PackItem[]): void {
  // Acceptance is reported per device; here only room counts.
  const packed = packAreaSlot(fitting, { ...slot, accepts: undefined })
  for (const id of packed.overflowIds) {
    const message =
      slot.kind === 'fixed'
        ? `${slotName(item, slot)} holds one device.`
        : `No room left in ${slotName(item, slot)} (${mm(slot.maxW)} wide) for this device.`
    report(ctx, 'error', 'slot-fit', message, id)
  }
}

function checkUnknownDevices(ctx: Context, placed: Placed): void {
  for (const device of placed.placement.devices) {
    if (ctx.catalog.device(device.deviceId) !== undefined) continue
    const message = `Device "${device.deviceId}" in ${placed.label} is not in the catalog.`
    report(ctx, 'warning', 'unknown-part', message, device.id)
  }
}

function checkSlots(ctx: Context, placed: Placed): void {
  const { placement, entry } = placed
  if (placement.devices.length === 0) return
  if (entry.kind === 'unknown') {
    checkUnknownDevices(ctx, placed)
    return
  }
  if (entry.kind === 'device') {
    for (const device of placement.devices) {
      report(ctx, 'error', 'slot-fit', `${placed.label} has no slots for devices.`, device.id)
    }
    return
  }
  const item = entry.item
  for (const [slotId, devices] of groupBySlot(placement.devices)) {
    const slot = slotOf(item, slotId)
    if (slot === undefined) {
      for (const device of devices) {
        report(ctx, 'error', 'slot-fit', `${item.name} has no slot "${slotId}".`, device.id)
      }
      continue
    }
    const fitting = devices.flatMap((device) => checkDeviceInSlot(ctx, item, slot, device) ?? [])
    checkRoom(ctx, item, slot, fitting)
  }
}

// ---------------------------------------------------------------------------------------------
// Per-placement checks

function checkKnown(ctx: Context, placed: Placed): void {
  const { placement, entry, label } = placed
  if (entry.kind !== 'unknown') return
  const device = ctx.catalog.device(placement.itemId)
  const message =
    device === undefined
      ? `${label}: "${placement.itemId}" is not in the catalog, so it shows as a placeholder and its parts are not counted.`
      : `${label}: ${deviceName(device)} has no rack ears; put it in a mount instead.`
  report(ctx, 'warning', 'unknown-part', message, placement.id)
}

function checkCompat(ctx: Context, item: Item, label: string, targetId: string): void {
  const frames = item.compat?.frames ?? []
  if (frames.length === 0 || frames.includes(ctx.plan.frame.frameId)) return
  const frameName = ctx.frame?.name ?? ctx.plan.frame.frameId
  report(
    ctx,
    'warning',
    'frame-mismatch',
    `${label} is made for other frames (${frames.join(', ')}), not ${frameName}.`,
    targetId,
  )
}

function checkInRack(ctx: Context, placed: Placed): void {
  const { y0, y1 } = placed.box
  if (y0 >= 0 && y1 <= ctx.totalSixths) return
  const where = y0 < 0 ? 'below the bottom of the rack' : 'above the top of the rack'
  const stackU = ctx.totalSixths / SIXTHS_PER_U
  report(
    ctx,
    'error',
    'out-of-rack',
    `${placed.label} reaches ${where} (the stack is ${stackU}U).`,
    placed.placement.id,
  )
}

function checkPhase(ctx: Context, frame: Frame, placed: Placed): void {
  const { placement, label } = placed
  const placeable = resolvePlaceable(ctx.catalog, placement.itemId)
  if (placeable === undefined) return
  const { phases, verified } = allowedPhases(placeable, frame)
  // Ear-mounted gear follows the EIA hole pattern, so whole-U positions are known to fit.
  const known = verified || placeable.source === 'rackmount'
  if (!known) {
    const message = `${placeable.name} has no recorded hole positions, so only the usual positions for its height are offered.`
    report(ctx, 'info', 'unverified-holes', message, placement.id)
  }
  if (phases.includes(phaseOf(placement.y))) return
  if (known) {
    const message = `${label}: its mount holes miss the rail holes at this height. Move it up or down.`
    report(ctx, 'error', 'phase-invalid', message, placement.id)
  } else {
    const message = `${label} is not where items of its height usually mount, and its hole positions are unknown: check that the screws line up.`
    report(ctx, 'warning', 'phase-invalid', message, placement.id)
  }
}

function checkDeadZones(ctx: Context, frame: Frame, placed: Placed): void {
  const { y } = placed.placement
  const top = y + Math.max(placed.box.y1 - placed.box.y0, 1)
  for (const joint of stackJoints(ctx.plan, frame)) {
    // A joint without a dead zone (deadY0 === deadY1) can be crossed, as `canPlace` allows.
    if (!(joint.deadY0 < joint.deadY1 && joint.deadY0 < top && y < joint.deadY1)) continue
    report(
      ctx,
      'warning',
      'dead-zone',
      `${placed.label} crosses the joint at U${uNumberAt(joint.ySixths)}, where nothing can be fixed.`,
      placed.placement.id,
    )
  }
}

function checkClearance(ctx: Context, frame: Frame, placed: Placed): void {
  if (placed.entry.kind !== 'item') return
  const clearance = placed.entry.item.mount.clearance
  const thread = frame.equipmentFastener.thread
  if (clearance === undefined || clearance === thread) return
  const tooSmall = THREAD_DIAMETER_MM[clearance] < THREAD_DIAMETER_MM[thread]
  const message = tooSmall
    ? `${placed.label}: its ${clearance} holes are too small for the frame's ${thread} screws.`
    : `${placed.label}: its ${clearance} holes are larger than the frame's ${thread} screws; use washers.`
  report(ctx, 'warning', 'clearance-mismatch', message, placed.placement.id)
}

function checkDepth(ctx: Context, frame: Frame, placed: Placed): void {
  const depth = ctx.depthMm
  if (depth === undefined || placed.depthMm <= depth + EPSILON) return
  const over = mm(placed.depthMm - depth)
  const { id, face } = placed.placement
  if (face === 'rear') {
    report(ctx, 'warning', 'depth-overhang', `${placed.label} sticks out ${over} at the front.`, id)
  } else if (frame.standard.rearOpen) {
    report(ctx, 'warning', 'depth-overhang', `${placed.label} sticks out ${over} at the back.`, id)
  } else {
    const message = `${placed.label} is ${over} deeper than the frame, which is closed at the back.`
    report(ctx, 'warning', 'too-deep', message, id)
  }
}

function checkRearSupport(ctx: Context, placed: Placed): void {
  const depth = ctx.depthMm
  const needsRear = placed.entry.kind === 'item' && placed.entry.item.requiresRearSupport === true
  if (!needsRear || depth === undefined) return
  if (placed.depthMm + REAR_REACH_TOLERANCE_MM >= depth) return
  report(
    ctx,
    'warning',
    'rear-support-missing',
    `${placed.label} needs support at the back, but at ${mm(placed.depthMm)} deep it does not reach the rear rails (${mm(depth)}).`,
    placed.placement.id,
  )
}

function checkPlacement(ctx: Context, placed: Placed): void {
  checkKnown(ctx, placed)
  if (placed.entry.kind === 'item') {
    checkCompat(ctx, placed.entry.item, placed.label, placed.placement.id)
  }
  checkSlots(ctx, placed)
  const frame = ctx.frame
  if (frame === undefined) return
  checkInRack(ctx, placed)
  checkPhase(ctx, frame, placed)
  checkDeadZones(ctx, frame, placed)
  checkClearance(ctx, frame, placed)
  checkDepth(ctx, frame, placed)
  checkRearSupport(ctx, placed)
}

// ---------------------------------------------------------------------------------------------
// Whole-plan checks

function checkOverlaps(ctx: Context, placed: readonly Placed[]): void {
  for (const [index, a] of placed.entries()) {
    for (const b of placed.slice(index + 1)) {
      if (a.box.y1 <= a.box.y0 || b.box.y1 <= b.box.y0 || !boxesOverlap(a.box, b.box)) continue
      report(ctx, 'error', 'overlap', `${a.label} overlaps ${b.label}.`, a.placement.id)
      report(ctx, 'error', 'overlap', `${b.label} overlaps ${a.label}.`, b.placement.id)
    }
  }
}

function checkEquipment(ctx: Context): void {
  for (const entry of ctx.plan.equipment) {
    if (ctx.catalog.device(entry.deviceId) !== undefined) continue
    const message = `Equipment "${entry.deviceId}" is not in the catalog.`
    report(ctx, 'warning', 'unknown-part', message, entry.id)
  }
}

function checkExtras(ctx: Context): void {
  for (const extra of ctx.plan.extras) {
    const item = ctx.catalog.item(extra.itemId)
    if (item === undefined) {
      const message = `Extra "${extra.itemId}" is not in the catalog, so it is not counted.`
      report(ctx, 'warning', 'unknown-part', message, extra.id)
      continue
    }
    checkCompat(ctx, item, item.name, extra.id)
  }
}

type Bed = NonNullable<Settings['printerBedMm']>

/**
 * Whether a p × q rectangle fits in an a × b one at some angle (Carver's condition). Long thin
 * parts such as 6U legs are printed diagonally, so an axis-aligned test would cry wolf.
 */
export function rectangleFits(p0: number, q0: number, a0: number, b0: number): boolean {
  const [p, q] = p0 >= q0 ? [p0, q0] : [q0, p0]
  const [a, b] = a0 >= b0 ? [a0, b0] : [b0, a0]
  if (q > b + EPSILON) return false
  if (p <= a + EPSILON) return true
  const reach = Math.sqrt(p * p + q * q - a * a)
  return b + EPSILON >= (2 * p * q * a + (p * p - q * q) * reach) / (p * p + q * q)
}

/** A part fits when it can lie on one of its faces with its footprint somewhere on the bed. */
export function fitsPrinterBed(dims: Dims, bed: Bed): boolean {
  const sides = [dims.w, dims.d, dims.h]
  return sides.some((height, index) => {
    if (height > bed.z + EPSILON) return false
    const [p = 0, q = 0] = sides.filter((_, other) => other !== index)
    return rectangleFits(p, q, bed.x, bed.y)
  })
}

/** Frame parts printed for the planned stack (through the print groups' pieces). */
function framePartsInUse(plan: Plan, frame: Frame): Part3D[] {
  const printIds = new Set(
    expandFrameRecipe(frame, frameConfigFromPlan(plan.frame, frame))
      .filter((line) => line.kind === 'print')
      .map((line) => line.refId),
  )
  const partIds = new Set(
    frame.prints
      .filter((print) => printIds.has(print.id))
      .flatMap((print) => (print.pieces ?? []).map((piece) => piece.partId)),
  )
  return (frame.parts3d ?? []).filter((part) => partIds.has(part.id))
}

function checkPartOnBed(
  ctx: Context,
  bed: Bed,
  owner: string,
  part: Part3D,
  targetId?: string,
): void {
  if (fitsPrinterBed(part.envelopeMm, bed)) return
  const { w, d, h } = part.envelopeMm
  const message = `${owner}: ${part.label} (${w} × ${d} × ${h} mm) may not fit your ${bed.x} × ${bed.y} × ${bed.z} mm printer bed.`
  report(ctx, 'warning', 'printer-bed', message, targetId)
}

function checkPrinterBed(ctx: Context, placed: readonly Placed[]): void {
  const bed = ctx.settings.printerBedMm
  if (bed === undefined) return
  if (ctx.frame !== undefined) {
    for (const part of framePartsInUse(ctx.plan, ctx.frame)) {
      checkPartOnBed(ctx, bed, ctx.frame.name, part)
    }
  }
  const seen = new Set<string>()
  for (const { entry, placement } of placed) {
    if (entry.kind !== 'item' || seen.has(entry.item.id)) continue
    seen.add(entry.item.id)
    const { item } = entry
    const parts = item.parts3d ?? []
    for (const part of parts) checkPartOnBed(ctx, bed, item.name, part, placement.id)
    if (parts.length === 0 && item.depthMm > Math.max(bed.x, bed.y, bed.z) + EPSILON) {
      const message = `${item.name} is ${mm(item.depthMm)} deep and may not fit your ${bed.x} × ${bed.y} × ${bed.z} mm printer bed.`
      report(ctx, 'warning', 'printer-bed', message, placement.id)
    }
  }
}

function checkPower(ctx: Context): void {
  const power = powerSummary(ctx.plan, ctx.catalog)
  if (power.acOutletsAvailable > 0 && power.acOutletsNeeded > power.acOutletsAvailable) {
    const message = `The plan needs ${power.acOutletsNeeded} AC outlets (wall-plug bricks take 2); its power strips have ${power.acOutletsAvailable}.`
    report(ctx, 'warning', 'power-ac', message)
  }
  if (power.poePortsAvailable > 0 && power.poePortsNeeded > power.poePortsAvailable) {
    const message = `${power.poePortsNeeded} devices need PoE; the switches have ${power.poePortsAvailable} PoE ports.`
    report(ctx, 'warning', 'power-poe', message)
  }
  if (power.poeBudgetW > 0 && power.poeDemandW > power.poeBudgetW + EPSILON) {
    const message = `PoE devices draw up to ${power.poeDemandW} W; the PoE budget is ${power.poeBudgetW} W.`
    report(ctx, 'warning', 'power-poe', message)
  }
  if (power.usbcPortsAvailable > 0 && power.usbcPortsNeeded > power.usbcPortsAvailable) {
    const message = `${power.usbcPortsNeeded} devices need USB-C power; the chargers have ${power.usbcPortsAvailable} ports.`
    report(ctx, 'warning', 'power-usbc', message)
  }
}

function checkFrameKnown(ctx: Context): void {
  if (ctx.frame !== undefined) return
  const message = `Frame "${ctx.plan.frame.frameId}" is not in the catalog, so positions cannot be checked.`
  report(ctx, 'warning', 'unknown-part', message)
}

function createContext(plan: Plan, catalog: CatalogLookup, settings: Settings): Context {
  const frame = catalog.frame(plan.frame.frameId)
  const size = frame === undefined ? undefined : effectiveFrameSize(frame, plan.frame.options)
  return {
    plan,
    catalog,
    settings,
    frame,
    depthMm: size?.depthMm,
    innerWidthMm: size?.innerWidthMm,
    totalSixths: frame === undefined ? 0 : totalHeightSixths(plan, frame),
    issues: [],
  }
}

/** Errors first, then warnings, then info; plan order within each. */
function sortIssues(issues: readonly Issue[]): Issue[] {
  return issues.toSorted((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

export const runChecks: RunChecks = (plan, baseCatalog, settings) => {
  const catalog = withCustomEntries(baseCatalog, plan.custom)
  const ctx = createContext(plan, catalog, settings)
  checkFrameKnown(ctx)
  const placed = plan.placements.map((placement) => describePlacement(ctx, placement))
  for (const entry of placed) checkPlacement(ctx, entry)
  checkOverlaps(ctx, placed)
  checkEquipment(ctx)
  checkExtras(ctx)
  checkPrinterBed(ctx, placed)
  checkPower(ctx)
  return sortIssues(ctx.issues)
}
