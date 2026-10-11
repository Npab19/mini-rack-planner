/**
 * The rack view's edits, composed from domain operations. Pure: (plan, catalog, frame, request)
 * in, results out; the components commit them through `usePlanStore.applyOp`, one undo step each.
 *
 * Click-to-place, "Add at U…", keyboard moves and duplicates all go through these functions, so
 * they give the same answers and the same messages.
 */
import type { StackOpResult } from '@/domain/api'
import { markPlacement, markPlacementDevice } from '@/domain/build'
import { placeEquipmentOnMount } from '@/domain/devices'
import { placementHeightSixths, totalHeightSixths } from '@/domain/frame'
import { phaseOf, SIXTHS_PER_U } from '@/domain/geometry'
import {
  addPlacement,
  allowedPhases,
  canPlace,
  duplicatePlacement,
  fitDeviceInSlot,
  resolvePlaceable,
  snapY,
  type Placeable,
} from '@/domain/placement'
import {
  deviceName,
  withCustomEntries,
  type CatalogLookup,
  type Frame,
} from '@/domain/schema/catalog'
import type { Face } from '@/domain/schema/common'
import type { PlacedDevice, Placement, PlacementBay, Plan } from '@/domain/schema/plan'
import type { PlaceSource } from '../editorState'

export interface Spot {
  y: number
  face: Face
  bay: PlacementBay
}

export interface SpotCheck {
  ok: boolean
  /** User-facing reasons it cannot go there (empty when ok). */
  reasons: string[]
}

// ---------------------------------------------------------------------------------------------
// What is being placed

export interface SourceInfo {
  source: PlaceSource
  /** The catalog id the new placement's `itemId` holds (an item, or ear-mounted gear). */
  itemId: string
  name: string
  placeable?: Placeable
  /** Height in sixths (at least 1 for drawing and centring). */
  heightSixths: number
  /** Allowed start phases (y mod 6), ascending. */
  phases: number[]
  faces: readonly Face[]
  /** Half-width: it goes in the left or the right bay. */
  half: boolean
  /** Why it cannot be placed on the rails at all. */
  problem?: string
  /** Devices to account for when checking a spot (the tray device going onto the mount). */
  devices: PlacedDevice[]
}

/** The catalog id a source places. */
export function sourceItemId(source: PlaceSource): string {
  return source.kind === 'item' ? source.itemId : source.deviceId
}

/** A key that changes whenever the source does (for caches). */
export function sourceKey(source: PlaceSource): string {
  return `${source.kind}:${sourceItemId(source)}:${source.equipmentId ?? ''}`
}

function unplaceable(source: PlaceSource, name: string, problem: string): SourceInfo {
  return {
    source,
    itemId: sourceItemId(source),
    name,
    heightSixths: SIXTHS_PER_U,
    phases: [0],
    faces: ['front', 'rear'],
    half: false,
    problem,
    devices: [],
  }
}

/** Facts about what is being placed, or the reason it cannot be placed on the rails. */
export function describeSource(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  source: PlaceSource,
): SourceInfo {
  const lookup = withCustomEntries(catalog, plan.custom)
  if (source.kind === 'device') {
    const device = lookup.device(source.deviceId)
    if (device === undefined) {
      return unplaceable(source, source.deviceId, `"${source.deviceId}" is not in the catalog.`)
    }
    if (device.rackmount === undefined) {
      const name = deviceName(device)
      return unplaceable(
        source,
        name,
        `The ${name} does not mount on the rails by itself: place a mount for it instead.`,
      )
    }
  }
  const itemId = sourceItemId(source)
  const placeable = resolvePlaceable(lookup, itemId)
  if (placeable === undefined) {
    const item = lookup.item(itemId)
    const problem =
      item?.kind === 'extra'
        ? `${item.name} is an accessory: it does not take rack space.`
        : `"${itemId}" is not in the catalog.`
    return unplaceable(source, item?.name ?? itemId, problem)
  }
  const devices =
    source.kind === 'item' && source.equipmentId !== undefined
      ? trayDevices(plan, lookup, placeable, source.equipmentId)
      : []
  const { phases } = allowedPhases(placeable, frame)
  return {
    source,
    itemId,
    name: placeable.name,
    placeable,
    heightSixths: Math.max(placeable.heightSixths, 1),
    phases,
    faces: placeable.faces,
    half: placeable.bay === 'half',
    ...(phases.length === 0
      ? {
          problem: `${placeable.name}'s holes do not line up with the ${frame.name} rail anywhere.`,
        }
      : {}),
    devices,
  }
}

/** The tray device in the first slot of the mount that takes it (for shelf heights). */
function trayDevices(
  plan: Plan,
  catalog: CatalogLookup,
  placeable: Placeable,
  equipmentId: string,
): PlacedDevice[] {
  const entry = plan.equipment.find((candidate) => candidate.id === equipmentId)
  const device = entry === undefined ? undefined : catalog.device(entry.deviceId)
  if (entry === undefined || device === undefined) return []
  for (const slot of placeable.slots) {
    const fit = fitDeviceInSlot(device, slot)
    if (!fit.ok) continue
    return [
      {
        id: `${entry.id}-preview`,
        deviceId: device.id,
        slotId: slot.id,
        ...(fit.orientation === undefined ? {} : { orientation: fit.orientation }),
        have: entry.have,
      },
    ]
  }
  return []
}

