/**
 * The mount chooser's edit against the open plan: one `applyOp` (one undo step) that puts the
 * device on the chosen mount, and the words for the live region. A device that did not come from
 * Equipment to fit goes through it in the same step (added, then placed), so placing it never
 * leaves a tray entry behind and undo takes it all back.
 */
import { HAVE_TEXT } from '@/components/common/HaveNeed'
import { markPlacement } from '@/domain/build'
import { addEquipment, placeEquipmentOnMount } from '@/domain/devices'
import { deviceName, type CatalogLookup } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import { usePlanStore, type PlanOp } from '@/state/planStore'
import { isRecording } from '@/state/uiStore'
import { applyPlanOp, sparesText, type SpareContext } from '../inspector/planOps'
import { positionText } from '../rack/labels'
import type { ChooserOption } from './chooserModel'
import type { MountChooserRequest } from './mountDialogsStore'

export interface MountOutcome {
  ok: boolean
  /** What happened, for the live region. */
  message: string
  /** The new placement (on success). */
  placementId?: string
}

function failure(message: string): MountOutcome {
  return { ok: false, message }
}

/** The tray entry to place: the request's own, or a new one for a device from elsewhere. */
function trayEntry(
  plan: Plan,
  request: MountChooserRequest,
  have: boolean,
): { plan: Plan; equipmentId: string } | string {
  if (request.equipmentId !== undefined) {
    const entry = plan.equipment.find((candidate) => candidate.id === request.equipmentId)
    if (entry === undefined) return 'It is no longer waiting in Equipment to fit.'
    return { plan, equipmentId: entry.id }
  }
  const added = addEquipment(plan, request.deviceId, have)
  const entry = added.equipment.at(-1)
  if (added === plan || entry === undefined)
    return `"${request.deviceId}" is not a valid device id.`
  return { plan: added, equipmentId: entry.id }
}

/**
 * Puts the requested device on `option` at its spot, as one undo step: a device from the palette
 * first joins Equipment to fit (In my rack while recording, else To get), then
 * `placeEquipmentOnMount` builds the mount around it (or places ear-mounted gear itself). In
 * Recording mode the new placement is marked In my rack too, using up loose spares like every
 * other build.
 */
export function placeOnChosenMount(
  catalog: CatalogLookup,
  request: MountChooserRequest,
  option: ChooserOption,
  spares?: SpareContext,
): MountOutcome {
  const state = usePlanStore.getState()
  const open = state.plan
  if (open === null) return failure('No plan is open.')
  if (state.readOnly) return failure('This plan is read-only: it was made with a newer version.')
  const frame = catalog.frame(open.frame.frameId)
  if (frame === undefined)
    return failure(`The frame "${open.frame.frameId}" is not in the catalog.`)
  const device = catalog.device(request.deviceId)
  const name = device === undefined ? request.deviceId : deviceName(device)
  const spot = option.spot
  if (spot === null) return failure(`There is no free spot for ${option.name}.`)

  const recording = isRecording(state.planId)
  const at = new Date().toISOString()
  let placementId: string | undefined
  const op: PlanOp = (current) => {
    const tray = trayEntry(current, request, recording)
    if (typeof tray === 'string') return { plan: current, conflicts: [], error: tray }
    const placed = placeEquipmentOnMount(
      tray.plan,
      catalog,
      frame,
      tray.equipmentId,
      option.itemId,
      spot.y,
      spot.face,
      { bay: spot.bay, at },
    )
    if (placed.error !== undefined || placed.placementId === undefined) {
      return { plan: current, conflicts: [], error: placed.error ?? `${name} was not placed.` }
    }
    placementId = placed.placementId
    const next = recording
      ? markPlacement(placed.plan, placementId, true, at, catalog)
      : placed.plan
    return { plan: next, conflicts: [] }
  }
  const result =
    spares === undefined
      ? { ...usePlanStore.getState().applyOp(op), sparesUsed: 0 }
      : applyPlanOp(op, spares)
  if (!result.applied || placementId === undefined) {
    return failure(`Could not place ${name}: ${result.error ?? 'nothing changed.'}`)
  }
  const where = positionText(spot.y, option.heightSixths)
  const how = option.kind === 'own-ears' ? ' with its own ears' : ` on ${option.name}`
  const half = spot.bay === 'full' ? '' : ` (${spot.bay} half)`
  const rear = spot.face === 'rear' ? ' on the rear' : ''
  const owned = recording ? `, marked ${HAVE_TEXT}` : ''
  return {
    ok: true,
    message: `Placed ${name}${how} at ${where}${half}${rear}${owned}.${sparesText(result.sparesUsed)}`,
    placementId,
  }
}

/** The new placement on the rack, focused (so the arrow keys move it); false when it is not shown. */
export function focusPlacement(placementId: string): boolean {
  const node = [...document.querySelectorAll<SVGElement | HTMLElement>('[data-placement-id]')].find(
    (candidate) => candidate.getAttribute('data-placement-id') === placementId,
  )
  if (node === undefined) return false
  node.focus({ preventScroll: true })
  return document.activeElement === node
}
