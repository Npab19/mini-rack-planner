/**
 * Every pointer gesture on the rack drawing, and the rack's side of palette and tray drags (M3b;
 * the contract from spike S2, docs/spikes/s2-dnd.md):
 *
 * - **Palette and tray drops** (dnd-kit, through `RackDndProvider`): the rack registers itself as
 *   the drop target (`registerRackDropTarget`). While the pointer moves, the ghost shows where the
 *   part would land and whether it can; the release commits one step (see `dropTarget.ts`): a
 *   mount, panel or ear-mounted gear is placed like a click (`placeAt`, In my rack in Recording
 *   mode); a device on a slot goes in (`assignToSlot`); any other device on empty space opens the
 *   mount chooser (`useMountDialogs.openChooser`).
 * - **Moving placed parts**: Pointer Events with `setPointerCapture` on the element around the
 *   drawing. A mouse or pen moves a part after 4 px; a finger after a 250 ms long-press (moving
 *   sooner is a swipe, which pans). The grabbed U stays under the pointer; the ghost shows ✓/✗ and
 *   the reason; the release makes one `applyOp` (one undo step, nothing written before). Escape,
 *   `pointercancel` or a second finger put it back.
 * - **Panning and zooming**: dragging the background (mouse, pen or one finger) pans; two fingers
 *   pinch-zoom around the point between them and pan with it; the camera (`useRackView`) does the
 *   scrolling and zooming.
 * - After a drag or a pan, the click the browser sends is swallowed, so it never selects or places.
 *
 * Geometry is read only at event time: client px -> `svg.getScreenCTM().inverse()` -> drawing
 * units, and only inside the clipping viewport's rect. Taps, clicks and keys keep their M3a paths
 * in RackView (click-to-place, selection, the arrow keys), which use the same rules and words.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { toast } from 'sonner'
import type { CatalogLookup, Frame } from '@/domain/schema/catalog'
import type { Face } from '@/domain/schema/common'
import type { Plan } from '@/domain/schema/plan'
import { usePlanStore } from '@/state/planStore'
import { isRecording, useUiStore, ZOOM_MAX, ZOOM_MIN } from '@/state/uiStore'
import { useEditorState } from '../editorState'
import type { SpareContext } from '../inspector/planOps'
import { useMountDialogs } from '../mounts/mountDialogsStore'
import { assignToSlot, movePlacementTo, placeAt, READ_ONLY_MESSAGE } from './commit'
import { LONG_PRESS_MS, MOUSE_DRAG_SLOP_PX, TOUCH_SLOP_PX, type DragSubject } from './dragSubject'
import {
  CARRY_IDLE,
  setCarryOver,
  setCarryStatus,
  setDragGhost,
  setMovingPlacement,
  useRackDrag,
  type DragGhost,
} from './dragStore'
import {
  drawingPoint,
  dropIsOk,
  dropText,
  planDrop,
  planMove,
  subjectName,
  type DrawingPoint,
  type DropContext,
  type DropPlan,
  type MovePlan,
} from './dropTarget'
import {
  distance,
  edgeScrollDelta,
  grabOffsetSixths,
  isInsideRect,
  midpoint,
  pinchZoom,
  type ClientPoint,
} from './gesture'
import { ghostText, positionText } from './labels'
import { clientToRack, type Point } from './pointer'
import { registerRackDropTarget } from './rackDropTarget'
import type { RackLayout } from './rackLayout'
import type { PlacementView } from './rackModel'
import type { RackCamera } from './useRackView'

export interface UseRackDndOptions {
  /** The rack drawing: its screen CTM maps client px to drawing units. */
  svgRef: RefObject<SVGSVGElement | null>
  /** The clipping viewport (the scroll container): only points inside it hit the rack. */
  scroller: HTMLElement | null
  layout: RackLayout
  face: Face
  /** The placements drawn on this face. */
  views: readonly PlacementView[]
  /** The open plan's lookup (its own parts included). */
  catalog: CatalogLookup
  frame: Frame
  readOnly: boolean
  spares: SpareContext
  camera: RackCamera
  /** The rack's live region. */
  announce: (text: string) => void
  /** A gesture added a part, moved one or put a device in one: select it. */
  onPlaced: (placementId: string) => void
}

