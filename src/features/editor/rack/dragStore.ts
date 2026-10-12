/**
 * What is being dragged onto or around the rack right now: the palette or tray row being carried,
 * where it would land (the ghost) and the placed part being moved. Not persisted, not undoable,
 * and never part of the plan: nothing is written until a gesture ends.
 *
 * A store rather than component state so the drawing's ghost layer, the drag chip in the overlay
 * and the drag sources each subscribe to just what they show; the rack itself does not re-render
 * while the ghost follows the pointer.
 */
import { create } from 'zustand'
import type { Face } from '@/domain/schema/common'
import type { PlacementBay } from '@/domain/schema/plan'
import type { DragSubject } from './dragSubject'
import type { Box } from './rackLayout'

/** Fits / cannot go there / asks for a mount (icon and words differ too, never colour only). */
export type GhostStatus = 'ok' | 'blocked' | 'choose'

export interface DragGhost {
  /** A palette or tray drop, or a placed part being moved. */
  origin: 'drop' | 'move'
  /** A span of U's on the rails, or a device slot inside a placement. */
  kind: 'span' | 'slot'
  face: Face
  /** The span it would take (sixths): where it lands, or the slot's holder. */
  y: number
  heightSixths: number
  bay: PlacementBay
  status: GhostStatus
  /** "Fits at U5–U6", the reason it cannot go there, "Goes in Mini PC of …", "Choose a mount…". */
  text: string
  /** A slot target's zone (drawing units) and ids. */
  box?: Box
  placementId?: string
  slotId?: string
}

/** What the drag chip says under the carried part's name. */
export interface CarryStatus {
  /** `idle`: not over the rack yet. */
  tone: GhostStatus | 'idle'
  text: string
}

/** The chip's words before the pointer reaches the rack. */
export const CARRY_IDLE: CarryStatus = { tone: 'idle', text: 'Drop it on the rack' }

interface RackDragState {
  /** The palette or tray row being carried (null when there is none). */
  subject: DragSubject | null
  /** Its dnd-kit id, so the row can dim itself. */
  sourceId: string | null
  ghost: DragGhost | null
  /** The drag chip's status line while carrying. */
  status: CarryStatus | null
  /** The carried part is over the rack's visible viewport (the rack highlights itself). */
  over: boolean
  /** The placed part a pointer gesture is moving (drawn dimmed where it is). */
  movingId: string | null
}

const INITIAL: RackDragState = {
  subject: null,
  sourceId: null,
  ghost: null,
  status: null,
  over: false,
  movingId: null,
}

export const useRackDrag = create<RackDragState>()(() => INITIAL)

function sameBox(a: Box | undefined, b: Box | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export function sameGhost(a: DragGhost | null, b: DragGhost | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.origin === b.origin &&
    a.kind === b.kind &&
    a.face === b.face &&
    a.y === b.y &&
    a.heightSixths === b.heightSixths &&
    a.bay === b.bay &&
    a.status === b.status &&
    a.text === b.text &&
    a.placementId === b.placementId &&
    a.slotId === b.slotId &&
    sameBox(a.box, b.box)
  )
}

/** Shows (or hides, with null) the ghost; an equal ghost changes nothing. */
export function setDragGhost(ghost: DragGhost | null): void {
  if (sameGhost(useRackDrag.getState().ghost, ghost)) return
  useRackDrag.setState({ ghost })
}

/** Sets the chip's status line; an equal status changes nothing. */
export function setCarryStatus(status: CarryStatus | null): void {
  const current = useRackDrag.getState().status
  if (current === status) return
  if (current !== null && status !== null && current.tone === status.tone) {
    if (current.text === status.text) return
  }
  useRackDrag.setState({ status })
}

export function setCarryOver(over: boolean): void {
  if (useRackDrag.getState().over !== over) useRackDrag.setState({ over })
}

export function startCarrying(subject: DragSubject, sourceId: string): void {
  useRackDrag.setState({ subject, sourceId, ghost: null, status: CARRY_IDLE, over: false })
}

export function stopCarrying(): void {
  useRackDrag.setState({ subject: null, sourceId: null, ghost: null, status: null, over: false })
}

export function setMovingPlacement(placementId: string | null): void {
  if (useRackDrag.getState().movingId === placementId) return
  useRackDrag.setState({ movingId: placementId })
}

export function resetRackDrag(): void {
  useRackDrag.setState(INITIAL)
}
