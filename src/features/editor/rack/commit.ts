/**
 * The rack view's edits against the open plan: each runs one `usePlanStore.applyOp` (one undo
 * step) and returns a message for the live region. The rules live in `placeActions.ts` (pure) and
 * the domain; this file only reads the stores and words the results. Section inserts from the +
 * handles go through the inspector's stack operations (`inspector/sectionOps.ts`), so both share
 * one conflict dialog.
 */
import { HAVE_TEXT, NEED_TEXT } from '@/components/common/HaveNeed'
import type { StackConflict } from '@/domain/api'
import { assignDevice, assignEquipment } from '@/domain/devices'
import { placementHeightSixths, placementName } from '@/domain/frame'
import { deletePlacement, movePlacement } from '@/domain/placement'
import {
  deviceName,
  withCustomEntries,
  type CatalogLookup,
  type Frame,
} from '@/domain/schema/catalog'
import type { PlacementBay, Plan } from '@/domain/schema/plan'
import { usePlanStore, type PlanOp } from '@/state/planStore'
import { isRecording } from '@/state/uiStore'
import type { PlaceSource } from '../editorState'
import { applyPlanOp, sparesText, type SpareContext } from '../inspector/planOps'
import { positionText } from './labels'
import {
  buildDuplicate,
  buildPlacement,
  checkMove,
  checkMoveTo,
  checkSpot,
  describeSource,
  duplicateSpot,
  placementPhases,
  stepTarget,
  type Spot,
} from './placeActions'

export const READ_ONLY_MESSAGE = 'This plan is read-only: it was made with a newer version.'

export interface Outcome {
  ok: boolean
  /** What happened, for the live region (and toasts). */
  message: string
  /** The placement or section the action created. */
  createdId?: string
  /** Nothing needed to change (a part released where it already was). */
  unchanged?: boolean
}

function nowIso(): string {
  return new Date().toISOString()
}

interface Open {
  plan: Plan
  frame: Frame
  planId: string | null
}

/** The open, editable plan and its frame, or the reason there is none. */
function openPlan(catalog: CatalogLookup): Open | string {
  const state = usePlanStore.getState()
  if (state.plan === null) return 'No plan is open.'
  if (state.readOnly) return READ_ONLY_MESSAGE
  const frame = catalog.frame(state.plan.frame.frameId)
  if (frame === undefined) return `The frame "${state.plan.frame.frameId}" is not in the catalog.`
  return { plan: state.plan, frame, planId: state.planId }
}

function failure(message: string): Outcome {
  return { ok: false, message }
}

function conflictText(conflicts: readonly StackConflict[]): string {
  return conflicts.map((conflict) => conflict.message).join(' ')
}

/**
 * Applies an edit that may build something (In my rack in Recording mode): with the live spares,
 * the loose spares it installs come out of the inventory in the same action, as everywhere else.
 */
function applyBuilding(op: PlanOp, spares: SpareContext | undefined) {
  return spares === undefined
    ? { ...usePlanStore.getState().applyOp(op), sparesUsed: 0 }
    : applyPlanOp(op, spares)
}

// ---------------------------------------------------------------------------------------------
// Placing

/**
 * Places what the palette or tray is placing at a spot. In Recording mode the new placement is
 * marked as in the user's rack in the same step.
 */
export function placeAt(
  catalog: CatalogLookup,
  source: PlaceSource,
  spot: Spot,
  spares?: SpareContext,
): Outcome {
  const open = openPlan(catalog)
  if (typeof open === 'string') return failure(open)
  const { plan, frame, planId } = open
  const info = describeSource(plan, catalog, frame, source)
  const where = positionText(spot.y, info.heightSixths)
  const check = checkSpot(plan, catalog, frame, info, spot)
  if (!check.ok) {
    return failure(`${info.name} can't go at ${where}: ${check.reasons[0] ?? 'it does not fit.'}`)
  }
  // Owned gear from the tray keeps its Have (the domain carries it over).
  const have = isRecording(planId)
  let createdId: string | undefined
  const result = applyBuilding((current) => {
    const built = buildPlacement(current, catalog, frame, { source, spot, have, at: nowIso() })
    createdId = built.placementId
    return built
  }, spares)
  if (!result.applied) {
    return failure(
      result.error ?? (conflictText(result.conflicts) || `${info.name} was not placed.`),
    )
  }
  const half = spot.bay === 'full' ? '' : ` (${spot.bay} half)`
  const rear = spot.face === 'rear' ? ' on the rear' : ''
  const owned = have ? `, marked ${HAVE_TEXT}` : ''
  return {
    ok: true,
    message: `Placed ${info.name} at ${where}${half}${rear}${owned}.${sparesText(result.sparesUsed)}`,
    ...(createdId === undefined ? {} : { createdId }),
  }
}

