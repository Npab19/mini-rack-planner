/**
 * Placement engine.
 *
 * - Where an item can start: hole-aware phases (`allowedPhases`) and snapping (`snapY`).
 * - What it occupies: U range × bay × z band, plus the rail columns it is screwed to
 *   (`occupiedBox`, `boxesOverlap`).
 * - Whether it fits: `canPlace` (out of rack, overlap, phase, joint dead zone, face, bay),
 *   `findFreeY` / `findFreeSpot`, and `fitItIn` for "Fit it for me".
 * - Devices in slots: `fitDeviceInSlot`, `packAreaSlot`.
 * - Small pure edits: `addPlacement`, `movePlacement`, `duplicatePlacement`, `deletePlacement`.
 *
 * Positions are integer sixths of a U from the bottom of U1; a placement's `y` is its bottom edge.
 * A placement's `itemId` names a catalog item, or ear-mounted gear placed directly through
 * `device.rackmount`.
 */
import {
  listNames,
  placementHeightSixths,
  placementName,
  removePlacements,
  stackJoints,
  totalHeightSixths,
  type RemovePlacementsOptions,
  type StackJoint,
} from './frame'
import {
  formatU,
  mmToSixthsCeil,
  phaseOf,
  SIXTHS_PER_U,
  sixthsToMm,
  U_MM,
  uNumberAt,
} from './geometry'
import { ID_PREFIX, newId } from './ids'
import { effectiveFrameSize } from './recipe'
import {
  defaultMountHoles,
  deviceName,
  withCustomEntries,
  type Bay,
  type CatalogLookup,
  type Device,
  type Frame,
  type Item,
  type Mount,
  type Slot,
} from './schema/catalog'
import type { Dims, Face, Orientation } from './schema/common'
import type { PlacedDevice, Placement, PlacementBay, Plan } from './schema/plan'

/** Headroom kept above the tallest device on a shelf. */
export const SHELF_HEADROOM_MM = 5
/** Room behind a device for plugs and cables: a front band reaches the deepest device plus this. */
export const PLUG_CLEARANCE_MM = 30
/** Default gap between devices packed side by side in an area slot. */
export const DEVICE_GAP_MM = 5
// Absorbs float noise in millimetre comparisons.
const EPSILON = 1e-6

// ---------------------------------------------------------------------------------------------
// What can be placed

/** The facts placement needs, from an item or from ear-mounted gear (`device.rackmount`). */
export interface Placeable {
  /** The catalog id a placement's `itemId` holds. */
  id: string
  name: string
  source: 'item' | 'rackmount' | 'placeholder'
  heightSixths: number
  faces: readonly Face[]
  bay: Bay
  /** How far it reaches into the rack from the rail it mounts on. */
  depthMm: number
  mount: Mount
  slots: readonly Slot[]
  requiresRearSupport: boolean
}

/** An item, else ear-mounted gear. Extras (non-U accessories) and unknown ids are undefined. */
export function resolvePlaceable(catalog: CatalogLookup, itemId: string): Placeable | undefined {
  const item = catalog.item(itemId)
  if (item !== undefined) return item.kind === 'item' ? fromItem(item) : undefined
  const device = catalog.device(itemId)
  return device?.rackmount === undefined ? undefined : fromRackmount(device, device.rackmount)
}

function fromItem(item: Item): Placeable {
  return {
    id: item.id,
    name: item.name,
    source: 'item',
    heightSixths: item.heightSixths,
    faces: item.faces,
    bay: item.bay,
    depthMm: item.depthMm,
    mount: item.mount,
    slots: item.slots,
    requiresRearSupport: item.requiresRearSupport ?? false,
  }
}

function fromRackmount(device: Device, rackmount: NonNullable<Device['rackmount']>): Placeable {
  return {
    id: device.id,
    name: deviceName(device),
    source: 'rackmount',
    heightSixths: rackmount.heightSixths,
    faces: [rackmount.face],
    bay: 'full',
    depthMm: rackmount.depthMm,
    mount: { front: defaultMountHoles(rackmount.heightSixths, 'full'), rear: 0 },
    slots: [],
    requiresRearSupport: false,
  }
}