/** The spot nearest to a pointer: the snapped start, the face shown and (half width) a bay. */
export function spotAt(
  info: SourceInfo,
  rawStartSixths: number,
  face: Face,
  pointerBay: 'left' | 'right',
): Spot {
  return { y: snapY(rawStartSixths, info.phases), face, bay: info.half ? pointerBay : 'full' }
}

export function checkSpot(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  info: SourceInfo,
  spot: Spot,
): SpotCheck {
  if (info.problem !== undefined) return { ok: false, reasons: [info.problem] }
  const check = canPlace(plan, catalog, frame, {
    itemId: info.itemId,
    y: spot.y,
    face: spot.face,
    bay: spot.bay,
    devices: info.devices,
  })
  return { ok: check.ok, reasons: check.reasons.map((reason) => reason.message) }
}

/** Every start inside the stack at an allowed phase, bottom to top. */
function startsInStack(
  phases: readonly number[],
  heightSixths: number,
  topSixths: number,
): number[] {
  const ys: number[] = []
  for (let base = 0; base < topSixths; base += SIXTHS_PER_U) {
    for (const phase of phases) {
      const y = base + phase
      if (y + heightSixths <= topSixths) ys.push(y)
    }
  }
  return ys
}

/** Every spot on `face` where the source fits, bottom to top (left before right). */
export function validSpots(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  info: SourceInfo,
  face: Face,
): Spot[] {
  if (info.problem !== undefined || !info.faces.includes(face)) return []
  const top = totalHeightSixths(plan, frame)
  const bays: PlacementBay[] = info.half ? ['left', 'right'] : ['full']
  const spots: Spot[] = []
  for (const y of startsInStack(info.phases, info.heightSixths, top)) {
    for (const bay of bays) {
      const spot = { y, face, bay }
      if (checkSpot(plan, catalog, frame, info, spot).ok) spots.push(spot)
    }
  }
  return spots
}

/**
 * Where the keyboard ghost starts: the lowest spot where the source fits on `face`, else the
 * bottom of the rack (whose reason then says why).
 */
export function firstSpot(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  info: SourceInfo,
  face: Face,
): Spot {
  const bays: PlacementBay[] = info.half ? ['left', 'right'] : ['full']
  if (info.problem === undefined && info.faces.includes(face)) {
    const top = totalHeightSixths(plan, frame)
    for (const y of startsInStack(info.phases, info.heightSixths, top)) {
      for (const bay of bays) {
        const spot = { y, face, bay }
        if (checkSpot(plan, catalog, frame, info, spot).ok) return spot
      }
    }
  }
  return { y: snapY(0, info.phases), face, bay: bays[0] ?? 'full' }
}

/**
 * The keyboard ghost moved by up to `steps` allowed starts (as far as the stack allows); null
 * when it cannot move at all (already at the top or the bottom).
 */
export function steppedSpot(
  spot: Spot,
  info: Pick<SourceInfo, 'phases' | 'heightSixths'>,
  topSixths: number,
  direction: 1 | -1,
  steps: number,
): Spot | null {
  let y = spot.y
  let moved = false
  for (let step = 0; step < steps; step++) {
    const next = stepTarget(y, info.phases, direction, 1)
    if (next < 0 || next + info.heightSixths > topSixths) break
    y = next
    moved = true
  }
  return moved ? { ...spot, y } : null
}

// ---------------------------------------------------------------------------------------------
// Moving and copying placements

/** Allowed start phases of a placed item (from its height when the catalog does not know it). */
export function placementPhases(
  placement: Placement,
  catalog: CatalogLookup,
  frame: Frame,
): number[] {
  const placeable = resolvePlaceable(catalog, placement.itemId)
  const heightSixths = placementHeightSixths(placement, catalog)
  return allowedPhases(placeable ?? { heightSixths, mount: { front: 0, rear: 0 } }, frame).phases
}

/** The start `steps` allowed positions above (`direction` 1) or below (-1) `y`. */
export function stepTarget(
  y: number,
  phases: readonly number[],
  direction: 1 | -1,
  steps: number,
): number {
  const allowed = phases.length > 0 ? phases : [0]
  let current = y
  for (let step = 0; step < steps; step++) {
    let next = current + direction
    for (let guard = 0; guard < SIXTHS_PER_U && !allowed.includes(phaseOf(next)); guard++) {
      next += direction
    }
    current = next
  }
  return current
}

/** Whether a placement can move to `y` (it never blocks itself). */
export function checkMove(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  placement: Placement,
  y: number,
): SpotCheck {
  const check = canPlace(plan, catalog, frame, {
    itemId: placement.itemId,
    y,
    face: placement.face,
    bay: placement.bay,
    ignorePlacementId: placement.id,
  })
  return { ok: check.ok, reasons: check.reasons.map((reason) => reason.message) }
}