/** Spread on the element around the drawing (it gets the pointer capture). */
export interface RackFaceProps {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
  onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void
}

export interface UseRackDndResult {
  faceProps: RackFaceProps
  /** Puts back a move or ends a pan or pinch in progress (also bound to Escape). */
  cancel: () => void
}

type Timer = ReturnType<typeof setTimeout>

/** A pointer is down; it may still become a click, a move or a pan. */
interface PressGesture {
  type: 'press'
  pointerId: number
  pointerType: string
  origin: ClientPoint
  last: ClientPoint
  /** The placed part under it (when it can be moved). */
  placementId: string | null
  /** Where it was grabbed, in sixths above its bottom. */
  offsetSixths: number
  timer: Timer | null
}

interface MoveGesture {
  type: 'move'
  pointerId: number
  pointerType: string
  last: ClientPoint
  placementId: string
  offsetSixths: number
}

interface PanGesture {
  type: 'pan'
  pointerId: number
  last: ClientPoint
}

interface PinchGesture {
  type: 'pinch'
  ids: readonly [number, number]
  startDistance: number
  startZoom: number
  /** The drawing point between the fingers when the pinch began: it stays between them. */
  keep: Point | null
}

type Gesture = PressGesture | MoveGesture | PanGesture | PinchGesture

/** Controls that keep their own pointer behaviour (the + handles, menus, inputs, links). */
const INTERACTIVE =
  'button, a[href], input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="menuitem"], [role="option"]'

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE) !== null
}

function placementIdOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  return target.closest('[data-placement-id]')?.getAttribute('data-placement-id') ?? null
}

function clientOf(event: { clientX: number; clientY: number }): ClientPoint {
  return { x: event.clientX, y: event.clientY }
}

function capture(element: Element | null, pointerId: number): void {
  if (element === null || typeof element.setPointerCapture !== 'function') return
  try {
    element.setPointerCapture(pointerId)
  } catch {
    // The pointer is gone already (pointercancel follows).
  }
}

function release(element: Element | null, pointerId: number): void {
  if (element === null || typeof element.releasePointerCapture !== 'function') return
  try {
    if (element.hasPointerCapture?.(pointerId) !== false) element.releasePointerCapture(pointerId)
  } catch {
    // Not captured.
  }
}

function ghostOfDrop(drop: DropPlan, ctx: DropContext): DragGhost | null {
  const text = dropText(drop)
  switch (drop.kind) {
    case 'place':
      return {
        origin: 'drop',
        kind: 'span',
        face: drop.spot.face,
        y: drop.spot.y,
        heightSixths: drop.info.heightSixths,
        bay: drop.spot.bay,
        status: drop.check.ok ? 'ok' : 'blocked',
        text,
      }
    case 'slot': {
      const holder = ctx.views.find((view) => view.id === drop.zone.placementId)
      return {
        origin: 'drop',
        kind: 'slot',
        face: ctx.face,
        y: holder?.y ?? 0,
        heightSixths: holder?.heightSixths ?? 0,
        bay: holder?.bay ?? 'full',
        status: drop.ok ? 'ok' : 'blocked',
        text,
        box: drop.zone.box,
        placementId: drop.zone.placementId,
        slotId: drop.zone.slot.id,
      }
    }
    case 'chooser':
      return {
        origin: 'drop',
        kind: 'span',
        face: drop.face,
        y: drop.y,
        heightSixths: drop.heightSixths,
        bay: 'full',
        status: 'choose',
        text,
      }
    case 'blocked': {
      if (drop.box === undefined) return null
      const holder = ctx.views.find((view) => view.id === drop.placementId)
      return {
        origin: 'drop',
        kind: 'slot',
        face: ctx.face,
        y: holder?.y ?? 0,
        heightSixths: holder?.heightSixths ?? 0,
        bay: holder?.bay ?? 'full',
        status: 'blocked',
        text,
        box: drop.box,
        ...(drop.placementId === undefined ? {} : { placementId: drop.placementId }),
      }
    }
  }
}