// ---------------------------------------------------------------------------------------------
// Placed items

function findPlacement(plan: Plan, placementId: string) {
  return plan.placements.find((placement) => placement.id === placementId)
}

/** Moves a placement by `steps` of its allowed start positions; blocked moves change nothing. */
export function movePlacementBy(
  catalog: CatalogLookup,
  placementId: string,
  direction: 1 | -1,
  steps: number,
): Outcome {
  const open = openPlan(catalog)
  if (typeof open === 'string') return failure(open)
  const { plan, frame } = open
  const placement = findPlacement(plan, placementId)
  if (placement === undefined) return failure('That item is no longer in the rack.')
  const name = placementName(placement, catalog)
  const height = placementHeightSixths(placement, catalog)
  const y = stepTarget(placement.y, placementPhases(placement, catalog, frame), direction, steps)
  const check = checkMove(plan, catalog, frame, placement, y)
  const way = direction > 0 ? 'up' : 'down'
  if (!check.ok) return failure(`Can't move ${name} ${way}: ${check.reasons[0] ?? 'blocked.'}`)
  const result = usePlanStore
    .getState()
    .applyOp((current) => ({ plan: movePlacement(current, placementId, { y }) }))
  if (!result.applied) return failure(result.error ?? `${name} did not move.`)
  return { ok: true, message: `Moved ${name} ${way} to ${positionText(y, height)}.` }
}

/** "U5", or "U5, left half" for a half-width part. */
function whereText(y: number, heightSixths: number, bay: PlacementBay): string {
  const where = positionText(y, heightSixths)
  return bay === 'full' ? where : `${where}, ${bay} half`
}

/**
 * Moves a placement to `y` (a half-width part also to `bay`) in one step: the release of a pointer
 * drag. The same check and words as the arrow keys; blocked moves change nothing and say why.
 */
export function movePlacementTo(
  catalog: CatalogLookup,
  placementId: string,
  to: { y: number; bay?: PlacementBay },
): Outcome {
  const open = openPlan(catalog)
  if (typeof open === 'string') return failure(open)
  const { plan, frame } = open
  const placement = findPlacement(plan, placementId)
  if (placement === undefined) return failure('That item is no longer in the rack.')
  const name = placementName(placement, catalog)
  const height = placementHeightSixths(placement, catalog)
  const bay = placement.bay === 'full' ? 'full' : (to.bay ?? placement.bay)
  const where = whereText(to.y, height, bay)
  if (to.y === placement.y && bay === placement.bay) {
    return { ok: true, message: `${name} stays at ${where}.`, unchanged: true }
  }
  const check = checkMoveTo(plan, catalog, frame, placement, to.y, bay)
  if (!check.ok) return failure(`Can't move ${name} to ${where}: ${check.reasons[0] ?? 'blocked.'}`)
  const result = usePlanStore
    .getState()
    .applyOp((current) => ({ plan: movePlacement(current, placementId, { y: to.y, bay }) }))
  if (!result.applied) return failure(result.error ?? `${name} did not move.`)
  const way = to.y > placement.y ? ' up' : to.y < placement.y ? ' down' : ''
  return { ok: true, message: `Moved ${name}${way} to ${where}.` }
}

/** A device going into a placement's slot: from the palette, or (`equipmentId`) from the tray. */
export interface SlotRequest {
  deviceId: string
  equipmentId?: string
  placementId: string
  slotId: string
}

/**
 * Puts a device into a slot (fit-checked by the domain; area slots re-pack), as the inspector's
 * "Add device" does: a catalog device is In my rack in Recording mode; a tray device keeps its In
 * my rack / To get and leaves the tray. One step; a device that does not fit changes nothing and
 * the domain says why.
 */