/** Stand-in for a placement whose catalog entry is unknown, from its denormalized copies. */
function placeholderFor(placement: Placement): Placeable {
  return {
    id: placement.itemId,
    name: placement.name ?? placement.itemId,
    source: 'placeholder',
    heightSixths: placement.heightSixths ?? 0,
    faces: ['front', 'rear'],
    bay: placement.bay === 'full' ? 'full' : 'half',
    depthMm: 0,
    mount: { front: 0, rear: 0 },
    slots: [],
    requiresRearSupport: false,
  }
}

function placeableOf(catalog: CatalogLookup, placement: Placement): Placeable {
  return resolvePlaceable(catalog, placement.itemId) ?? placeholderFor(placement)
}

// ---------------------------------------------------------------------------------------------
// Start phases and snapping

export interface AllowedPhases {
  /** Valid `y mod 6` values (sixths within a U), ascending. */
  phases: number[]
  /** False when the item has no hole data and the phases come from its height. */
  verified: boolean
}

/**
 * Start phases (y mod 6) at which an item can mount.
 *
 * With `mount.holeOffsetsMm` (hole centres from the item's bottom edge), a phase is valid when
 * every hole lands on a rail hole (`rail.holeOffsetsPerUMm`, repeated every U from the bottom of
 * U1) within `rail.holeTolMm`; a slotted ear adds half its `slotLengthMm` to that tolerance.
 *
 * Without hole data the phases come from the height, unverified: 1U and taller start on a whole U
 * ([0], 1½U too); shorter items step by their own grid without crossing a U boundary
 * (½U [0, 3], ⅓U [0, 2, 4], ⅔U [0, 2]).
 */
export function allowedPhases(
  item: Pick<Item, 'heightSixths' | 'mount'>,
  frame: Frame,
): AllowedPhases {
  const holes = item.mount.holeOffsetsMm ?? []
  if (holes.length === 0) return { phases: defaultPhases(item.heightSixths), verified: false }
  const tolerance = frame.rail.holeTolMm + (item.mount.slotLengthMm ?? 0) / 2 + EPSILON
  const phases: number[] = []
  for (let phase = 0; phase < SIXTHS_PER_U; phase++) {
    const bottomMm = sixthsToMm(phase)
    const fits = holes.every(
      (offset) => railHoleDistanceMm(bottomMm + offset, frame.rail.holeOffsetsPerUMm) <= tolerance,
    )
    if (fits) phases.push(phase)
  }
  return { phases, verified: true }
}

function defaultPhases(heightSixths: number): number[] {
  if (heightSixths <= 0 || heightSixths >= SIXTHS_PER_U) return [0]
  const grid = heightSixths % 3 === 0 ? 3 : heightSixths % 2 === 0 ? 2 : 1
  const phases: number[] = []
  for (let phase = 0; phase + heightSixths <= SIXTHS_PER_U; phase += grid) phases.push(phase)
  return phases
}

/** Distance from a height to the nearest rail hole; the pattern repeats every U. */
function railHoleDistanceMm(yMm: number, offsetsPerUMm: readonly number[]): number {
  const withinU = ((yMm % U_MM) + U_MM) % U_MM
  let best = Number.POSITIVE_INFINITY
  for (const offset of offsetsPerUMm) {
    const distance = Math.abs(withinU - offset)
    best = Math.min(best, distance, Math.abs(U_MM - distance))
  }
  return best
}

/**
 * The y (whole sixths) nearest to `rawSixths` whose phase is allowed; ties go to the lower y.
 * Without phases it just rounds (`canPlace` then reports the invalid phase).
 */
export function snapY(rawSixths: number, phases: readonly number[]): number {
  if (!Number.isFinite(rawSixths)) return 0
  let best: number | undefined
  for (const phase of phases) {
    const below =
      Math.floor((rawSixths - phaseOf(phase)) / SIXTHS_PER_U) * SIXTHS_PER_U + phaseOf(phase)
    for (const y of [below, below + SIXTHS_PER_U]) {
      if (best === undefined || isCloser(y, best, rawSixths)) best = y
    }
  }
  // `+ 0` turns -0 into 0.
  return (best ?? Math.round(rawSixths)) + 0
}