export function useRackDnd(options: UseRackDndOptions): UseRackDndResult {
  // Latest props for handlers that outlive a render (timers, dnd-kit callbacks, listeners).
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  })

  const gesture = useRef<Gesture | null>(null)
  /** The element the handlers sit on: it takes the pointer capture. */
  const faceElement = useRef<HTMLElement | null>(null)
  /** Touch points currently down on the face (for pinches). */
  const touches = useRef(new Map<number, ClientPoint>())
  const lastPointerType = useRef<string>('mouse')
  /** The click the browser sends after a drag or a pan must not select or place. */
  const suppressClick = useRef(false)
  /** A palette or tray drag over the rack: what and where, to refresh when the view moves. */
  const carry = useRef<{ subject: DragSubject; point: ClientPoint } | null>(null)
  const moveCache = useRef<{ plan: Plan; key: string; result: MovePlan } | null>(null)
  const autoScroll = useRef<{ frame: number; point: ClientPoint } | null>(null)

  /** A client point on the drawing, or null outside the visible viewport (or without a CTM). */
  const drawingPointAt = useCallback((client: ClientPoint): DrawingPoint | null => {
    const { svgRef, scroller, layout } = latest.current
    const svg = svgRef.current
    if (svg === null || typeof svg.getScreenCTM !== 'function') return null
    if (scroller !== null && !isInsideRect(scroller.getBoundingClientRect(), client)) return null
    const rack = clientToRack(svg, client.x, client.y, layout)
    return rack === null ? null : drawingPoint(layout, rack)
  }, [])

  const dropContext = useCallback((): DropContext | null => {
    const { plan, planId } = usePlanStore.getState()
    if (plan === null) return null
    const { catalog, frame, layout, face, views } = latest.current
    return { plan, catalog, frame, layout, face, views, recording: isRecording(planId) }
  }, [])

  // ---- Palette and tray drags

  const showCarry = useCallback(() => {
    const current = carry.current
    if (current === null) return
    const point = drawingPointAt(current.point)
    const ctx = dropContext()
    if (point === null || ctx === null) {
      setDragGhost(null)
      setCarryStatus(CARRY_IDLE)
      setCarryOver(false)
      return
    }
    setCarryOver(true)
    const drop = planDrop(ctx, current.subject, point)
    setDragGhost(ghostOfDrop(drop, ctx))
    const ok = dropIsOk(drop)
    setCarryStatus({
      tone: drop.kind === 'chooser' ? 'choose' : ok ? 'ok' : 'blocked',
      text: dropText(drop),
    })
  }, [drawingPointAt, dropContext])

  const commitDrop = useCallback(
    (subject: DragSubject, client: ClientPoint | null) => {
      const { announce, catalog, spares, readOnly, onPlaced } = latest.current
      const name = subjectName(subject, catalog)
      if (readOnly) {
        announce(READ_ONLY_MESSAGE)
        return
      }
      const point = client === null ? null : drawingPointAt(client)
      const ctx = dropContext()
      if (point === null || ctx === null) {
        announce(`${name} was not added: drop it on the rack.`)
        return
      }
      const drop = planDrop(ctx, subject, point)
      switch (drop.kind) {
        case 'place': {
          if (!drop.check.ok) {
            const where = positionText(drop.spot.y, drop.info.heightSixths)
            announce(
              `${drop.info.name} can't go at ${where}: ${drop.check.reasons[0] ?? 'it does not fit.'}`,
            )
            return
          }
          const outcome = placeAt(catalog, drop.source, drop.spot, spares)
          if (!outcome.ok) {
            announce(outcome.message)
            toast.error(outcome.message)
            return
          }
          if (outcome.createdId !== undefined) onPlaced(outcome.createdId)
          announce(
            outcome.createdId === undefined
              ? outcome.message
              : `${outcome.message} It is selected.`,
          )
          return
        }
        case 'slot': {
          if (!drop.ok) {
            announce(drop.reason ?? `The ${drop.deviceName} does not fit ${drop.zone.label}.`)
            return
          }
          const outcome = assignToSlot(
            catalog,
            {
              deviceId: drop.deviceId,
              ...(drop.equipmentId === undefined ? {} : { equipmentId: drop.equipmentId }),
              placementId: drop.zone.placementId,
              slotId: drop.zone.slot.id,
            },
            spares,
          )
          announce(outcome.message)
          if (outcome.ok) onPlaced(drop.zone.placementId)
          else toast.error(outcome.message)
          return
        }
        case 'chooser':
          useMountDialogs.getState().openChooser({
            deviceId: drop.deviceId,
            face: drop.face,
            y: drop.y,
            ...(drop.equipmentId === undefined ? {} : { equipmentId: drop.equipmentId }),
          })
          announce(
            `Choose a mount for the ${drop.deviceName} at ${positionText(drop.y, drop.heightSixths)}.`,
          )
          return
        case 'blocked':
          announce(`${name} can't go there: ${drop.reason}`)
          return
      }
    },
    [drawingPointAt, dropContext],
  )

  useEffect(
    () =>
      registerRackDropTarget({
        move: (subject, point) => {
          carry.current = point === null ? null : { subject, point }
          if (point === null) {
            setDragGhost(null)
            setCarryStatus(CARRY_IDLE)
            setCarryOver(false)
            return
          }
          showCarry()
        },
        drop: (subject, point) => {
          carry.current = null
          setDragGhost(null)
          setCarryOver(false)
          commitDrop(subject, point)
        },
        cancel: (subject) => {
          carry.current = null
          setDragGhost(null)
          setCarryOver(false)
          latest.current.announce(
            `Cancelled: ${subjectName(subject, latest.current.catalog)} was not added.`,
          )
        },
      }),
    [showCarry, commitDrop],
  )

  // ---- Moving placed parts

  const planMoveAt = useCallback(
    (move: MoveGesture | PressGesture, client: ClientPoint): MovePlan | null => {
      if (move.placementId === null) return null
      const point = drawingPointAt(client)
      const plan = usePlanStore.getState().plan
      if (point === null || plan === null) return null
      const { catalog, frame, layout } = latest.current
      const result = planMove(
        { plan, catalog, frame, layout },
        move.placementId,
        move.offsetSixths,
        point,
      )
      if (result === null) return null
      // The check runs once per spot, not once per pointer event.
      const key = `${move.placementId}|${result.y}|${result.bay}`
      const cached = moveCache.current
      if (cached !== null && cached.plan === plan && cached.key === key) return cached.result
      moveCache.current = { plan, key, result }
      return result
    },
    [drawingPointAt],
  )

  const showMove = useCallback(
    (move: MoveGesture) => {
      const result = planMoveAt(move, move.last)
      if (result === null) {
        setDragGhost(null)
        return
      }
      setDragGhost({
        origin: 'move',
        kind: 'span',
        face: result.placement.face,
        y: result.y,
        heightSixths: result.heightSixths,
        bay: result.bay,
        status: result.check.ok ? 'ok' : 'blocked',
        text: ghostText({
          ok: result.check.ok,
          reasons: result.check.reasons,
          y: result.y,
          heightSixths: result.heightSixths,
        }),
      })
    },
    [planMoveAt],
  )

  const stopAutoScroll = useCallback(() => {
    const state = autoScroll.current
    autoScroll.current = null
    if (state !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(state.frame)
    }
  }, [])

  /** Near the viewport's edge while moving a part, the view scrolls to show more of the rack. */
  const autoScrollFor = useCallback(
    (point: ClientPoint) => {
      const scroller = latest.current.scroller
      if (scroller === null || typeof requestAnimationFrame !== 'function') return
      if (autoScroll.current !== null) {
        autoScroll.current.point = point
        return
      }
      const rect = scroller.getBoundingClientRect()
      const scrolls =
        edgeScrollDelta(point.x, rect.left, rect.right) !== 0 ||
        edgeScrollDelta(point.y, rect.top, rect.bottom) !== 0
      if (!scrolls) return
      function tick(): void {
        const state = autoScroll.current
        const element = latest.current.scroller
        if (state === null || element === null) return
        const bounds = element.getBoundingClientRect()
        const dx = edgeScrollDelta(state.point.x, bounds.left, bounds.right)
        const dy = edgeScrollDelta(state.point.y, bounds.top, bounds.bottom)
        if (dx === 0 && dy === 0) {
          autoScroll.current = null
          return
        }
        element.scrollLeft += dx
        element.scrollTop += dy
        const move = gesture.current
        if (move?.type === 'move') showMove(move)
        state.frame = requestAnimationFrame(tick)
      }
      autoScroll.current = { point, frame: requestAnimationFrame(tick) }
    },
    [showMove],
  )

  const startMove = useCallback(
    (press: PressGesture, at: ClientPoint) => {
      if (press.placementId === null) return
      if (press.timer !== null) clearTimeout(press.timer)
      const move: MoveGesture = {
        type: 'move',
        pointerId: press.pointerId,
        pointerType: press.pointerType,
        last: at,
        placementId: press.placementId,
        offsetSixths: press.offsetSixths,
      }
      gesture.current = move
      capture(faceElement.current, press.pointerId)
      setMovingPlacement(press.placementId)
      showMove(move)
    },
    [showMove],
  )

  const finishMove = useCallback(
    (move: MoveGesture, at: ClientPoint) => {
      stopAutoScroll()
      setMovingPlacement(null)
      setDragGhost(null)
      const { announce, catalog, onPlaced } = latest.current
      const result = planMoveAt(move, at)
      if (result === null) {
        const plan = usePlanStore.getState().plan
        const placement = plan?.placements.find((candidate) => candidate.id === move.placementId)
        if (placement !== undefined) {
          const view = latest.current.views.find((candidate) => candidate.id === placement.id)
          announce(`${view?.name ?? 'The part'} was not moved: it was released outside the rack.`)
        }
        return
      }
      const outcome = movePlacementTo(catalog, move.placementId, { y: result.y, bay: result.bay })
      if (outcome.unchanged === true) return
      announce(outcome.message)
      if (outcome.ok) onPlaced(move.placementId)
    },
    [planMoveAt, stopAutoScroll],
  )

  /** Ends whatever is in progress without committing anything. */
  const cancel = useCallback(() => {
    const current = gesture.current
    gesture.current = null
    if (current === null) return
    stopAutoScroll()
    if (current.type === 'press') {
      if (current.timer !== null) clearTimeout(current.timer)
      return
    }
    suppressClick.current = true
    if (current.type === 'pinch') {
      for (const id of current.ids) release(faceElement.current, id)
      return
    }
    release(faceElement.current, current.pointerId)
    if (current.type === 'move') {
      setMovingPlacement(null)
      setDragGhost(null)
      const view = latest.current.views.find((candidate) => candidate.id === current.placementId)
      latest.current.announce(
        view === undefined
          ? 'Move cancelled.'
          : `Move cancelled: ${view.name} stays at ${view.position}.`,
      )
    }
  }, [stopAutoScroll])

  // ---- Pinch

  const startPinch = useCallback(() => {
    const entries = [...touches.current.entries()]
    const first = entries[0]
    const second = entries[1]
    if (first === undefined || second === undefined) return
    // A second finger puts a part being moved back (and ends a pending long-press).
    if (gesture.current !== null) cancel()
    const at = midpoint(first[1], second[1])
    gesture.current = {
      type: 'pinch',
      ids: [first[0], second[0]],
      startDistance: distance(first[1], second[1]),
      startZoom: useUiStore.getState().zoom,
      keep: latest.current.camera.drawingAt(at),
    }
    capture(faceElement.current, first[0])
    capture(faceElement.current, second[0])
    suppressClick.current = true
  }, [cancel])

  const updatePinch = useCallback((pinch: PinchGesture) => {
    const a = touches.current.get(pinch.ids[0])
    const b = touches.current.get(pinch.ids[1])
    if (a === undefined || b === undefined) return
    const zoom = pinchZoom(pinch.startZoom, pinch.startDistance, distance(a, b), ZOOM_MIN, ZOOM_MAX)
    latest.current.camera.zoomKeeping(zoom, pinch.keep, midpoint(a, b))
  }, [])

  // ---- The face's handlers

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const { pointerId, pointerType, button } = event
      lastPointerType.current = pointerType
      if (pointerType === 'mouse' && button !== 0 && button !== 1) return
      suppressClick.current = false
      faceElement.current = event.currentTarget
      const point = clientOf(event)
      if (pointerType === 'touch') {
        // A primary touch starts a new interaction: forget fingers whose lift was never seen.
        if (event.isPrimary) touches.current.clear()
        touches.current.set(pointerId, point)
        if (touches.current.size >= 2) {
          startPinch()
          return
        }
      }
      if (gesture.current !== null || !event.isPrimary || isInteractive(event.target)) return
      // The middle button pans; it must not start the browser's own autoscroll.
      if (button === 1) event.preventDefault()
      const { readOnly, views } = latest.current
      const placing = useEditorState.getState().placing !== null
      const candidate = button === 0 && !placing && !readOnly ? placementIdOf(event.target) : null
      const view = candidate === null ? undefined : views.find((each) => each.id === candidate)
      const grabbed = view === undefined ? null : drawingPointAt(point)
      const press: PressGesture = {
        type: 'press',
        pointerId,
        pointerType,
        origin: point,
        last: point,
        placementId: view?.id ?? null,
        offsetSixths:
          view === undefined
            ? 0
            : grabbed === null
              ? view.heightSixths / 2
              : grabOffsetSixths(grabbed.rawSixths, view.y, view.heightSixths),
        timer: null,
      }
      if (press.placementId !== null && pointerType === 'touch') {
        // A long-press picks the part up; moving sooner is a swipe.
        press.timer = setTimeout(() => {
          press.timer = null
          if (gesture.current === press) startMove(press, press.last)
        }, LONG_PRESS_MS)
      }
      gesture.current = press
    },
    [drawingPointAt, startMove, startPinch],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const point = clientOf(event)
      if (touches.current.has(event.pointerId)) touches.current.set(event.pointerId, point)
      const current = gesture.current
      if (current === null) return
      if (current.type === 'pinch') {
        if (current.ids.includes(event.pointerId)) updatePinch(current)
        return
      }
      if (event.pointerId !== current.pointerId) return
      switch (current.type) {
        case 'press': {
          const slop = current.pointerType === 'touch' ? TOUCH_SLOP_PX : MOUSE_DRAG_SLOP_PX
          if (distance(point, current.origin) <= slop) {
            current.last = point
            return
          }
          if (current.timer !== null) clearTimeout(current.timer)
          if (current.placementId !== null && current.pointerType !== 'touch') {
            startMove(current, point)
            autoScrollFor(point)
            return
          }
          // A background drag, or a swipe before the long-press fired: pan from where it began.
          gesture.current = { type: 'pan', pointerId: current.pointerId, last: point }
          capture(faceElement.current, current.pointerId)
          latest.current.camera.panBy(point.x - current.origin.x, point.y - current.origin.y)
          return
        }
        case 'move':
          current.last = point
          showMove(current)
          autoScrollFor(point)
          return
        case 'pan':
          latest.current.camera.panBy(point.x - current.last.x, point.y - current.last.y)
          current.last = point
          return
      }
    },
    [autoScrollFor, showMove, startMove, updatePinch],
  )

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      touches.current.delete(event.pointerId)
      const current = gesture.current
      if (current === null) return
      if (current.type === 'pinch') {
        if (!current.ids.includes(event.pointerId)) return
        gesture.current = null
        for (const id of current.ids) release(faceElement.current, id)
        return
      }
      if (event.pointerId !== current.pointerId) return
      gesture.current = null
      switch (current.type) {
        case 'press':
          // A click or a tap: RackView's click handlers take it.
          if (current.timer !== null) clearTimeout(current.timer)
          return
        case 'pan':
          suppressClick.current = true
          return
        case 'move':
          suppressClick.current = true
          finishMove(current, clientOf(event))
          return
      }
    },
    [finishMove],
  )

  const onPointerGone = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      touches.current.delete(event.pointerId)
      const current = gesture.current
      if (current === null) return
      const mine =
        current.type === 'pinch'
          ? current.ids.includes(event.pointerId)
          : current.pointerId === event.pointerId
      if (mine) cancel()
    },
    [cancel],
  )

  const onLostPointerCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // Touch and pen start captured to the element under the finger; taking that capture over
      // makes that element lose it, and the event bubbles here. Only losing our own counts.
      if (event.target !== event.currentTarget) return
      onPointerGone(event)
    },
    [onPointerGone],
  )

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClick.current) return
    suppressClick.current = false
    event.stopPropagation()
    event.preventDefault()
  }, [])

  const onContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    // A long-press on touch must not open the browser's menu over the rack.
    if (lastPointerType.current === 'touch' || gesture.current?.type === 'move') {
      event.preventDefault()
    }
  }, [])

  // ---- Escape, the view moving under a still pointer, and cleanup

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      const current = gesture.current
      if (current === null || current.type === 'press') return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [cancel])

  /** The drawing moved under a still pointer (scroll, zoom, resize): show the ghost again. */
  const refresh = useCallback(() => {
    const current = gesture.current
    if (current?.type === 'move') showMove(current)
    else if (carry.current !== null) showCarry()
  }, [showCarry, showMove])

  const { scroller, camera, layout, face, views } = options
  useEffect(() => {
    if (scroller === null) return
    scroller.addEventListener('scroll', refresh, { passive: true })
    return () => scroller.removeEventListener('scroll', refresh)
  }, [scroller, refresh])
  const shownView = useRef({ viewKey: camera.viewKey, layout, face, views })
  useEffect(() => {
    const shown = shownView.current
    const viewKey = camera.viewKey
    if (
      shown.viewKey === viewKey &&
      shown.layout === layout &&
      shown.face === face &&
      shown.views === views
    ) {
      return
    }
    shownView.current = { viewKey, layout, face, views }
    refresh()
  }, [camera.viewKey, layout, face, views, refresh])

  useEffect(
    () => () => {
      const current = gesture.current
      gesture.current = null
      if (current?.type === 'press' && current.timer !== null) clearTimeout(current.timer)
      stopAutoScroll()
      carry.current = null
      if (useRackDrag.getState().movingId !== null) setMovingPlacement(null)
      setDragGhost(null)
    },
    [stopAutoScroll],
  )

  return {
    faceProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerGone,
      onLostPointerCapture,
      onClickCapture,
      onContextMenu,
    },
    cancel,
  }
}