export function assignToSlot(
  catalog: CatalogLookup,
  request: SlotRequest,
  spares?: SpareContext,
): Outcome {
  const open = openPlan(catalog)
  if (typeof open === 'string') return failure(open)
  const { plan, planId } = open
  const lookup = withCustomEntries(catalog, plan.custom)
  const placement = findPlacement(plan, request.placementId)
  if (placement === undefined) return failure('That item is no longer in the rack.')
  const holder = placementName(placement, lookup)
  const slot = lookup.item(placement.itemId)?.slots.find((each) => each.id === request.slotId)
  const slotText = slot?.label ?? `slot "${request.slotId}"`
  const device = lookup.device(request.deviceId)
  const name = device === undefined ? request.deviceId : deviceName(device)
  const { equipmentId } = request
  const entry =
    equipmentId === undefined
      ? undefined
      : plan.equipment.find((candidate) => candidate.id === equipmentId)
  const recording = isRecording(planId)
  const result = applyBuilding(
    (current) =>
      equipmentId === undefined
        ? assignDevice(
            current,
            lookup,
            request.placementId,
            request.slotId,
            request.deviceId,
            recording,
          )
        : assignEquipment(current, lookup, request.placementId, request.slotId, equipmentId),
    spares,
  )
  if (!result.applied) {
    return failure(result.error ?? (conflictText(result.conflicts) || `The ${name} did not go in.`))
  }
  if (entry !== undefined) {
    return {
      ok: true,
      message: `Moved the ${name} from Equipment to fit into ${slotText} of ${holder} (${entry.have ? HAVE_TEXT : NEED_TEXT}).${sparesText(result.sparesUsed)}`,
    }
  }
  const owned = recording ? `, marked ${HAVE_TEXT}` : ''
  return {
    ok: true,
    message: `Added the ${name} to ${slotText} of ${holder}${owned}.${sparesText(result.sparesUsed)}`,
  }
}

/**
 * Removes a placement. One the user owns is kept under Retired (see `deletePlacement`), and
 * planned devices on it go back to the equipment tray.
 */
export function removePlacement(catalog: CatalogLookup, placementId: string): Outcome {
  const open = openPlan(catalog)
  if (typeof open === 'string') return failure(open)
  const placement = findPlacement(open.plan, placementId)
  if (placement === undefined) return failure('That item is no longer in the rack.')
  const name = placementName(placement, catalog)
  const where = positionText(placement.y, placementHeightSixths(placement, catalog))
  const result = usePlanStore
    .getState()
    .applyOp((current) => ({ plan: deletePlacement(current, placementId, { at: nowIso() }) }))
  if (!result.applied) return failure(result.error ?? `${name} was not removed.`)
  const owned = placement.have === undefined ? '' : ' You have it, so it is kept under Retired.'
  return { ok: true, message: `Removed ${name} from ${where}.${owned}` }
}

/** Copies a placement to the nearest free spot above it (else below); see `duplicateSpot`. */
export function duplicatePlacementNearby(
  catalog: CatalogLookup,
  placementId: string,
  spares?: SpareContext,
): Outcome {
  const open = openPlan(catalog)
  if (typeof open === 'string') return failure(open)
  const { plan, frame, planId } = open
  const placement = findPlacement(plan, placementId)
  if (placement === undefined) return failure('That item is no longer in the rack.')
  const name = placementName(placement, catalog)
  const spot = duplicateSpot(plan, catalog, frame, placement)
  if (spot === null) return failure(`There is no free spot for a copy of ${name}.`)
  const have = isRecording(planId)
  let createdId: string | undefined
  const result = applyBuilding((current) => {
    const built = buildDuplicate(current, catalog, placementId, spot, have, nowIso())
    createdId = built.placementId
    return built
  }, spares)
  if (!result.applied) return failure(result.error ?? `${name} was not copied.`)
  const where = positionText(spot.y, placementHeightSixths(placement, catalog))
  return {
    ok: true,
    message: `Duplicated ${name} to ${where}.${sparesText(result.sparesUsed)}`,
    ...(createdId === undefined ? {} : { createdId }),
  }
}
