/**
 * Tray entries as targets of checks (M3b): a check on a tray device (an unknown device in
 * Equipment to fit) selects it like any part, and `focusEquipmentEntry` puts it in view: its row
 * in the tray (marked `data-equipment-id`) takes focus, after the tray's sheet opens below lg.
 */
import { usePlanStore } from '@/state/planStore'
import { openSheet, panelDomId } from '../layout/shellStore'

/** The attribute on each tray row: the equipment entry's id. */
export const EQUIPMENT_ID_ATTRIBUTE = 'data-equipment-id'

/** Frames to wait for a sheet to open and its focus to settle before giving up. */
const MAX_WAIT_FRAMES = 60
/** Focus has to stay on the row this many frames (a sheet moves focus in when it opens). */
const SETTLE_FRAMES = 3

/** Whether `id` is an entry of the open plan's Equipment to fit. */
export function isEquipmentEntry(id: string): boolean {
  return usePlanStore.getState().plan?.equipment.some((entry) => entry.id === id) ?? false
}

/** The tray row of an entry, when the tray is on screen. */
export function equipmentRow(equipmentId: string): HTMLElement | null {
  const panel = document.getElementById(panelDomId('equipment'))
  if (panel === null) return null
  const rows = panel.querySelectorAll<HTMLElement>(`[${EQUIPMENT_ID_ATTRIBUTE}]`)
  return [...rows].find((row) => row.getAttribute(EQUIPMENT_ID_ATTRIBUTE) === equipmentId) ?? null
}

function focusRow(row: HTMLElement): boolean {
  row.focus({ preventScroll: true })
  row.scrollIntoView?.({ block: 'nearest' })
  return document.activeElement === row
}

function nextFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback())
  else setTimeout(callback, 16)
}

/** Focuses the row once it is on screen and keeps it there while a sheet settles. */
function focusWhenShown(equipmentId: string): void {
  let waited = 0
  let settled = 0
  const step = () => {
    waited += 1
    const row = equipmentRow(equipmentId)
    if (row !== null) {
      settled = document.activeElement === row || focusRow(row) ? settled + 1 : 0
      if (settled >= SETTLE_FRAMES) return
    }
    if (waited < MAX_WAIT_FRAMES) nextFrame(step)
  }
  nextFrame(step)
}

/**
 * Shows a tray entry: focuses its row in Equipment to fit, opening the tray's sheet first when
 * the tray is not on screen (below lg). For the Checks panel, after `selectInEditor([id])`. False
 * (and nothing happens) when `equipmentId` is not a tray entry of the open plan.
 */
export function focusEquipmentEntry(equipmentId: string): boolean {
  if (!isEquipmentEntry(equipmentId)) return false
  const row = equipmentRow(equipmentId)
  if (row !== null) {
    focusRow(row)
    return true
  }
  openSheet('equipment')
  focusWhenShown(equipmentId)
  return true
}
