import type { DragEndEvent, DragMoveEvent, DragStartEvent } from '@dnd-kit/react'
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { FRONT_FACE_DROPPABLE_ID, LONG_PRESS_MS, paletteKindOf } from './dndConfig'
import {
  CATALOG,
  checkPlacement,
  formatSpan,
  grabbedStepOf,
  keyboardDelta,
  sixthsOfSvgY,
  snapStart,
  SIXTHS_PER_U,
  type ItemKind,
  type Placement,
  type Sixths,
  type Verdict,
} from './rackModel'
import { clientPointOf, clientToSvg, distance, isInsideRect, type ClientPoint } from './svgPoint'

/**
 * Spike prototype of the M3b `useRackDnd` contract (see docs/spikes/s2-dnd.md).
 *
 * - Palette → rack: dnd-kit drag events (spread `providerHandlers` on DragDropProvider).
 * - Placed items: plain Pointer Events + setPointerCapture on the face viewport.
 * - Touch: tap-to-select + tap-to-place; long-press (250 ms) drags a placed item; a swipe pans.
 * - Keyboard: ArrowUp/Down ±1U (Shift ±5U), Delete removes.
 *
 * The target U always comes from the pointer via `svg.getScreenCTM().inverse()`, read at event
 * time, then pure snapping and checks. Nothing is committed until the gesture ends: one gesture is
 * one `commit` call (one undo step), and the ghost is local state only.
 */

export type RackAction =
  | { type: 'add'; kind: ItemKind; y: Sixths }
  | { type: 'move'; id: string; y: Sixths }
  | { type: 'remove'; id: string }

export type GhostOrigin = 'palette' | 'move' | 'tap'

export interface Ghost {
  kind: ItemKind
  y: Sixths
  verdict: Verdict
  origin: GhostOrigin
  movingId?: string
}

export interface DropStats {
  drops: number
  /** Drops where dnd-kit's target (pointerIntersection) agreed with our own hit test. */
  targetAgreed: number
  last: string
}

export interface UseRackDndOptions {
  /** Root <svg> of the face drawing; its CTM maps client px → drawing mm. */
  svgRef: RefObject<SVGSVGElement | null>
  /** The visible, clipping viewport of the face. Points outside it never hit the rack. */
  viewportRef: RefObject<HTMLElement | null>
  placements: readonly Placement[]
  commit: (action: RackAction) => void
  announce: (message: string) => void
  /** Background drags (and touch swipes that start on an item) pan the view. */
  onPan: (dx: number, dy: number) => void
  /** Changes whenever the drawing moves on screen, so a ghost under a still pointer is refreshed. */
  viewKey: string
}

export interface FaceHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
  onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void
  /** Suppresses the long-press context menu on touch. */
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void
}

export interface UseRackDndResult {
  ghost: Ghost | null
  movingId: string | null
  armed: ItemKind | null
  arm: (kind: ItemKind | null) => void
  providerHandlers: {
    onDragStart: (event: DragStartEvent) => void
    onDragMove: (event: DragMoveEvent) => void
    onDragEnd: (event: DragEndEvent) => void
  }
  faceHandlers: FaceHandlers
  onItemKeyDown: (placement: Placement, event: ReactKeyboardEvent<SVGGElement>) => void
  /** Keyboard / form path: place `kind` with its bottom at U `u` (1-based, halves allowed). */
  addAtU: (kind: ItemKind, u: number) => boolean
  stats: DropStats
}

interface ItemGesture {
  type: 'item'
  pointerId: number
  pointerType: string
  placementId: string
  origin: ClientPoint
  last: ClientPoint
  grabbedStep: number
  dragging: boolean
  timer: number | null
}

interface PanGesture {
  type: 'pan'
  pointerId: number
  origin: ClientPoint
  last: ClientPoint
  moved: boolean
  /** A pointer-down while an item is armed: a release without movement places it. */
  tap: boolean
}

type CanvasGesture = ItemGesture | PanGesture

const MOUSE_DRAG_SLOP_PX = 4
const TOUCH_SLOP_PX = 8

function sameGhost(a: Ghost | null, b: Ghost | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.kind === b.kind &&
    a.y === b.y &&
    a.origin === b.origin &&
    a.movingId === b.movingId &&
    a.verdict.ok === b.verdict.ok &&
    a.verdict.message === b.verdict.message
  )
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

function focusPlacementSoon(id: string | null, fallback: HTMLElement | null): void {
  requestAnimationFrame(() => {
    const target = id
      ? document.querySelector<SVGGElement>(`[data-placed-id="${CSS.escape(id)}"]`)
      : null
    ;(target ?? fallback)?.focus({ preventScroll: true })
  })
}