function isCloser(y: number, best: number, target: number): boolean {
  const distance = Math.abs(y - target)
  const bestDistance = Math.abs(best - target)
  if (Math.abs(distance - bestDistance) > EPSILON) return distance < bestDistance
  return y < best
}

// ---------------------------------------------------------------------------------------------
// Occupancy

/** The space a placement takes. Z points toward the viewer; 0 is the front rail face. */
export interface OccupiedBox {
  placementId?: string
  face: Face
  /** U range [y0, y1) in sixths; shelves reach up to the tallest device on them. */
  y0: number
  y1: number
  bay: PlacementBay
  zFrontMm: number
  zBackMm: number
  /** Uses the rear rail's hole columns: rear-face items and front items supported at the rear. */
  claimsRearColumns: boolean
  /** Uses the front rail's hole columns: front-face items and rear items supported at the front. */
  claimsFrontColumns: boolean
}

interface BoxAt {
  id?: string
  y: number
  face: Face
  bay: PlacementBay
  devices: readonly PlacedDevice[]
}

/**
 * The space a placement occupies: its U range (a shelf reaches up to its tallest device: slot
 * floor + device height + `SHELF_HEADROOM_MM`, rounded up to sixths), its bay, a z band and the
 * rail columns it uses.
 *
 * The band starts at the rail the item mounts on (the rear rail sits at the frame depth after rack
 * option effects) and reaches the item's depth, or its deepest device plus `PLUG_CLEARANCE_MM`.
 * Items also supported on the opposite rail (`requiresRearSupport` or rear ear holes) span the
 * whole depth and claim that rail's columns. With no known frame, rear bands are measured from the
 * front, so front and rear gear is never reported free when it might collide.
 */
export function occupiedBox(
  plan: Plan,
  catalog: CatalogLookup,
  placement: Placement,
  frame?: Frame,
): OccupiedBox {
  const lookup = withCustomEntries(catalog, plan.custom)
  const depthMm = rackDepthMm(plan, frame ?? lookup.frame(plan.frame.frameId))
  return boxOf(placeableOf(lookup, placement), placement, lookup, depthMm)
}

function boxOf(
  placeable: Placeable,
  at: BoxAt,
  catalog: CatalogLookup,
  frameDepthMm: number | undefined,
): OccupiedBox {
  let y1 = at.y + placeable.heightSixths
  let reachMm = placeable.depthMm
  for (const placed of at.devices) {
    const device = catalog.device(placed.deviceId)
    const slot = placeable.slots.find((candidate) => candidate.id === placed.slotId)
    if (device === undefined || slot === undefined) continue
    const orientation = placed.orientation ?? fitDeviceInSlot(device, slot).orientation ?? 'flat'
    const size = orientedDims(device.dims, orientation)
    const topMm = sixthsToMm(at.y) + slot.layout.yMm + size.h + SHELF_HEADROOM_MM
    y1 = Math.max(y1, mmToSixthsCeil(topMm))
    reachMm = Math.max(reachMm, size.d - slot.layout.zMm + PLUG_CLEARANCE_MM)
  }
  const opposite = placeable.requiresRearSupport || placeable.mount.rear > 0
  if (opposite && frameDepthMm !== undefined) reachMm = Math.max(reachMm, frameDepthMm)
  const fromRear = at.face === 'rear' && frameDepthMm !== undefined
  return {
    ...(at.id === undefined ? {} : { placementId: at.id }),
    face: at.face,
    y0: at.y,
    y1,
    bay: at.bay,
    zFrontMm: fromRear ? reachMm - frameDepthMm : 0,
    zBackMm: fromRear ? -frameDepthMm : 0 - reachMm,
    claimsRearColumns: at.face === 'rear' || opposite,
    claimsFrontColumns: at.face === 'front' || opposite,
  }
}

function rackDepthMm(plan: Plan, frame: Frame | undefined): number | undefined {
  return frame === undefined ? undefined : effectiveFrameSize(frame, plan.frame.options).depthMm
}

/**
 * Two boxes collide when their U ranges and bays overlap and they either use the same rail columns
 * (same face, or an item supported on the other rail) or their z bands overlap.
 */
