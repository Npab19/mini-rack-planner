/**
 * dnd-kit 0.5 configuration for palette → rack drops.
 *
 * dnd-kit only handles the palette drag (HTML source + DragOverlay). Placed SVG items move with
 * plain Pointer Events, keyboard moves are our own, and the drop position is computed from the
 * pointer, never from dnd-kit collision shapes.
 *
 * `@dnd-kit/react` re-exports only the sensors, so `Feedback`, `Accessibility` and the activation
 * constraints come from `@dnd-kit/dom`, and `pointerIntersection` from `@dnd-kit/collision`.
 * Both are installed as dependencies of `@dnd-kit/react` (same 0.5.0 version).
 */
import { pointerIntersection } from '@dnd-kit/collision'
import { Accessibility, Feedback, PointerActivationConstraints } from '@dnd-kit/dom'
import type { DragDropManagerInput, Draggable } from '@dnd-kit/dom'
import { PointerSensor } from '@dnd-kit/react'
import { isItemKind, type ItemKind } from './rackModel'

export const PALETTE_DRAGGABLE_TYPE = 'palette-item'
/** One droppable per rack face. The spike only draws the front face. */
export const FRONT_FACE_DROPPABLE_ID = 'face:front'

export const LONG_PRESS_MS = 250

/**
 * Mouse/pen start a palette drag after 5 px of movement (no hold delay, so a slow click still
 * selects the item for click-to-place). Touch needs a 250 ms press, so a tap selects the item and
 * a swipe scrolls the palette.
 */
export const PALETTE_SENSORS: DragDropManagerInput['sensors'] = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === 'touch'
        ? [new PointerActivationConstraints.Delay({ value: LONG_PRESS_MS, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 5 })],
  }),
]

/**
 * Feedback restyles the drag source (position: fixed, translate, width/height, a cloned
 * placeholder). On SVG nodes that breaks the drawing, so SVG sources get no feedback at all.
 * HTML sources use the DragOverlay, which Feedback positions in the top layer.
 */
export function feedbackFor(source: Draggable): 'none' | 'default' {
  return source.element instanceof SVGElement ? 'none' : 'default'
}

/**
 * The defaults are Accessibility, AutoScroller, Cursor, Feedback and PreventSelection.
 * Accessibility is dropped: it rewrites `aria-pressed` on every draggable (clobbering the
 * palette's selected state) and its instructions describe the KeyboardSensor we do not use.
 * Our own live region announces drops instead. Must stay a module constant: the provider
 * re-applies plugins whenever this value changes identity.
 */
export const PALETTE_PLUGINS: DragDropManagerInput['plugins'] = (defaults) => [
  ...defaults.filter((plugin) => plugin !== Accessibility && plugin !== Feedback),
  Feedback.configure({ feedback: feedbackFor, dropAnimation: null }),
]

/** The face is a target only while the pointer itself is over it (not the overlay's box). */
export const FACE_COLLISION_DETECTOR = pointerIntersection

/** Reads the item kind of a palette draggable. dnd-kit types `data` as Record<string, any>. */
export function paletteKindOf(source: Draggable | null): ItemKind | null {
  if (!source || source.type !== PALETTE_DRAGGABLE_TYPE) return null
  const kind: unknown = source.data['kind']
  return isItemKind(kind) ? kind : null
}
