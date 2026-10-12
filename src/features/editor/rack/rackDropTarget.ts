/**
 * The rack on screen tells the drag provider how to handle palette and tray drags: where the ghost
 * goes while the pointer moves, and what a drop commits. Module-level on purpose (like the
 * toolbar's command channels): the provider sits above the editor's panels and the rack below
 * them, and neither should re-render for the other. Exclusive: the latest registration wins, so
 * one drop never commits twice.
 *
 * Tests drive drops through `rackDropTarget()` without dnd-kit (jsdom has no layout); the E2E
 * specs cover the real pointer path.
 */
import type { DragSubject } from './dragSubject'
import type { ClientPoint } from './gesture'

export interface RackDropTarget {
  /** The pointer moved while carrying `subject` (client px; null when there is no position). */
  move: (subject: DragSubject, point: ClientPoint | null) => void
  /**
   * Released at `point`. `faceHint` is dnd-kit's own drop target id (the face viewport under the
   * pointer), a cross-check only: the rack hit-tests the point itself.
   */
  drop: (subject: DragSubject, point: ClientPoint | null, faceHint: string | null) => void
  /** Escape (or a lost pointer): nothing is added. */
  cancel: (subject: DragSubject) => void
}

const targets: RackDropTarget[] = []

/** Registers the rack's handlers; returns the unregister function. */
export function registerRackDropTarget(target: RackDropTarget): () => void {
  targets.push(target)
  return () => {
    const index = targets.lastIndexOf(target)
    if (index >= 0) targets.splice(index, 1)
  }
}

/** The rack that handles drops now (the most recently registered), if one is on screen. */
export function rackDropTarget(): RackDropTarget | undefined {
  return targets.at(-1)
}