export function boxesOverlap(a: OccupiedBox, b: OccupiedBox): boolean {
  if (!(a.y0 < b.y1 && b.y0 < a.y1)) return false
  if (!baysOverlap(a.bay, b.bay)) return false
  const sharedColumns =
    (a.claimsFrontColumns && b.claimsFrontColumns) || (a.claimsRearColumns && b.claimsRearColumns)
  return sharedColumns || (a.zBackMm < b.zFrontMm && b.zBackMm < a.zFrontMm)
}

function baysOverlap(a: PlacementBay, b: PlacementBay): boolean {
  return a === 'full' || b === 'full' || a === b
}

// ---------------------------------------------------------------------------------------------
// Can it go here?

export type PlaceReasonCode =
  | 'unknown-item'
  | 'face-not-allowed'
  | 'bay-mismatch'
  | 'out-of-rack'
  | 'invalid-phase'
  | 'dead-zone'
  | 'overlap'

export interface PlaceReason {
  code: PlaceReasonCode
  message: string
  /** The placements it collides with ('overlap'). */
  placementIds?: string[]
}

export interface PlaceCheck {
  ok: boolean
  reasons: PlaceReason[]
}

export interface PlacementCandidate {
  itemId: string
  y: number
  face: Face
  bay: PlacementBay
  /** The placement being moved: it never blocks itself, and its devices come along. */
  ignorePlacementId?: string
  /** Devices to account for (shelf height); default: the moved placement's devices. */
  devices?: readonly PlacedDevice[]
}

/** One plan's boxes, stack top and joints, computed once for many candidate checks. */
interface PlaceContext {
  plan: Plan
  catalog: CatalogLookup
  frame: Frame
  frameDepthMm: number | undefined
  topSixths: number
  joints: StackJoint[]
  others: Array<{ placement: Placement; box: OccupiedBox }>
}

function placeContext(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  ignorePlacementId: string | undefined,
): PlaceContext {
  const lookup = withCustomEntries(catalog, plan.custom)
  const frameDepthMm = rackDepthMm(plan, frame)
  const others = plan.placements
    .filter((placement) => placement.id !== ignorePlacementId)
    .map((placement) => ({
      placement,
      box: boxOf(placeableOf(lookup, placement), placement, lookup, frameDepthMm),
    }))
  return {
    plan,
    catalog: lookup,
    frame,
    frameDepthMm,
    topSixths: totalHeightSixths(plan, frame),
    joints: stackJoints(plan, frame),
    others,
  }
}

/**
 * Whether an item can go at a position, with every reason it cannot: unknown item, face or bay
 * not allowed, out of the rack, holes off the rail (`allowedPhases`), a joint dead zone, or an
 * overlap with other placements (named).
 */
export function canPlace(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  candidate: PlacementCandidate,
): PlaceCheck {
  return checkCandidate(placeContext(plan, catalog, frame, candidate.ignorePlacementId), candidate)
}

function checkCandidate(ctx: PlaceContext, candidate: PlacementCandidate): PlaceCheck {
  const moving = ctx.plan.placements.find(
    (placement) => placement.id === candidate.ignorePlacementId,
  )
  const sameItem = moving?.itemId === candidate.itemId ? moving : undefined
  const placeable =
    resolvePlaceable(ctx.catalog, candidate.itemId) ??
    (sameItem === undefined ? undefined : placeholderFor(sameItem))
  if (placeable === undefined) {
    const message = `"${candidate.itemId}" is not in the catalog.`
    return { ok: false, reasons: [{ code: 'unknown-item', message }] }
  }
  const devices = candidate.devices ?? sameItem?.devices ?? []
  const at: BoxAt = { y: candidate.y, face: candidate.face, bay: candidate.bay, devices }
  const box = boxOf(placeable, at, ctx.catalog, ctx.frameDepthMm)
  const reasons = [
    ...faceReasons(placeable, candidate.face),
    ...bayReasons(placeable, candidate.bay),
    ...rackReasons(box, ctx.topSixths),
    ...phaseReasons(placeable, candidate.y, ctx.frame),
    ...deadZoneReasons(candidate.y, candidate.y + placeable.heightSixths, ctx.joints),
    ...overlapReasons(box, ctx),
  ]
  return { ok: reasons.length === 0, reasons }
}

