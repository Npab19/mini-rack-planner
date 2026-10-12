/**
 * What a drag would do where it is: pure (plan, catalog, drawing, pointer in drawing units) in, a
 * plan of the drop out. `useRackDnd` maps the pointer through the SVG's screen CTM first, so the
 * zoom, the pan and the page scroll never matter here.
 *
 * - A mount, panel or shelf (and ear-mounted gear on empty space) is placed exactly like
 *   click-to-place and "Add at U…": centred on the pointer, snapped to its allowed phases,
 *   checked with `canPlace` (`describeSource`, `spotAt`, `checkSpot` in placeActions.ts).
 * - A device over a placement goes into the slot under the pointer (the slot rectangles the rack
 *   draws, else the nearest one), checked with the domain's `assignDevice` / `assignEquipment`.
 * - Any other device over empty rack space asks for a mount (the mount chooser) at that U.
 * - A placed part being moved keeps the U it was grabbed by under the pointer (`grabOffsetSixths`).
 */
import { assignDevice, assignEquipment, estimateDeviceSixths } from '@/domain/devices'
import { placementHeightSixths, placementName, totalHeightSixths } from '@/domain/frame'
import { SIXTHS_PER_U, sixthsToMm } from '@/domain/geometry'
import { resolvePlaceable, snapY } from '@/domain/placement'
import { deviceName, type CatalogLookup, type Frame, type Slot } from '@/domain/schema/catalog'
import type { Face } from '@/domain/schema/common'
import type { Placement, PlacementBay, Plan } from '@/domain/schema/plan'
import type { PlaceSource } from '../editorState'
import { placeSourceOf, type DragSubject } from './dragSubject'
import { moveTargetY } from './gesture'
import { ghostText, positionText } from './labels'
import {
  checkMoveTo,
  checkSpot,
  describeSource,
  placementPhases,
  spotAt,
  type SourceInfo,
  type Spot,
  type SpotCheck,
} from './placeActions'
import { centredStart } from './pointer'
import {
  bayAtX,
  openingOriginX,
  panelBox,
  svgYOfSixths,
  type Box,
  type RackLayout,
} from './rackLayout'
import type { PlacementView } from './rackModel'

/** What a carried part is called: "Shelf 2U", "Raspberry Pi 5" (the id when unknown). */
export function subjectName(subject: DragSubject, catalog: CatalogLookup): string {
  if (subject.kind === 'item') return catalog.item(subject.itemId)?.name ?? subject.itemId
  const device = catalog.device(subject.deviceId)
  return device === undefined ? subject.deviceId : deviceName(device)
}

/** A point in the drawing: SVG user units (mm, y down) plus the rack height in sixths. */
export interface DrawingPoint {
  x: number
  y: number
  rawSixths: number
}

/** The drawing point of a rack point from `clientToRack`. */
export function drawingPoint(
  layout: RackLayout,
  rack: { xMm: number; yMm: number; rawSixths: number },
): DrawingPoint {
  return { x: rack.xMm, y: layout.topMm - rack.yMm, rawSixths: rack.rawSixths }
}

function contains(box: Box, point: DrawingPoint, margin = 0): boolean {
  return (
    point.x >= box.x - margin &&
    point.x <= box.x + box.width + margin &&
    point.y >= box.y - margin &&
    point.y <= box.y + box.height + margin
  )
}

/** The panel a placement is drawn as. */
export function viewBox(view: PlacementView, layout: RackLayout): Box {
  return panelBox(layout, view.y, view.heightSixths, view.bay, view.face)
}

/** The placement drawn under a point (the later one in plan order is drawn on top). */
export function placementAt(
  views: readonly PlacementView[],
  layout: RackLayout,
  point: DrawingPoint,
): PlacementView | undefined {
  return views.findLast((view) => contains(viewBox(view, layout), point))
}

// ---------------------------------------------------------------------------------------------
// Slots

/** Smallest drawn height of a slot's drop zone, in mm. */
const MIN_SLOT_HEIGHT_MM = 4

export interface SlotZone {
  placementId: string
  slot: Slot
  /** "Mini PC", or 'slot "pc"' when the catalog gives it no label. */
  label: string
  /** Where the slot is drawn, in drawing units, inside the placement's panel. */
  box: Box
}

export function slotLabel(slot: Slot): string {
  return slot.label ?? `slot "${slot.id}"`
}