/**
 * Where a copy of a placement goes: for a half-width item the other half of its own U first,
 * then the free start nearest above it (its own half first), else the nearest below it. Null
 * when there is no room.
 */
export function duplicateSpot(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  placement: Placement,
): Spot | null {
  const heightSixths = Math.max(placementHeightSixths(placement, catalog), 1)
  const phases = placementPhases(placement, catalog, frame)
  const starts = startsInStack(phases, heightSixths, totalHeightSixths(plan, frame))
  const bays: PlacementBay[] =
    placement.bay === 'full'
      ? ['full']
      : [placement.bay, placement.bay === 'left' ? 'right' : 'left']
  const candidates: Array<{ y: number; bay: PlacementBay }> = [
    ...bays.slice(1).map((bay) => ({ y: placement.y, bay })),
    ...starts.filter((y) => y > placement.y).flatMap((y) => bays.map((bay) => ({ y, bay }))),
    ...starts
      .filter((y) => y < placement.y)
      .toReversed()
      .flatMap((y) => bays.map((bay) => ({ y, bay }))),
  ]
  for (const { y, bay } of candidates) {
    const check = canPlace(plan, catalog, frame, {
      itemId: placement.itemId,
      y,
      face: placement.face,
      bay,
      devices: placement.devices,
    })
    if (check.ok) return { y, face: placement.face, bay }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Building the operations

export interface PlaceResult extends StackOpResult {
  /** The new placement (on success). */
  placementId?: string
}

export interface PlaceRequest {
  source: PlaceSource
  spot: Spot
  /** Mark the new placement as in the user's rack (Recording mode, or owned gear from the tray). */
  have: boolean
  /** Snapshot time for `have` (ISO date-time). */
  at: string
}

/** The id of a placement `after` has and `before` does not. */
export function addedPlacementId(before: Plan, after: Plan): string | undefined {
  const old = new Set(before.placements.map((placement) => placement.id))
  return after.placements.find((placement) => !old.has(placement.id))?.id
}

/** The id of a section `after` has and `before` does not. */
export function addedSectionId(before: Plan, after: Plan): string | undefined {
  const old = new Set(before.frame.sections.map((section) => section.id))
  return after.frame.sections.find((section) => !old.has(section.id))?.id
}

/**
 * Adds what is being placed at a spot (not validated here: check it with `checkSpot` first):
 * - from the palette, an item or ear-mounted gear: `addPlacement` (planned, To get);
 * - from the equipment tray (`equipmentId`): `placeEquipmentOnMount`, which puts the tray device
 *   into the new mount (or makes ear-mounted gear the placement, owned when the tray entry is)
 *   and takes it off the tray;
 * then, when asked (Recording mode), marks the new placement as in the user's rack. One result,
 * so one undo step.
 */
export function buildPlacement(
  plan: Plan,
  catalog: CatalogLookup,
  frame: Frame,
  request: PlaceRequest,
): PlaceResult {
  const { source, spot } = request
  const itemId = sourceItemId(source)
  let next: Plan
  let placementId: string | undefined
  if (source.equipmentId !== undefined) {
    const result = placeEquipmentOnMount(
      plan,
      catalog,
      frame,
      source.equipmentId,
      itemId,
      spot.y,
      spot.face,
      { bay: spot.bay, at: request.at },
    )
    if (result.error !== undefined || result.conflicts.length > 0) return result
    next = result.plan
    placementId = result.placementId ?? addedPlacementId(plan, next)
  } else {
    const added = addPlacement(plan, catalog, { itemId, y: spot.y, face: spot.face, bay: spot.bay })
    placementId = added.placementId
    next = added.plan
  }
  if (placementId === undefined) {
    return { plan, conflicts: [], error: `"${itemId}" could not be added.` }
  }
  if (request.have) next = markPlacement(next, placementId, true, request.at, catalog)
  return { plan: next, conflicts: [], placementId }
}

/**
 * Copies a placement to `spot` (the copy is To get, see `duplicatePlacement`). In Recording mode
 * (`have`) the copy and its devices are marked as in the user's rack.
 */
export function buildDuplicate(
  plan: Plan,
  catalog: CatalogLookup,
  placementId: string,
  spot: Spot,
  have: boolean,
  at: string,
): PlaceResult {
  const copied = duplicatePlacement(plan, placementId, {
    y: spot.y,
    face: spot.face,
    bay: spot.bay,
    catalog,
  })
  const copyId = copied.placementId
  if (copyId === undefined) return { plan, conflicts: [], error: 'There is nothing to copy.' }
  let next = copied.plan
  if (have) {
    next = markPlacement(next, copyId, true, at, catalog)
    const copy = next.placements.find((placement) => placement.id === copyId)
    for (const device of copy?.devices ?? []) {
      next = markPlacementDevice(next, copyId, device.id, true)
    }
  }
  return { plan: next, conflicts: [], placementId: copyId }
}