function faceReasons(placeable: Placeable, face: Face): PlaceReason[] {
  if (placeable.faces.includes(face)) return []
  const message = `${placeable.name} mounts on the ${listNames([...placeable.faces])} only.`
  return [{ code: 'face-not-allowed', message }]
}

function bayReasons(placeable: Placeable, bay: PlacementBay): PlaceReason[] {
  if (placeable.bay === 'full' && bay !== 'full') {
    return [{ code: 'bay-mismatch', message: `${placeable.name} is full width.` }]
  }
  if (placeable.bay === 'half' && bay === 'full') {
    const message = `${placeable.name} is half width: put it on the left or the right.`
    return [{ code: 'bay-mismatch', message }]
  }
  return []
}

function rackReasons(box: OccupiedBox, topSixths: number): PlaceReason[] {
  if (topSixths <= 0) return [{ code: 'out-of-rack', message: 'The rack has no sections yet.' }]
  if (box.y0 < 0) {
    return [{ code: 'out-of-rack', message: 'It would sit below U1, the bottom of the rack.' }]
  }
  if (box.y1 > topSixths) {
    const message = `It would reach above U${uNumberAt(topSixths - 1)}, the top of the rack.`
    return [{ code: 'out-of-rack', message }]
  }
  return []
}

function phaseReasons(placeable: Placeable, y: number, frame: Frame): PlaceReason[] {
  if (!Number.isInteger(y)) {
    return [{ code: 'invalid-phase', message: 'Positions are whole sixths of a U.' }]
  }
  const { phases, verified } = allowedPhases(placeable, frame)
  if (phases.includes(phaseOf(y))) return []
  if (phases.length === 0) {
    const message = `${placeable.name}'s holes do not line up with the ${frame.name} rail anywhere.`
    return [{ code: 'invalid-phase', message }]
  }
  const why = verified
    ? 'its holes do not line up with the rail there'
    : 'items of its height do not usually mount there (its holes are not verified)'
  const message = `${placeable.name} cannot start at ${positionLabel(y)}: ${why}. Try ${positionLabel(snapY(y, phases))}.`
  return [{ code: 'invalid-phase', message }]
}

function deadZoneReasons(y0: number, y1: number, joints: readonly StackJoint[]): PlaceReason[] {
  const joint = joints.find(
    (candidate) =>
      candidate.deadY0 < candidate.deadY1 && candidate.deadY0 < y1 && y0 < candidate.deadY1,
  )
  if (joint === undefined) return []
  const between = `U${uNumberAt(joint.ySixths - 1)} and U${uNumberAt(joint.ySixths)}`
  const message = `It crosses the joint between ${between}, where nothing can mount.`
  return [{ code: 'dead-zone', message }]
}

function overlapReasons(box: OccupiedBox, ctx: PlaceContext): PlaceReason[] {
  const hits = ctx.others.filter((other) => boxesOverlap(box, other.box))
  if (hits.length === 0) return []
  const names = hits.map(
    ({ placement, box: other }) =>
      `${placementName(placement, ctx.catalog)} (${spanLabel(other.y0, other.y1)})`,
  )
  return [
    {
      code: 'overlap',
      message: `It overlaps ${listNames(names)}.`,
      placementIds: hits.map(({ placement }) => placement.id),
    },
  ]
}

/** "U3", or "U3 + ½U" for a start inside a U. */
function positionLabel(y: number): string {
  const phase = phaseOf(y)
  return `U${uNumberAt(y)}${phase === 0 ? '' : ` + ${formatU(phase)}`}`
}

/** "U3" or "U3–U4" for the sixths [y0, y1). */
function spanLabel(y0: number, y1: number): string {
  const first = uNumberAt(y0)
  const last = uNumberAt(Math.max(y0, y1 - 1))
  return first === last ? `U${first}` : `U${first}–U${last}`
}

// ---------------------------------------------------------------------------------------------
// Finding room

