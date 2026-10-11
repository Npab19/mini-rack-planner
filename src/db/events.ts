/**
 * Connection-level database events: another tab upgrading or deleting the database, an upgrade
 * blocked by an older tab, a full disk. A tiny synchronous bus with no React or Dexie imports;
 * `src/state/dbStatus.ts` turns it into UI state (the status banners).
 */

export type DbEvent =
  /** Another tab opened a newer schema (or deleted the database): this tab must reload. */
  | { type: 'version-change'; newVersion: number | null }
  /** This tab's open/upgrade waits for another tab that still holds an older connection. */
  | { type: 'blocked' }
  /** The connection opened (clears `blocked`). */
  | { type: 'opened' }
  /** A write failed because the browser's storage quota is exhausted. */
  | { type: 'storage-full'; message: string }

export type DbEventListener = (event: DbEvent) => void

const listeners = new Set<DbEventListener>()

export function onDbEvent(listener: DbEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitDbEvent(event: DbEvent): void {
  // Set iteration tolerates a listener unsubscribing itself while it runs.
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (error) {
      // One faulty listener must not stop the others (or the database code that emitted).
      console.error(error)
    }
  }
}
