/**
 * "Fit": the toolbar button and the F key ask the rack to zoom so the whole rack is in view. The
 * rack owns the measurement (its drawing and the viewport size), so it handles the request:
 *
 *   useFitRequest(() => {
 *     useUiStore.getState().setZoom(zoomThatFits(viewport, rackSize))
 *   })
 *
 * The shell announces the resulting zoom, so the handler does not need to. When nothing handles
 * the request (no rack on screen), the toolbar falls back to 100 %.
 */
import { createCommandChannel } from './commandChannel'

const fitChannel = createCommandChannel()

/** Asks the rack to fit itself; false when no rack is listening. */
export function requestFit(): boolean {
  return fitChannel.request()
}

/** Low-level registration (outside React); returns the unregister function. */
export function subscribeFitRequest(handler: () => void): () => void {
  return fitChannel.subscribe(handler)
}

/** Handles fit requests while the calling component is mounted (always the latest handler). */
export function useFitRequest(handler: () => void): void {
  fitChannel.useHandler(handler)
}