export interface FreeSpotOptions {
  /** Only this face (default: each face the item allows, in its order). */
  face?: Face
  /** Search upward from the bottom (default) or downward from the top. */
  from?: 'bottom' | 'top'
  /** Only this bay (default: full, or left then right for half-width items). */
  bay?: PlacementBay
  /** A placement being moved: it does not block itself. */
  ignorePlacementId?: string
}

export interface FreeSpot {
  y: number
  face: Face
  bay: PlacementBay
}

/** The first position where `canPlace` passes, searching from the bottom (or the top). */
export function findFreeSpot(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  itemId: string,
  options: FreeSpotOptions = {},
): FreeSpot | null {
  const ctx = placeContext(plan, catalog, frame, options.ignorePlacementId)
  const placeable = resolvePlaceable(ctx.catalog, itemId)
  if (placeable === undefined) return null
  const faces = options.face === undefined ? placeable.faces : [options.face]
  const bays = options.bay === undefined ? baysFor(placeable.bay) : [options.bay]
  const upward = startPositions(placeable, frame, ctx.topSixths)
  const ys = options.from === 'top' ? upward.toReversed() : upward
  for (const face of faces) {
    for (const y of ys) {
      for (const bay of bays) {
        const candidate = { itemId, y, face, bay, ignorePlacementId: options.ignorePlacementId }
        if (checkCandidate(ctx, candidate).ok) return { y, face, bay }
      }
    }
  }
  return null
}

/** The lowest (or highest) free y for an item; see `findFreeSpot`. */
export function findFreeY(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  itemId: string,
  options: FreeSpotOptions = {},
): number | null {
  return findFreeSpot(plan, catalog, frame, itemId, options)?.y ?? null
}

function baysFor(bay: Bay): PlacementBay[] {
  return bay === 'half' ? ['left', 'right'] : ['full']
}

/** Every start inside the stack at an allowed phase, bottom to top. */
function startPositions(placeable: Placeable, frame: Frame, topSixths: number): number[] {
  const { phases } = allowedPhases(placeable, frame)
  const ys: number[] = []
  for (let base = 0; base < topSixths; base += SIXTHS_PER_U) {
    for (const phase of phases) {
      const y = base + phase
      if (y + placeable.heightSixths <= topSixths) ys.push(y)
    }
  }
  return ys
}

export interface FittedPlacement {
  itemId: string
  placementId: string
  y: number
  face: Face
  bay: PlacementBay
}

export interface FitResult {
  plan: Plan
  placed: FittedPlacement[]
  /** Item ids that are unknown or found no room, once per copy left over. */
  unplaced: string[]
}

/**
 * "Fit it for me": adds a placement for each item id, bottom-up and taller items first (first-fit
 * decreasing, full width before half width), each at the lowest free position on the first face
 * with room. The new placements are planned (Need).
 */
export function fitItIn(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  itemIds: readonly string[],
): FitResult {
  const lookup = withCustomEntries(catalog, plan.custom)
  const unplaced: string[] = []
  const queue: Placeable[] = []
  for (const itemId of itemIds) {
    const placeable = resolvePlaceable(lookup, itemId)
    if (placeable === undefined) unplaced.push(itemId)
    else queue.push(placeable)
  }
  const order = queue.toSorted(
    (a, b) => b.heightSixths - a.heightSixths || bayRank(a.bay) - bayRank(b.bay),
  )
  let current = plan
  const placed: FittedPlacement[] = []
  for (const placeable of order) {
    const spot = findFreeSpot(current, lookup, frame, placeable.id)
    if (spot === null) {
      unplaced.push(placeable.id)
      continue
    }
    const placement = newPlacement(placeable, spot)
    current = { ...current, placements: [...current.placements, placement] }
    placed.push({ itemId: placeable.id, placementId: placement.id, ...spot })
  }
  return { plan: current, placed, unplaced }
}

function bayRank(bay: Bay): number {
  return bay === 'full' ? 0 : 1
}

function newPlacement(placeable: Placeable, spot: FreeSpot): Placement {
  return {
    id: newId(ID_PREFIX.placement),
    itemId: placeable.id,
    name: placeable.name,
    heightSixths: placeable.heightSixths,
    y: spot.y,
    face: spot.face,
    bay: spot.bay,
    devices: [],
  }
}

// ---------------------------------------------------------------------------------------------
// Devices in slots