export function useRackDnd(options: UseRackDndOptions): UseRackDndResult {
  const { svgRef, viewportRef, placements, commit, announce, onPan, viewKey } = options
  const [ghost, setGhost] = useState<Ghost | null>(null)
  const [movingId, setMovingId] = useState<string | null>(null)
  const [armed, setArmed] = useState<ItemKind | null>(null)
  const [stats, setStats] = useState<DropStats>({ drops: 0, targetAgreed: 0, last: '' })

  // Latest placements for timers and dnd-kit callbacks that outlive a render.
  const placementsRef = useRef(placements)
  useLayoutEffect(() => {
    placementsRef.current = placements
  }, [placements])

  const gestureRef = useRef<CanvasGesture | null>(null)
  const paletteKindRef = useRef<ItemKind | null>(null)
  /** Last pointer position of whatever currently drives the ghost (palette drag or hover). */
  const lastPointerRef = useRef<ClientPoint | null>(null)

  const updateGhost = useCallback((next: Ghost | null) => {
    setGhost((previous) => (sameGhost(previous, next) ? previous : next))
  }, [])

  /** Pointer → fractional sixths above the bottom of U1, or null when not over the visible face. */
  function hitTest(point: ClientPoint): number | null {
    const viewport = viewportRef.current
    const svg = svgRef.current
    if (!viewport || !svg) return null
    if (!isInsideRect(viewport.getBoundingClientRect(), point)) return null
    const local = clientToSvg(svg, point)
    return local ? sixthsOfSvgY(local.y) : null
  }

  function addGhost(kind: ItemKind, point: ClientPoint, origin: GhostOrigin): Ghost | null {
    const sixths = hitTest(point)
    if (sixths === null) return null
    const y = snapStart(sixths, CATALOG[kind].stepSixths)
    return { kind, y, verdict: checkPlacement(placementsRef.current, { kind, y }), origin }
  }

  function moveGhost(gesture: ItemGesture, point: ClientPoint): Ghost | null {
    const placement = placementsRef.current.find((p) => p.id === gesture.placementId)
    const sixths = hitTest(point)
    if (!placement || sixths === null) return null
    const y = snapStart(sixths, CATALOG[placement.kind].stepSixths, gesture.grabbedStep)
    const verdict = checkPlacement(placementsRef.current, {
      kind: placement.kind,
      y,
      ignoreId: placement.id,
    })
    return { kind: placement.kind, y, verdict, origin: 'move', movingId: placement.id }
  }

  function tryAdd(kind: ItemKind, y: Sixths): boolean {
    const { name, heightSixths } = CATALOG[kind]
    const verdict = checkPlacement(placementsRef.current, { kind, y })
    if (!verdict.ok) {
      announce(`${name} not added: ${lowerFirst(verdict.message)}.`)
      return false
    }
    commit({ type: 'add', kind, y })
    announce(`Added ${name} at ${formatSpan(y, heightSixths)}.`)
    return true
  }

  function tryMove(placement: Placement, y: Sixths, verb: string): boolean {
    const { name, heightSixths } = CATALOG[placement.kind]
    const verdict = checkPlacement(placementsRef.current, {
      kind: placement.kind,
      y,
      ignoreId: placement.id,
    })
    if (!verdict.ok) {
      announce(`Can't move ${name} ${verb}: ${lowerFirst(verdict.message)}.`)
      return false
    }
    commit({ type: 'move', id: placement.id, y })
    announce(`Moved ${name} ${verb} to ${formatSpan(y, heightSixths)}.`)
    return true
  }

  /* ---------- palette → rack (dnd-kit) ---------- */

  function onDragStart(event: DragStartEvent): void {
    paletteKindRef.current = paletteKindOf(event.operation.source)
    lastPointerRef.current = null
  }

  function onDragMove(event: DragMoveEvent): void {
    const kind = paletteKindRef.current
    if (!kind) return
    // While dragmove is dispatched, operation.position still holds the previous point;
    // the new one is `to` (pointer sensor) or the native event.
    const point = event.to ?? clientPointOf(event.nativeEvent)
    if (!point) return
    lastPointerRef.current = point
    updateGhost(addGhost(kind, point, 'palette'))
  }

  function onDragEnd(event: DragEndEvent): void {
    const kind = paletteKindRef.current
    paletteKindRef.current = null
    lastPointerRef.current = null
    updateGhost(null)
    if (!kind) return
    const { name } = CATALOG[kind]
    if (event.canceled) {
      announce(`Cancelled. ${name} was not added.`)
      return
    }
    // The pointer sensor coalesces moves per animation frame, so the operation can lag the
    // pointerup by a frame. The native pointerup carries the exact release point.
    const point = clientPointOf(event.nativeEvent) ?? event.operation.position.current
    const sixths = hitTest(point)
    const dndSaysFace = event.operation.target?.id === FRONT_FACE_DROPPABLE_ID
    const y = sixths === null ? null : snapStart(sixths, CATALOG[kind].stepSixths)
    setStats((previous) => ({
      drops: previous.drops + 1,
      targetAgreed: previous.targetAgreed + (dndSaysFace === (sixths !== null) ? 1 : 0),
      last: [
        `client=${Math.round(point.x)},${Math.round(point.y)}`,
        `sixths=${sixths === null ? 'none' : sixths.toFixed(2)}`,
        `start=${y === null ? 'none' : `U${y / SIXTHS_PER_U + 1}`}`,
        `dndTarget=${String(event.operation.target?.id ?? 'none')}`,
      ].join(' '),
    }))
    if (y === null) {
      announce(`${name} not added: dropped outside the rack.`)
      return
    }
    tryAdd(kind, y)
  }

  /* ---------- placed items and tap-to-place (Pointer Events) ---------- */

  function clearTimer(gesture: ItemGesture): void {
    if (gesture.timer !== null) window.clearTimeout(gesture.timer)
    gesture.timer = null
  }

  function startItemDrag(gesture: ItemGesture): void {
    if (gestureRef.current !== gesture || gesture.dragging) return
    clearTimer(gesture)
    gesture.dragging = true
    setMovingId(gesture.placementId)
    updateGhost(moveGhost(gesture, gesture.last))
  }

  function endItemDrag(): void {
    setMovingId(null)
    updateGhost(null)
  }

  function abortGesture(pointerId: number): void {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== pointerId) return
    gestureRef.current = null
    if (gesture.type !== 'item') return
    clearTimer(gesture)
    if (gesture.dragging) {
      endItemDrag()
      announce('Move cancelled.')
    }
  }

  function placeArmedAt(point: ClientPoint): void {
    if (!armed) return
    const next = addGhost(armed, point, 'tap')
    if (!next) return
    if (tryAdd(armed, next.y)) {
      setArmed(null)
      updateGhost(null)
    } else {
      // Keep the blocked ghost (✗ + reason) on screen: touch has no hover to show it earlier.
      updateGhost(next)
    }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>): void {
    if (!event.isPrimary || gestureRef.current) return
    if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 1) return
    const point = { x: event.clientX, y: event.clientY }
    const itemElement =
      event.target instanceof Element ? event.target.closest<SVGGElement>('[data-placed-id]') : null
    const placementId = itemElement?.dataset['placedId']
    const placement =
      armed === null && event.button === 0 && placementId
        ? placementsRef.current.find((p) => p.id === placementId)
        : undefined
    event.currentTarget.setPointerCapture(event.pointerId)

    if (placement && itemElement) {
      itemElement.focus({ preventScroll: true })
      const sixths = hitTest(point)
      const gesture: ItemGesture = {
        type: 'item',
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        placementId: placement.id,
        origin: point,
        last: point,
        grabbedStep: sixths === null ? 0 : grabbedStepOf(sixths, placement),
        dragging: false,
        timer: null,
      }
      if (event.pointerType === 'touch') {
        gesture.timer = window.setTimeout(() => startItemDrag(gesture), LONG_PRESS_MS)
      }
      gestureRef.current = gesture
      return
    }
    gestureRef.current = {
      type: 'pan',
      pointerId: event.pointerId,
      origin: point,
      last: point,
      moved: false,
      tap: armed !== null && event.button === 0,
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>): void {
    const point = { x: event.clientX, y: event.clientY }
    const gesture = gestureRef.current
    if (!gesture) {
      // Click-to-place preview for mouse and pen (touch has no hover).
      if (armed && event.pointerType !== 'touch') {
        lastPointerRef.current = point
        updateGhost(addGhost(armed, point, 'tap'))
      }
      return
    }
    if (event.pointerId !== gesture.pointerId) return

    if (gesture.type === 'pan') {
      onPan(point.x - gesture.last.x, point.y - gesture.last.y)
      gesture.last = point
      if (distance(point, gesture.origin) > TOUCH_SLOP_PX) gesture.moved = true
      return
    }

    if (!gesture.dragging) {
      const isTouch = gesture.pointerType === 'touch'
      if (distance(point, gesture.origin) <= (isTouch ? TOUCH_SLOP_PX : MOUSE_DRAG_SLOP_PX)) {
        gesture.last = point
        return
      }
      if (isTouch) {
        // Moved before the long-press fired: a swipe on an item pans, it never moves the item.
        clearTimer(gesture)
        gestureRef.current = {
          type: 'pan',
          pointerId: gesture.pointerId,
          origin: gesture.origin,
          last: point,
          moved: true,
          tap: false,
        }
        onPan(point.x - gesture.origin.x, point.y - gesture.origin.y)
        return
      }
      startItemDrag(gesture)
    }
    gesture.last = point
    updateGhost(moveGhost(gesture, point))
  }

  function onPointerUp(event: ReactPointerEvent<HTMLElement>): void {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    const point = { x: event.clientX, y: event.clientY }
    if (gesture.type === 'pan') {
      if (gesture.tap && !gesture.moved) placeArmedAt(point)
      return
    }
    clearTimer(gesture)
    if (!gesture.dragging) return
    endItemDrag()
    const placement = placementsRef.current.find((p) => p.id === gesture.placementId)
    if (!placement) return
    const sixths = hitTest(point)
    if (sixths === null) {
      announce(`${CATALOG[placement.kind].name} not moved: released outside the rack.`)
      return
    }
    const y = snapStart(sixths, CATALOG[placement.kind].stepSixths, gesture.grabbedStep)
    if (y !== placement.y) tryMove(placement, y, y > placement.y ? 'up' : 'down')
  }

  function onPointerLeave(event: ReactPointerEvent<HTMLElement>): void {
    // Touch pointers "leave" on every lift; that must not hide a blocked tap's ✗ + reason.
    if (event.pointerType === 'touch') return
    if (!gestureRef.current && ghost?.origin === 'tap') {
      lastPointerRef.current = null
      updateGhost(null)
    }
  }

  // The drawing moved under a still pointer (wheel pan or zoom mid-gesture): refresh the ghost.
  const ghostViewKeyRef = useRef(viewKey)
  const refreshGhost = useEffectEvent((currentViewKey: string) => {
    if (ghostViewKeyRef.current === currentViewKey) return
    ghostViewKeyRef.current = currentViewKey
    const gesture = gestureRef.current
    if (gesture?.type === 'item' && gesture.dragging) {
      updateGhost(moveGhost(gesture, gesture.last))
      return
    }
    const point = lastPointerRef.current
    const kind = paletteKindRef.current ?? armed
    if (point && kind) {
      updateGhost(addGhost(kind, point, paletteKindRef.current ? 'palette' : 'tap'))
    }
  })
  useEffect(() => {
    refreshGhost(viewKey)
  }, [viewKey])

  // A long-press timer must not fire after the editor unmounts.
  useEffect(
    () => () => {
      const gesture = gestureRef.current
      if (gesture?.type === 'item' && gesture.timer !== null) window.clearTimeout(gesture.timer)
    },
    [],
  )

  // Escape cancels an item drag or clears the palette selection.
  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    const gesture = gestureRef.current
    if (gesture?.type === 'item' && gesture.dragging) {
      abortGesture(gesture.pointerId)
      return
    }
    if (armed) {
      setArmed(null)
      updateGhost(null)
      announce('Selection cleared.')
    }
  })
  const listenForEscape = movingId !== null || armed !== null
  useEffect(() => {
    if (!listenForEscape) return
    const listener = (event: KeyboardEvent) => onEscape(event)
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [listenForEscape])

  /* ---------- keyboard on placed items ---------- */

  function onItemKeyDown(placement: Placement, event: ReactKeyboardEvent<SVGGElement>): void {
    const delta = keyboardDelta(event.key, event.shiftKey)
    if (delta !== null) {
      event.preventDefault()
      tryMove(placement, placement.y + delta, delta > 0 ? 'up' : 'down')
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      const { name, heightSixths } = CATALOG[placement.kind]
      const others = placementsRef.current.filter((p) => p.id !== placement.id)
      const next =
        others.toSorted((a, b) => b.y - a.y).find((p) => p.y < placement.y) ?? others[0] ?? null
      commit({ type: 'remove', id: placement.id })
      announce(`Removed ${name} from ${formatSpan(placement.y, heightSixths)}.`)
      focusPlacementSoon(next?.id ?? null, viewportRef.current)
    }
  }

  function arm(kind: ItemKind | null): void {
    setArmed(kind)
    updateGhost(null)
    announce(
      kind
        ? `${CATALOG[kind].name} selected. Tap or click a U to place it, or press Escape.`
        : 'Selection cleared.',
    )
  }

  function addAtU(kind: ItemKind, u: number): boolean {
    return tryAdd(kind, Math.round((u - 1) * SIXTHS_PER_U))
  }

  return {
    ghost,
    movingId,
    armed,
    arm,
    providerHandlers: { onDragStart, onDragMove, onDragEnd },
    faceHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: (event) => abortGesture(event.pointerId),
      onLostPointerCapture: (event) => abortGesture(event.pointerId),
      onPointerLeave,
      onContextMenu: (event) => event.preventDefault(),
    },
    onItemKeyDown,
    addAtU,
    stats,
  }
}
