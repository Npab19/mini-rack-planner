/** Pointer → SVG mapping. The only DOM geometry the DnD code relies on. */

export interface ClientPoint {
  x: number
  y: number
}

/**
 * Client (CSS px, viewport-relative) → SVG user units of `element`.
 *
 * Uses the live screen CTM, so it already accounts for the viewBox, CSS transforms on ancestors,
 * page scroll and browser zoom. Read it at event time; never cache the matrix across a gesture,
 * because a pan or zoom during the drag changes it.
 */
export function clientToSvg(element: SVGGraphicsElement, point: ClientPoint): DOMPoint | null {
  const ctm = element.getScreenCTM()
  if (!ctm) return null
  const local = new DOMPoint(point.x, point.y).matrixTransform(ctm.inverse())
  return Number.isFinite(local.x) && Number.isFinite(local.y) ? local : null
}

export function isInsideRect(rect: DOMRectReadOnly, point: ClientPoint): boolean {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  )
}

/** Client coordinates of a pointer or mouse event (dnd-kit passes the native event through). */
export function clientPointOf(event: Event | undefined): ClientPoint | null {
  if (event instanceof MouseEvent) return { x: event.clientX, y: event.clientY }
  return null
}

export function distance(a: ClientPoint, b: ClientPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