/**
 * A device's size in rack axes (w along X, d along Z, h along Y) in an orientation:
 * - flat: as it normally sits (w × d footprint, h tall)
 * - flat-rotated: turned 90° on the shelf (d × w footprint, h tall)
 * - on-side: rolled onto its side (h × d footprint, w tall)
 * - upright: stood on its back or front (w × h footprint, d tall)
 */
export function orientedDims(dims: Dims, orientation: Orientation): Dims {
  switch (orientation) {
    case 'flat':
      return { w: dims.w, d: dims.d, h: dims.h }
    case 'flat-rotated':
      return { w: dims.d, d: dims.w, h: dims.h }
    case 'on-side':
      return { w: dims.h, d: dims.d, h: dims.w }
    case 'upright':
      return { w: dims.w, d: dims.h, h: dims.d }
  }
}

export interface SlotFit {
  ok: boolean
  orientation?: Orientation
  reason?: string
}

/**
 * The first orientation the slot allows (in its order) in which the device fits within
 * `maxW × maxD` (and `maxH` when set), if the slot accepts the device at all.
 */
export function fitDeviceInSlot(device: Device, slot: Slot): SlotFit {
  if (!slotAccepts(slot, device)) {
    return { ok: false, reason: `${slotName(slot)} is not made for the ${deviceName(device)}.` }
  }
  const orientation = slot.orientations.find((candidate) =>
    fitsSlot(orientedDims(device.dims, candidate), slot),
  )
  if (orientation !== undefined) return { ok: true, orientation }
  const { w, d, h } = device.dims
  const limits = `${slot.maxW} × ${slot.maxD}${slot.maxH === undefined ? '' : ` × ${slot.maxH}`} mm`
  return {
    ok: false,
    reason: `The ${deviceName(device)} (${w} × ${d} × ${h} mm) does not fit ${slotName(slot)} (${limits}) in any allowed orientation.`,
  }
}

/** A slot without `accepts` takes any device; otherwise the device's category or id must be listed. */
export function slotAccepts(slot: Slot, device: Device): boolean {
  const categories = slot.accepts?.categories
  const deviceIds = slot.accepts?.deviceIds
  if (categories === undefined && deviceIds === undefined) return true
  return (categories ?? []).includes(device.category) || (deviceIds ?? []).includes(device.id)
}

/** Whether a box (in rack axes) fits the slot's depth and height and `widthLeftMm` of its width. */
export function fitsSlot(size: Dims, slot: Slot, widthLeftMm = slot.maxW): boolean {
  return (
    size.w <= widthLeftMm + EPSILON &&
    size.d <= slot.maxD + EPSILON &&
    (slot.maxH === undefined || size.h <= slot.maxH + EPSILON)
  )
}

function slotName(slot: Slot): string {
  return slot.label ?? `slot "${slot.id}"`
}

export interface PackItem {
  /** The caller's key, usually the placed device's id; echoed back in the result. */
  id: string
  device: Device
  /** Keep this orientation (when the slot allows it) instead of choosing one. */
  orientation?: Orientation
}

export interface PackedDevice {
  /** The `PackItem` id. */
  id: string
  /** Catalog device id. */
  deviceId: string
  /** Left edge from the slot's origin. */
  xMm: number
  orientation: Orientation
}

export interface PackResult {
  ok: boolean
  positions: PackedDevice[]
  /** `PackItem` ids that found no room (or that the slot does not accept). */
  overflowIds: string[]
}

/**
 * Packs devices left to right in input order with `gapMm` between neighbours, each in the first
 * allowed orientation that still fits the remaining width. Devices that do not fit are skipped
 * (later, narrower ones may still fit). A fixed slot holds one device.
 */
export function packAreaSlot(
  items: readonly PackItem[],
  slot: Slot,
  gapMm = DEVICE_GAP_MM,
): PackResult {
  const capacity = slot.kind === 'fixed' ? 1 : Number.POSITIVE_INFINITY
  const positions: PackedDevice[] = []
  const overflowIds: string[] = []
  let xMm = 0
  for (const item of items) {
    const orientation =
      positions.length < capacity ? packOrientation(item, slot, slot.maxW - xMm) : undefined
    if (orientation === undefined) {
      overflowIds.push(item.id)
      continue
    }
    positions.push({ id: item.id, deviceId: item.device.id, xMm, orientation })
    xMm += orientedDims(item.device.dims, orientation).w + gapMm
  }
  return { ok: overflowIds.length === 0, positions, overflowIds }
}

