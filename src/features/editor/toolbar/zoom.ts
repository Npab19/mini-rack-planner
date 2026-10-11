import { ZOOM_MAX, ZOOM_MIN } from '@/state/uiStore'

/** The zoom steps of the zoom buttons and the [ ] keys (1 = 100 %). */
export const ZOOM_STEPS: readonly number[] = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
].filter((step) => step >= ZOOM_MIN && step <= ZOOM_MAX)

/** Steps closer than this count as the same zoom (a fitted 0.749 is "75 %"). */
const SAME_ZOOM = 0.005

/** The next step up from any zoom (a fitted 0.83 goes to 0.9); `ZOOM_MAX` at the top. */
export function zoomInFrom(zoom: number): number {
  return ZOOM_STEPS.find((step) => step > zoom + SAME_ZOOM) ?? ZOOM_MAX
}

/** The next step down from any zoom; `ZOOM_MIN` at the bottom. */
export function zoomOutFrom(zoom: number): number {
  return ZOOM_STEPS.findLast((step) => step < zoom - SAME_ZOOM) ?? ZOOM_MIN
}

export function canZoomIn(zoom: number): boolean {
  return zoom < ZOOM_MAX - SAME_ZOOM
}

export function canZoomOut(zoom: number): boolean {
  return zoom > ZOOM_MIN + SAME_ZOOM
}

/** "125%". */
export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`
}
