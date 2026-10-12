/**
 * What a drag onto the rack carries, and the gesture constants. Pure and free of dnd-kit at
 * runtime: `@dnd-kit/dom` needs a real browser (ResizeObserver) as soon as it loads, so only the
 * lazily loaded drag host (`rackDndHost.tsx`) imports it.
 */
import type { Face } from '@/domain/schema/common'
import type { PlaceSource } from '../editorState'

/** The dnd-kit `type` of every drag source the rack accepts (palette rows and tray rows). */
export const RACK_PART_DRAG_TYPE = 'rack-part'

/** A touch press this long starts a drag (a palette row, or a placed part on the rack). */
export const LONG_PRESS_MS = 250
/** A mouse or pen moves a placed part (or pans) after this much movement. */
export const MOUSE_DRAG_SLOP_PX = 4
/** A finger moving this far before the long-press fires is a swipe: it pans instead. */
export const TOUCH_SLOP_PX = 8
/** Mouse and pen start a palette drag after this much movement (no hold, so clicks stay clicks). */
export const PALETTE_DRAG_DISTANCE_PX = 5
/** Finger movement allowed during the palette long-press (more scrolls the palette). */
export const PALETTE_TOUCH_TOLERANCE_PX = 5

/** The droppable id of a rack face's viewport. */
export function faceDroppableId(face: Face): string {
  return `face:${face}`
}

/**
 * A palette row or a tray row on the move:
 * - `item`: a mount, panel or shelf (catalog or one of the user's own parts);
 * - `device`: a device from the palette, or (with `equipmentId`) one waiting in Equipment to fit.
 *   On a slot it goes in; ear-mounted gear (`rackmount`) on empty space is placed directly; any
 *   other device on empty space opens the mount chooser.
 */
export type DragSubject =
  { kind: 'item'; itemId: string } | { kind: 'device'; deviceId: string; equipmentId?: string }

/** The `data` every rack drag source carries. */
export interface RackDragData {
  subject: DragSubject
  [key: string]: unknown
}

/** The dnd-kit id of a drag source (unique per palette row and per tray entry). */
export function dragSourceId(subject: DragSubject): string {
  if (subject.kind === 'item') return `palette:item:${subject.itemId}`
  return subject.equipmentId === undefined
    ? `palette:device:${subject.deviceId}`
    : `tray:${subject.equipmentId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** The subject in a drag source's `data` (dnd-kit types it loosely), or null. */
export function subjectOfData(data: unknown): DragSubject | null {
  if (!isRecord(data) || !isRecord(data.subject)) return null
  const subject = data.subject
  if (subject.kind === 'item' && nonEmpty(subject.itemId)) {
    return { kind: 'item', itemId: subject.itemId }
  }
  if (subject.kind === 'device' && nonEmpty(subject.deviceId)) {
    return nonEmpty(subject.equipmentId)
      ? { kind: 'device', deviceId: subject.deviceId, equipmentId: subject.equipmentId }
      : { kind: 'device', deviceId: subject.deviceId }
  }
  return null
}

/** The subject of a dnd-kit drag source, when it is one of ours. */
export function subjectOfSource(
  source: { type?: unknown; data?: unknown } | null | undefined,
): DragSubject | null {
  if (source === null || source === undefined || source.type !== RACK_PART_DRAG_TYPE) return null
  return subjectOfData(source.data)
}

/** What click-to-place would place for a subject (an item, or a device on its own ears). */
export function placeSourceOf(subject: DragSubject): PlaceSource {
  if (subject.kind === 'item') return { kind: 'item', itemId: subject.itemId }
  return subject.equipmentId === undefined
    ? { kind: 'device', deviceId: subject.deviceId }
    : { kind: 'device', deviceId: subject.deviceId, equipmentId: subject.equipmentId }
}
