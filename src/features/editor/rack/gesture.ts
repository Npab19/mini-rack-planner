/**
 * Pointer gesture maths for the rack (pure: no DOM, no React). The hooks feed it client px from
 * Pointer Events and dnd-kit; `pointer.ts` maps client px to the drawing.
 */
import { snapY } from '@/domain/placement'

export interface ClientPoint {
  x: number
  y: number
}

export interface RectLike {
  left: number
  top: number
  right: number
  bottom: number
}

export function distance(a: ClientPoint, b: ClientPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function midpoint(a: ClientPoint, b: ClientPoint): ClientPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** Whether a client point is inside a rect (edges included). */
export function isInsideRect(rect: RectLike, point: ClientPoint): boolean {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  )
}

/** Client coordinates of a mouse or pointer event (dnd-kit passes its native event through). */
export function clientPointOf(event: unknown): ClientPoint | null {
  if (typeof MouseEvent === 'undefined' || !(event instanceof MouseEvent)) return null
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null
  return { x: event.clientX, y: event.clientY }
}

// ---------------------------------------------------------------------------------------------
// Moving a placed part

/**
 * Where on a placed part the pointer grabbed it, in sixths from its bottom edge (clamped to the
 * part), so the U you grab stays under the pointer while it moves.
 */
export function grabOffsetSixths(rawSixths: number, y: number, heightSixths: number): number {
  const offset = rawSixths - y
  if (!Number.isFinite(offset)) return 0
  return Math.min(Math.max(offset, 0), Math.max(heightSixths, 0))
}

/** The start a moved part snaps to: the pointer minus the grab offset, at an allowed phase. */
export function moveTargetY(
  rawSixths: number,
  offsetSixths: number,
  phases: readonly number[],
): number {
  return snapY(rawSixths - offsetSixths, phases)
}

// ---------------------------------------------------------------------------------------------
// Pinch zoom

/**
 * The zoom while pinching: the zoom when the second finger went down, times how much the fingers
 * spread since, clamped. A degenerate start (fingers on the same spot) keeps the start zoom.
 */
export function pinchZoom(
  startZoom: number,
  startDistance: number,
  currentDistance: number,
  min: number,
  max: number,
): number {
  if (!(startDistance > 0) || !(currentDistance > 0) || !Number.isFinite(startZoom)) {
    return Math.min(max, Math.max(min, startZoom))
  }
  const zoom = startZoom * (currentDistance / startDistance)
  return Math.min(max, Math.max(min, zoom))
}

// ---------------------------------------------------------------------------------------------
// Scrolling while dragging near an edge

/** How close to a viewport edge (px) a drag starts scrolling it. */
export const EDGE_SCROLL_ZONE_PX = 40
/** Fastest edge scroll, px per animation frame. */
export const EDGE_SCROLL_MAX_PX = 16

/**
 * Px to scroll this frame along one axis while dragging: negative near the start edge, positive
 * near the end edge, faster closer to the edge; 0 elsewhere (and outside the viewport).
 */
export function edgeScrollDelta(
  pointer: number,
  start: number,
  end: number,
  zone: number = EDGE_SCROLL_ZONE_PX,
  maxSpeed: number = EDGE_SCROLL_MAX_PX,
): number {
  if (!(end - start > 2 * zone) || pointer < start || pointer > end) return 0
  if (pointer < start + zone) return -Math.ceil(((start + zone - pointer) / zone) * maxSpeed)
  if (pointer > end - zone) return Math.ceil(((pointer - (end - zone)) / zone) * maxSpeed)
  return 0
}