/**
 * The drop zones of a placement's slots: each slot's front opening (its `layout` origin, `maxW`
 * wide, `maxH` tall or up to the top of the part), clipped to the part's panel.
 */
export function slotZones(
  view: PlacementView,
  layout: RackLayout,
  catalog: CatalogLookup,
): SlotZone[] {
  const placeable = resolvePlaceable(catalog, view.placement.itemId)
  if (placeable === undefined || placeable.slots.length === 0) return []
  const panel = viewBox(view, layout)
  const originX = openingOriginX(layout, view.bay, view.face)
  const bottom = svgYOfSixths(layout, view.y)
  const nominal = sixthsToMm(view.heightSixths)
  return placeable.slots.map((slot) => {
    const left = Math.max(panel.x, originX + slot.layout.xMm)
    const right = Math.min(panel.x + panel.width, originX + slot.layout.xMm + slot.maxW)
    const floor = Math.min(bottom - slot.layout.yMm, panel.y + panel.height)
    const tall = slot.maxH ?? nominal - slot.layout.yMm
    const top = Math.max(panel.y, floor - Math.max(tall, MIN_SLOT_HEIGHT_MM))
    return {
      placementId: view.id,
      slot,
      label: slotLabel(slot),
      box: {
        x: left,
        y: Math.min(top, floor - MIN_SLOT_HEIGHT_MM),
        width: Math.max(right - left, MIN_SLOT_HEIGHT_MM),
        height: Math.max(floor - top, MIN_SLOT_HEIGHT_MM),
      },
    }
  })
}

/** The zone under a point, else the nearest one (by distance to its box). */
export function zoneAt(zones: readonly SlotZone[], point: DrawingPoint): SlotZone | undefined {
  let best: SlotZone | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const zone of zones) {
    const { box } = zone
    const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width))
    const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height))
    const gap = Math.hypot(dx, dy)
    if (gap < bestDistance) {
      best = zone
      bestDistance = gap
    }
  }
  return best
}

// ---------------------------------------------------------------------------------------------
// Drops from the palette and the tray

export interface DropContext {
  plan: Plan
  /** The open plan's lookup (its own parts included). */
  catalog: CatalogLookup
  frame: Frame
  layout: RackLayout
  face: Face
  /** The placements drawn on this face. */
  views: readonly PlacementView[]
  /** Recording mode: what is added is In my rack. */
  recording: boolean
}

export type DropPlan =
  | {
      kind: 'place'
      source: PlaceSource
      info: SourceInfo
      spot: Spot
      check: SpotCheck
    }
  | {
      kind: 'slot'
      deviceId: string
      equipmentId?: string
      deviceName: string
      holderName: string
      zone: SlotZone
      ok: boolean
      /** Why it cannot go in (the domain's words). */
      reason?: string
    }
  | {
      kind: 'chooser'
      deviceId: string
      equipmentId?: string
      deviceName: string
      face: Face
      /** Where the mount would start (sixths): the estimated mount centred on the pointer. */
      y: number
      /** The space the device needs (`estimateDeviceSixths`), for the ghost. */
      heightSixths: number
    }
  | {
      kind: 'blocked'
      reason: string
      /** The part it was dropped on, outlined. */
      box?: Box
      placementId?: string
    }

function placePlan(ctx: DropContext, source: PlaceSource, point: DrawingPoint): DropPlan {
  const info = describeSource(ctx.plan, ctx.catalog, ctx.frame, source)
  const spot = spotAt(
    info,
    centredStart(point.rawSixths, info.heightSixths),
    ctx.face,
    bayAtX(point.x, ctx.layout, ctx.face),
  )
  return {
    kind: 'place',
    source,
    info,
    spot,
    check: checkSpot(ctx.plan, ctx.catalog, ctx.frame, info, spot),
  }
}

