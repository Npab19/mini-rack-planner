/**
 * "Add at U…": places something at a chosen U instead of a click. The component that owns that
 * dialog (the rack) registers a handler that opens it:
 *
 *   useAddAtURequest((source) => openAddAtU(source))
 *
 * `source` says what to add (the palette's row, the inspector's "Add another at U…"); without one
 * the dialog adds what is being placed (the placing banner's button). The banner and the palette
 * show their "Add at U…" through the rack's dialog while one is registered (the palette has its
 * own dialog as a fallback). Exclusive: if several components register, only the most recent
 * handler runs, so one request never opens two dialogs.
 */
import type { PlaceSource } from '../editorState'
import { createCommandChannel } from './commandChannel'

const addAtUChannel = createCommandChannel<PlaceSource | undefined>({ exclusive: true })

/** Opens "Add at U…" for `source` (default: what is being placed); false when nothing offers it. */
export function requestAddAtU(source?: PlaceSource): boolean {
  return addAtUChannel.request(source)
}

/** Offers "Add at U…" while the calling component is mounted. */
export function useAddAtURequest(handler: (source: PlaceSource | undefined) => void): void {
  addAtUChannel.useHandler(handler)
}

/** Whether "Add at U…" is offered (re-renders when that changes). */
export function useAddAtUAvailable(): boolean {
  return addAtUChannel.useAvailable()
}

/** Low-level registration (outside React); returns the unregister function. */
export function subscribeAddAtURequest(
  handler: (source: PlaceSource | undefined) => void,
): () => void {
  return addAtUChannel.subscribe(handler)
}
