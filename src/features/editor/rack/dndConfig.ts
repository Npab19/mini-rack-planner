/**
 * dnd-kit 0.5 configuration for drags from the palette and the Equipment to fit tray onto the rack
 * (spike S2, docs/spikes/s2-dnd.md). Every runtime import of dnd-kit sits here and in
 * `rackDndHost.tsx`, which the editor loads lazily (`RackDndProvider`).
 *
 * dnd-kit only carries the drag: the HTML source, the DragOverlay chip, activation, Escape and the
 * one droppable per face. Where a part lands always comes from the pointer, through
 * `svg.getScreenCTM().inverse()` and the domain's snapping (`dropTarget.ts`), never from dnd-kit's
 * collision shapes. Placed parts move with plain Pointer Events (`useRackDnd.ts`), and keyboard
 * moves are the rack's own (no KeyboardSensor).
 *
 * `@dnd-kit/react` re-exports only the sensors, so `Feedback`, `Accessibility` and the activation
 * constraints come from `@dnd-kit/dom`, and `pointerIntersection` from `@dnd-kit/collision`.
 */
import { pointerIntersection } from '@dnd-kit/collision'
import {
  Accessibility,
  Feedback,
  PointerActivationConstraints,
  PointerSensor,
  type DragDropManagerInput,
  type Draggable,
} from '@dnd-kit/dom'
import { LONG_PRESS_MS, PALETTE_DRAG_DISTANCE_PX, PALETTE_TOUCH_TOLERANCE_PX } from './dragSubject'

/**
 * Mouse and pen start a palette drag after 5 px of movement (no hold delay: a slow click on a
 * row's button is still a click). Touch needs a 250 ms press, so a swipe scrolls the palette.
 * Must stay a module constant: the provider re-applies sensors whenever this value changes.
 */
export const RACK_DND_SENSORS: DragDropManagerInput['sensors'] = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === 'touch'
        ? [
            new PointerActivationConstraints.Delay({
              value: LONG_PRESS_MS,
              tolerance: PALETTE_TOUCH_TOLERANCE_PX,
            }),
          ]
        : [new PointerActivationConstraints.Distance({ value: PALETTE_DRAG_DISTANCE_PX })],
  }),
]

/**
 * Feedback restyles the drag source (position: fixed, translate, width and height, a placeholder
 * clone). On an SVG node that moves and scales it by the drawing's px per user unit, so SVG sources
 * get no feedback at all. HTML sources use the DragOverlay, which Feedback styles instead.
 */
export function feedbackFor(source: Draggable): 'none' | 'default' {
  return typeof SVGElement !== 'undefined' && source.element instanceof SVGElement
    ? 'none'
    : 'default'
}

/**
 * The defaults are Accessibility, AutoScroller, Cursor, Feedback and PreventSelection.
 * Accessibility is dropped: it rewrites `aria-pressed`, `role` and `tabindex` on every draggable
 * and its instructions describe the KeyboardSensor we do not use; the rack's own live region
 * announces drops. Must stay a module constant: the provider re-applies plugins on identity change.
 */
export const RACK_DND_PLUGINS: DragDropManagerInput['plugins'] = (defaults) => [
  ...defaults.filter((plugin) => plugin !== Accessibility && plugin !== Feedback),
  Feedback.configure({ feedback: feedbackFor, dropAnimation: null }),
]

/** A face is the drop target only while the pointer itself is over it (not the chip's box). */
export const FACE_COLLISION_DETECTOR = pointerIntersection