/** What dropping `subject` at `point` would do (see the module comment). */
export function planDrop(ctx: DropContext, subject: DragSubject, point: DrawingPoint): DropPlan {
  if (subject.kind === 'item') return placePlan(ctx, placeSourceOf(subject), point)
  const device = ctx.catalog.device(subject.deviceId)
  if (device === undefined) {
    return { kind: 'blocked', reason: `"${subject.deviceId}" is not in the catalog.` }
  }
  const name = deviceName(device)
  const tray = subject.equipmentId === undefined ? {} : { equipmentId: subject.equipmentId }
  const over = placementAt(ctx.views, ctx.layout, point)
  if (over !== undefined) {
    const zone = zoneAt(slotZones(over, ctx.layout, ctx.catalog), point)
    const holderName = placementName(over.placement, ctx.catalog)
    if (zone !== undefined) {
      const result =
        subject.equipmentId === undefined
          ? assignDevice(ctx.plan, ctx.catalog, over.id, zone.slot.id, device.id, ctx.recording)
          : assignEquipment(ctx.plan, ctx.catalog, over.id, zone.slot.id, subject.equipmentId)
      return {
        kind: 'slot',
        deviceId: device.id,
        ...tray,
        deviceName: name,
        holderName,
        zone,
        ok: result.error === undefined,
        ...(result.error === undefined ? {} : { reason: result.error }),
      }
    }
    // Ear-mounted gear goes beside it (the check names what is in the way).
    if (device.rackmount !== undefined) return placePlan(ctx, placeSourceOf(subject), point)
    return {
      kind: 'blocked',
      reason: `${holderName} has no slots for devices.`,
      box: viewBox(over, ctx.layout),
      placementId: over.id,
    }
  }
  if (device.rackmount !== undefined) return placePlan(ctx, placeSourceOf(subject), point)
  const top = totalHeightSixths(ctx.plan, ctx.frame)
  if (point.rawSixths < 0 || point.rawSixths >= top) {
    return { kind: 'blocked', reason: 'That is outside the rack: drop it on a free U.' }
  }
  const needs = Math.max(estimateDeviceSixths(device, ctx.catalog, ctx.frame).sixths, SIXTHS_PER_U)
  const highest = Math.max(0, Math.floor((top - needs) / SIXTHS_PER_U) * SIXTHS_PER_U)
  const y = Math.min(Math.max(snapY(centredStart(point.rawSixths, needs), [0]), 0), highest)
  return {
    kind: 'chooser',
    deviceId: device.id,
    ...tray,
    deviceName: name,
    face: ctx.face,
    y,
    heightSixths: needs,
  }
}

/** The words a drop's ghost and the drag chip show. */
export function dropText(drop: DropPlan): string {
  switch (drop.kind) {
    case 'place':
      return ghostText({
        ok: drop.check.ok,
        reasons: drop.check.reasons,
        y: drop.spot.y,
        heightSixths: drop.info.heightSixths,
      })
    case 'slot':
      return drop.ok
        ? `Goes in ${drop.zone.label} of ${drop.holderName}`
        : (drop.reason ?? `The ${drop.deviceName} does not fit ${drop.zone.label}.`)
    case 'chooser':
      return `Choose a mount at ${positionText(drop.y, drop.heightSixths)}`
    case 'blocked':
      return drop.reason
  }
}

/** Whether dropping here does something (a blocked drop only says why). */
export function dropIsOk(drop: DropPlan): boolean {
  switch (drop.kind) {
    case 'place':
      return drop.check.ok
    case 'slot':
      return drop.ok
    case 'chooser':
      return true
    case 'blocked':
      return false
  }
}

// ---------------------------------------------------------------------------------------------
// Moving a placed part

export interface MovePlan {
  placement: Placement
  name: string
  heightSixths: number
  y: number
  bay: PlacementBay
  check: SpotCheck
}

/**
 * Where a placed part grabbed `offsetSixths` above its bottom would go with the pointer at
 * `point`: snapped to its allowed phases, in the half under the pointer for half-width parts.
 */
export function planMove(
  ctx: Pick<DropContext, 'plan' | 'catalog' | 'frame' | 'layout'>,
  placementId: string,
  offsetSixths: number,
  point: DrawingPoint,
): MovePlan | null {
  const placement = ctx.plan.placements.find((candidate) => candidate.id === placementId)
  if (placement === undefined) return null
  const phases = placementPhases(placement, ctx.catalog, ctx.frame)
  const y = moveTargetY(point.rawSixths, offsetSixths, phases)
  const bay = placement.bay === 'full' ? 'full' : bayAtX(point.x, ctx.layout, placement.face)
  return {
    placement,
    name: placementName(placement, ctx.catalog),
    heightSixths: Math.max(placementHeightSixths(placement, ctx.catalog), 1),
    y,
    bay,
    check: checkMoveTo(ctx.plan, ctx.catalog, ctx.frame, placement, y, bay),
  }
}