function packOrientation(item: PackItem, slot: Slot, widthLeftMm: number): Orientation | undefined {
  if (!slotAccepts(slot, item.device)) return undefined
  const wanted = item.orientation
  const choices =
    wanted !== undefined && slot.orientations.includes(wanted) ? [wanted] : slot.orientations
  return choices.find((orientation) =>
    fitsSlot(orientedDims(item.device.dims, orientation), slot, widthLeftMm),
  )
}

// ---------------------------------------------------------------------------------------------
// Edits

export interface PlacementTarget {
  y?: number
  face?: Face
  bay?: PlacementBay
}

/**
 * Adds a placement for a catalog item (or ear-mounted gear) with its name and height denormalized,
 * as planned (Need). The spot is not validated: check it with `canPlace` first. Unknown ids leave
 * the plan as it is.
 */
export function addPlacement(
  plan: Plan,
  catalog: CatalogLookup,
  at: PlacementTarget & { itemId: string; y: number },
): { plan: Plan; placementId?: string } {
  const placeable = resolvePlaceable(withCustomEntries(catalog, plan.custom), at.itemId)
  if (placeable === undefined) return { plan }
  const face = at.face ?? placeable.faces[0] ?? 'front'
  const bay = at.bay ?? baysFor(placeable.bay)[0] ?? 'full'
  const placement = newPlacement(placeable, { y: at.y, face, bay })
  return {
    plan: { ...plan, placements: [...plan.placements, placement] },
    placementId: placement.id,
  }
}

/** Moves a placement (devices come along). Unknown ids and no-op moves return the same plan. */
export function movePlacement(plan: Plan, placementId: string, to: PlacementTarget): Plan {
  let changed = false
  const placements = plan.placements.map((placement) => {
    if (placement.id !== placementId) return placement
    const y = to.y ?? placement.y
    const face = to.face ?? placement.face
    const bay = to.bay ?? placement.bay
    if (y === placement.y && face === placement.face && bay === placement.bay) return placement
    changed = true
    return { ...placement, y, face, bay }
  })
  return changed ? { ...plan, placements } : plan
}

export interface DuplicateOptions extends PlacementTarget {
  /** Resolves the original's height, which puts the copy right above it. */
  catalog?: CatalogLookup
}

/**
 * Copies a placement with new ids, reset to Need (the copy and its devices are not owned). The
 * copy goes right above the original unless `y` is given; check the spot with `canPlace`.
 */
export function duplicatePlacement(
  plan: Plan,
  placementId: string,
  options: DuplicateOptions = {},
): { plan: Plan; placementId?: string } {
  const index = plan.placements.findIndex((placement) => placement.id === placementId)
  const original = plan.placements[index]
  if (original === undefined) return { plan }
  const catalog =
    options.catalog === undefined ? undefined : withCustomEntries(options.catalog, plan.custom)
  const copy: Placement = {
    ...original,
    id: newId(ID_PREFIX.placement),
    y: options.y ?? original.y + placementHeightSixths(original, catalog),
    face: options.face ?? original.face,
    bay: options.bay ?? original.bay,
    devices: original.devices.map((device) => ({
      ...device,
      id: newId(ID_PREFIX.placedDevice),
      have: false,
    })),
  }
  delete copy.have
  const placements = [
    ...plan.placements.slice(0, index + 1),
    copy,
    ...plan.placements.slice(index + 1),
  ]
  return { plan: { ...plan, placements }, placementId: copy.id }
}

/**
 * Deletes a placement. An owned one moves to `plan.retired` with its snapshot and the owned devices
 * on it; other devices go back to the equipment tray (see `removePlacements` in frame.ts).
 */
export function deletePlacement(
  plan: Plan,
  placementId: string,
  options: RemovePlacementsOptions = {},
): Plan {
  return removePlacements(plan, [placementId], options)
}
