/**
 * The to-scale rack (M3a): the frame for the face being viewed, the section bands with + handles,
 * what is mounted, click-to-place with a ghost, keyboard editing and a "Rack contents" list for
 * screen readers.
 *
 * Placing (`useEditorState.placing`, started by the palette or the equipment tray):
 * - Pointer: the pointer maps through `svg.getScreenCTM().inverse()` to sixths, the item is
 *   centred on it, snapped to its allowed phases and checked with `canPlace`; the ghost shows ✓/✗
 *   and the first reason. A click on a valid spot commits one undo step (In my rack in Recording
 *   mode), ends placing and selects the new part, so the inspector shows it; Shift-click keeps
 *   placing, so several can go in a row. Esc, the banner's Cancel or the palette stop placing (the
 *   shell owns those). A click on a blocked spot announces why.
 * - Keyboard: with the drawing itself focused (the palette focuses it after "Place"), ↑/↓ move the
 *   ghost one allowed step (Shift: 5), ←/→ pick the half for half-width items, Enter places (and
 *   focuses the new part; Shift+Enter keeps placing).
 * - "Add at U…" (the banner, the palette and the inspector ask through `requestAddAtU`) lists
 *   every free start; placing that way selects the new part too.
 *
 * Placed items: Tab reaches one placement (roving tabindex); ↑/↓ go to the item above/below,
 * Home/End to the top/bottom one. Enter/Space selects it (inspector: selection tab). On the
 * selected item ↑/↓ move it one allowed step (Shift: 5), Alt+↑/↓ move without selecting first,
 * Esc clears the selection. Delete/Backspace removes it (toast with Undo), Ctrl/Cmd+D copies it to
 * the nearest free spot above. Every result is announced here; F, zoom, Esc while placing and
 * undo are the shell's global shortcuts. A selection made elsewhere (checks, inspector lists) is
 * scrolled into view.
 *
 * Zoom is `uiStore.zoom` (the toolbar's buttons, Ctrl/Cmd + wheel here); the shell's rack viewport
 * scrolls (pan). Standalone (no shell), the view scrolls itself.
 */
import { CircleCheck, CircleX, TriangleAlert } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import { toast } from 'sonner'
import { LiveRegion, useAnnouncer } from '@/components/common/LiveRegion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { formatU, uToSixths } from '@/domain/geometry'
import { effectiveFrameSize } from '@/domain/recipe'
import type { CatalogLookup, Frame } from '@/domain/schema/catalog'
import type { PlacementBay, Plan } from '@/domain/schema/plan'
import { cn } from '@/lib/utils'
import { usePlanLookup } from '@/state/derived'
import { usePlanStore } from '@/state/planStore'
import { isRecording, useUiStore } from '@/state/uiStore'
import { useEditorState, type Ghost, type PlaceSource } from '../editorState'
import { useSpareContext } from '../inspector/planOps'
import { insertSectionRequest } from '../inspector/sectionOps'
import { useStackOps } from '../inspector/useStackOps'
import { useRackViewport } from '../layout/rackViewport'
import { closeSheetThen, focusPanel } from '../layout/shellStore'
import { placementForId, selectInEditor } from '../selection'
import { useAddAtURequest } from '../toolbar/addAtURequest'
import { useFitRequest } from '../toolbar/fitRequest'
import { AddAtUDialog } from './AddAtUDialog'
import {
  duplicatePlacementNearby,
  movePlacementBy,
  placeAt,
  READ_ONLY_MESSAGE,
  removePlacement,
} from './commit'
import { GhostShape } from './GhostShape'
import { InsertHandles } from './InsertHandles'
import { ghostText, positionText } from './labels'
import {
  addedSectionId,
  checkSpot,
  describeSource,
  firstSpot,
  sourceKey,
  spotAt,
  steppedSpot,
  type SourceInfo,
  type Spot,
  type SpotCheck,
} from './placeActions'
import { PlacementFocusRing, PlacementShape } from './PlacementShape'
import { centredStart, clientToRack } from './pointer'
import { RackContentsList } from './RackContentsList'
import { RackDefs, useRackPatterns } from './RackDefs'
import { JointPlates, RackFrame, SectionBand } from './RackFrame'
import { basePxPerMm, bayAtX, fitZoom, rackLayout, viewBoxOf } from './rackLayout'
import {
  contentsGroups,
  focusOrder,
  insertGaps,
  jointViews,
  placementViews,
  sectionChoices,
  sectionViews,
  type DeviceView,
  type InsertGap,
  type PlacementView,
  type SectionChoice,
} from './rackModel'
import { useElementSize } from './useElementSize'

/** Space around the drawing inside the scroll container (px, both sides together). */
const VIEWPORT_PADDING_PX = 16
/** Ctrl + wheel: zoom factor per wheel pixel (exponential, so in and out are symmetric). */
const WHEEL_ZOOM_RATE = 0.0015

const KEYBOARD_HELP =
  'Enter selects. Arrow keys go to the item above or below; on the selected item they move it, Shift moves 5 steps. Escape clears the selection. Delete removes it, Control+D duplicates it.'

const PLACING_HELP =
  'Placing: the arrow keys move the spot, Shift moves 5 steps, left and right pick a half for half-width parts, Enter places it.'

export function RackView() {
  const plan = usePlanStore((state) => state.plan)
  const catalog = usePlanLookup()
  if (plan === null) {
    return (
      <section aria-label="Rack" className="p-3 text-sm text-muted-foreground">
        No plan is open.
      </section>
    )
  }
  const frame = catalog.frame(plan.frame.frameId)
  if (frame === undefined) {
    return (
      <section aria-label="Rack" className="p-3">
        <Alert>
          <TriangleAlert aria-hidden />
          <AlertTitle>This rack's frame is not in the catalog</AlertTitle>
          <AlertDescription>
            The plan uses the frame “{plan.frame.frameId}”, which this version does not know, so the
            rack cannot be drawn. Its parts are still listed in the shopping list.
          </AlertDescription>
        </Alert>
      </section>
    )
  }
  return <RackPanel plan={plan} catalog={catalog} frame={frame} />
}

interface Evaluated {
  info: SourceInfo
  spot: Spot
  check: SpotCheck
}

interface EvalCache extends Evaluated {
  plan: Plan
  catalog: CatalogLookup
  source: string
  key: string
}

interface ZoomAnchor {
  /** Pointer position in the scroll container (px). */
  x: number
  y: number
  left: number
  top: number
  from: number
}

function sameGhost(a: Ghost | null, b: Ghost): boolean {
  return (
    a !== null &&
    a.y === b.y &&
    a.heightSixths === b.heightSixths &&
    a.face === b.face &&
    a.ok === b.ok &&
    a.reasons.length === b.reasons.length &&
    a.reasons.every((reason, index) => reason === b.reasons[index])
  )
}

/** Focus that shows a focus ring (keyboard, or code after a key press); true where unknown. */
function isKeyboardFocus(element: Element): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    return true
  }
}

function placementIdOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  return target.closest('[data-placement-id]')?.getAttribute('data-placement-id') ?? null
}

/** Selects ids and shows them in the inspector's selection tab (see `selectInEditor`). */
function showSelection(ids: readonly string[]): void {
  selectInEditor(ids)
}

/**
 * Shift keeps placing after a placement, so several go in a row; a device from the tray goes in
 * once (it leaves the tray), so placing it always ends.
 */
function keepsPlacing(source: PlaceSource, shiftKey: boolean): boolean {
  return shiftKey && source.equipmentId === undefined
}

/** What "Add at U…" was asked to add, while its dialog is open. */
interface AddAtRequest {
  open: boolean
  source: PlaceSource | null
  /** Asked by the placing banner: placing what is being placed, which then ends. */
  fromPlacing: boolean
}

const ADD_AT_CLOSED: AddAtRequest = { open: false, source: null, fromPlacing: false }

/** "U5: free." / "U4: It overlaps Lenovo Tiny mount 1U (U4)." for a keyboard ghost move. */
function spotStatus({ info, spot, check }: Evaluated): string {
  const where = positionText(spot.y, info.heightSixths)
  const half = spot.bay === 'full' ? '' : `, ${spot.bay} half`
  return `${where}${half}: ${check.ok ? 'free.' : (check.reasons[0] ?? 'blocked.')}`
}

function RackPanel({ plan, catalog, frame }: { plan: Plan; catalog: CatalogLookup; frame: Frame }) {
  const planId = usePlanStore((state) => state.planId)
  const readOnly = usePlanStore((state) => state.readOnly)
  const face = useUiStore((state) => state.face)
  const zoom = useUiStore((state) => state.zoom)
  const selection = useUiStore((state) => state.selection)
  const placing = useEditorState((state) => state.placing)
  const ghost = useEditorState((state) => state.ghost)
  const [message, announce] = useAnnouncer()
  // Building in Recording mode uses up loose spares, as Mark as In my rack does.
  const spares = useSpareContext()
  const patterns = useRackPatterns()
  const helpId = useId()
  const placingHelpId = useId()

  // ---- What to draw (memoized: the rack must stay smooth with 40 placements)
  const sections = useMemo(() => sectionViews(plan, frame), [plan, frame])
  const joints = useMemo(() => jointViews(plan, frame), [plan, frame])
  const views = useMemo(() => placementViews(plan.placements, catalog), [plan.placements, catalog])
  const faceViews = useMemo(() => views.filter((view) => view.face === face), [views, face])
  const viewById = useMemo(() => new Map(views.map((view) => [view.id, view])), [views])
  const order = useMemo(() => focusOrder(faceViews), [faceViews])
  const groups = useMemo(() => contentsGroups(sections, views), [sections, views])
  const gaps = useMemo(() => insertGaps(sections), [sections])
  const topSixths = sections.at(-1)?.endSixths ?? 0
  const totalU = sections.reduce((sum, section) => sum + section.heightU, 0)
  let contentLow = 0
  let contentHigh = 0
  for (const view of faceViews) {
    contentLow = Math.min(contentLow, view.y)
    contentHigh = Math.max(contentHigh, view.y + Math.max(view.heightSixths, 1))
  }
  const innerWidthMm = effectiveFrameSize(frame, plan.frame.options).innerWidthMm
  const layout = useMemo(
    () =>
      rackLayout({
        panelWidthMm: frame.standard.panelWidthMm,
        innerWidthMm,
        earSpacingMm: frame.rail.earSpacingMm,
        holeOffsetsPerUMm: frame.rail.holeOffsetsPerUMm,
        topSixths,
        contentLowSixths: contentLow,
        contentHighSixths: contentHigh,
      }),
    [frame, innerWidthMm, topSixths, contentLow, contentHigh],
  )

  // ---- The scroll container: the shell's rack viewport, else our own (standalone)
  const shellViewport = useRackViewport()
  const [ownScroller, setOwnScroller] = useState<HTMLDivElement | null>(null)
  const scroller = shellViewport ?? ownScroller
  // Scroll positions are written through a ref (never through a value held in state).
  const scrollerRef = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    scrollerRef.current = scroller
  }, [scroller])
  const viewport = useElementSize(scroller)
  const svgRef = useRef<SVGSVGElement>(null)
  const basePx = basePxPerMm(viewport.width - VIEWPORT_PADDING_PX, layout)
  const pxPerMm = basePx * zoom
  const zoomAnchor = useRef<ZoomAnchor | null>(null)

  useEffect(() => {
    if (scroller === null) return
    const element = scroller
    function onWheel(event: WheelEvent): void {
      if (!(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      const ui = useUiStore.getState()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
      const rect = element.getBoundingClientRect()
      zoomAnchor.current = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        left: element.scrollLeft,
        top: element.scrollTop,
        from: ui.zoom,
      }
      ui.setZoom(ui.zoom * Math.exp(-event.deltaY * unit * WHEEL_ZOOM_RATE))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [scroller])

  // Keep the point under the pointer still while Ctrl + wheel zooms.
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current
    const element = scrollerRef.current
    zoomAnchor.current = null
    if (anchor === null || element === null || anchor.from === zoom) return
    const ratio = zoom / anchor.from
    element.scrollLeft = (anchor.left + anchor.x) * ratio - anchor.x
    element.scrollTop = (anchor.top + anchor.y) * ratio - anchor.y
  }, [zoom])

  /** Zooms so the whole drawing height fits the viewport (the shell announces the result). */
  const fitToView = useCallback(() => {
    const element = scrollerRef.current
    const width = (element?.clientWidth ?? 0) - VIEWPORT_PADDING_PX
    const height = (element?.clientHeight ?? 0) - VIEWPORT_PADDING_PX
    useUiStore.getState().setZoom(fitZoom(height, layout, basePxPerMm(width, layout)))
    if (element !== null) {
      element.scrollTop = 0
      element.scrollLeft = 0
    }
  }, [layout])
  useFitRequest(fitToView)

  // A rack taller than the view starts fitted (once per plan this view shows).
  const autoFitted = useRef<string | null>(null)
  useEffect(() => {
    if (planId === null || autoFitted.current === planId || viewport.height <= 0) return
    autoFitted.current = planId
    if (layout.height * pxPerMm > viewport.height - VIEWPORT_PADDING_PX) fitToView()
  }, [planId, viewport.height, layout, pxPerMm, fitToView])

  // ---- Focus (roving tabindex over the placements on this face)
  const nodes = useRef(new Map<string, SVGGElement>())
  const register = useCallback((id: string, node: SVGGElement | null) => {
    if (node === null) nodes.current.delete(id)
    else nodes.current.set(id, node)
  }, [])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  /** The placement with keyboard focus: it gets the focus ring. */
  const [keyboardFocusId, setKeyboardFocusId] = useState<string | null>(null)
  const pendingFocus = useRef<string | null>(null)
  const selectedOnFace = selection.find((id) => order.includes(id))
  const rovingId =
    activeId !== null && order.includes(activeId) ? activeId : (selectedOnFace ?? order[0] ?? null)
  const movingId =
    focusedId !== null && selection.length === 1 && selection[0] === focusedId ? focusedId : null

  useEffect(() => {
    if (useEditorState.getState().moving !== movingId) useEditorState.getState().setMoving(movingId)
  }, [movingId])
  useEffect(
    () => () => {
      if (useEditorState.getState().moving !== null) useEditorState.getState().setMoving(null)
    },
    [],
  )

  // Focus that waits for the next render (a new copy, the neighbour of a removed item). With no
  // item left on this face, the top section band takes it (it has a visible focus ring too).
  useEffect(() => {
    const id = pendingFocus.current
    if (id === null) return
    const bands = svgRef.current?.querySelectorAll<SVGGElement>('[data-section-id]')
    const node = id === '' ? bands?.[bands.length - 1] : nodes.current.get(id)
    if (node === undefined || node === null) return
    pendingFocus.current = null
    node.focus()
  })

  const focusPlacement = useCallback((id: string) => {
    setActiveId(id)
    nodes.current.get(id)?.focus()
  }, [])

  // ---- Placing: pointer or keyboard -> ghost -> commit
  const lastPointer = useRef<{ x: number; y: number } | null>(null)
  /** The keyboard ghost's spot, for the source it was made for. */
  const keyboardSpot = useRef<{ source: string; spot: Spot } | null>(null)
  const evalCache = useRef<EvalCache | null>(null)
  const [ghostBay, setGhostBay] = useState<PlacementBay>('full')

  /** Checks `source` at a spot (cached per plan, source and spot: pointer moves repeat a lot). */
  const evaluateSpot = useCallback(
    (source: PlaceSource, current: Plan, toSpot: (info: SourceInfo) => Spot): Evaluated => {
      const cached = evalCache.current
      const sKey = sourceKey(source)
      const fresh =
        cached !== null &&
        cached.plan === current &&
        cached.catalog === catalog &&
        cached.source === sKey
      const info = fresh ? cached.info : describeSource(current, catalog, frame, source)
      const spot = toSpot(info)
      const key = `${spot.y}|${spot.bay}|${spot.face}`
      if (fresh && cached.key === key) return cached
      const check = checkSpot(current, catalog, frame, info, spot)
      const next: EvalCache = { plan: current, catalog, source: sKey, key, info, spot, check }
      evalCache.current = next
      return next
    },
    [catalog, frame],
  )

  /** Where `source` would land under the pointer, and whether it can. */
  const evaluateAt = useCallback(
    (clientX: number, clientY: number, source: PlaceSource, current: Plan): Evaluated | null => {
      const svg = svgRef.current
      if (svg === null || typeof svg.getScreenCTM !== 'function') return null
      const point = clientToRack(svg, clientX, clientY, layout)
      if (point === null) return null
      return evaluateSpot(source, current, (info) =>
        spotAt(
          info,
          centredStart(point.rawSixths, info.heightSixths),
          face,
          bayAtX(point.xMm, layout, face),
        ),
      )
    },
    [layout, face, evaluateSpot],
  )

  const showGhost = useCallback((evaluated: Evaluated) => {
    const next: Ghost = {
      y: evaluated.spot.y,
      heightSixths: evaluated.info.heightSixths,
      face: evaluated.spot.face,
      ok: evaluated.check.ok,
      reasons: evaluated.check.reasons,
    }
    const editor = useEditorState.getState()
    if (!sameGhost(editor.ghost, next)) editor.setGhost(next)
    setGhostBay(evaluated.spot.bay)
  }, [])

  // The plan, face or zoom changed under a still pointer (or keyboard ghost): check again, so
  // right after placing the ghost says the spot is taken.
  useEffect(() => {
    if (placing === null) return
    const pointer = lastPointer.current
    if (pointer !== null) {
      const evaluated = evaluateAt(pointer.x, pointer.y, placing, plan)
      if (evaluated !== null) showGhost(evaluated)
      return
    }
    const keyed = keyboardSpot.current
    if (keyed === null || keyed.source !== sourceKey(placing)) return
    showGhost(evaluateSpot(placing, plan, () => ({ ...keyed.spot, face })))
  }, [placing, plan, face, evaluateAt, evaluateSpot, showGhost])

  /**
   * Places at an evaluated spot, or says why not. Placing then ends and the new part is selected
   * (the inspector shows it; from the keyboard it also gets focus, so the arrows move it), unless
   * `keepPlacing` (Shift) asks to place another one.
   */
  const commitSpot = useCallback(
    (source: PlaceSource, evaluated: Evaluated, keepPlacing: boolean, fromKeyboard: boolean) => {
      showGhost(evaluated)
      const { info, spot, check } = evaluated
      if (!check.ok) {
        const where = positionText(spot.y, info.heightSixths)
        announce(`${info.name} can't go at ${where}: ${check.reasons[0] ?? 'it does not fit.'}`)
        return
      }
      const outcome = placeAt(catalog, source, spot, spares)
      if (!outcome.ok) {
        announce(outcome.message)
        toast.error(outcome.message)
        return
      }
      if (keepPlacing) {
        announce(`${outcome.message} Still placing: choose the next spot.`)
        return
      }
      lastPointer.current = null
      keyboardSpot.current = null
      useEditorState.getState().cancelPlacing()
      const createdId = outcome.createdId
      if (createdId !== undefined) {
        showSelection([createdId])
        setActiveId(createdId)
        if (fromKeyboard) pendingFocus.current = createdId
      }
      announce(
        createdId === undefined
          ? outcome.message
          : `${outcome.message} It is selected${fromKeyboard ? '; the arrow keys move it' : ''}.`,
      )
    },
    [catalog, spares, announce, showGhost],
  )

  function onPointerMove(event: PointerEvent<SVGSVGElement>): void {
    const source = useEditorState.getState().placing
    const current = usePlanStore.getState().plan
    if (source === null || current === null) return
    lastPointer.current = { x: event.clientX, y: event.clientY }
    keyboardSpot.current = null
    const evaluated = evaluateAt(event.clientX, event.clientY, source, current)
    if (evaluated !== null) showGhost(evaluated)
  }

  function onPointerLeave(event: PointerEvent<SVGSVGElement>): void {
    // A touch lifts with a pointerleave: keep a blocked tap's ✗ and its reason on screen.
    if (event.pointerType === 'touch') return
    lastPointer.current = null
    const editor = useEditorState.getState()
    if (editor.ghost !== null && keyboardSpot.current === null) editor.setGhost(null)
  }

  /** While placing, a click anywhere on the drawing places (it never selects). */
  function onClickCapture(event: MouseEvent<SVGSVGElement>): void {
    const source = useEditorState.getState().placing
    if (source === null) return
    event.stopPropagation()
    event.preventDefault()
    const current = usePlanStore.getState().plan
    if (current === null) return
    lastPointer.current = { x: event.clientX, y: event.clientY }
    keyboardSpot.current = null
    const evaluated = evaluateAt(event.clientX, event.clientY, source, current)
    if (evaluated !== null)
      commitSpot(source, evaluated, keepsPlacing(source, event.shiftKey), false)
  }

  /** Keys on the drawing itself while placing: move the keyboard ghost, Enter places. */
  function onPlacingKey(event: KeyboardEvent<SVGSVGElement>, source: PlaceSource): void {
    const current = usePlanStore.getState().plan
    if (current === null) return
    const { key } = event
    const moves = key === 'ArrowUp' || key === 'ArrowDown'
    const sides = key === 'ArrowLeft' || key === 'ArrowRight'
    const places = key === 'Enter' || key === ' '
    if (!moves && !sides && !places) return
    event.preventDefault()
    const sKey = sourceKey(source)
    const keyed = keyboardSpot.current
    const visible = useEditorState.getState().ghost
    const info = describeSource(current, catalog, frame, source)
    let spot: Spot
    if (keyed !== null && keyed.source === sKey) {
      spot = { ...keyed.spot, face }
    } else if (visible !== null && visible.face === face) {
      // Carry on from where the pointer left the ghost.
      spot = {
        y: visible.y,
        face,
        bay: info.half ? (ghostBay === 'full' ? 'left' : ghostBay) : 'full',
      }
    } else {
      // Nothing shown yet: the first key shows where it would go (never places blind).
      const first = firstSpot(current, catalog, frame, info, face)
      lastPointer.current = null
      keyboardSpot.current = { source: sKey, spot: first }
      const evaluated = evaluateSpot(source, current, () => first)
      showGhost(evaluated)
      announce(spotStatus(evaluated))
      return
    }
    if (moves) {
      const direction = key === 'ArrowUp' ? 1 : -1
      const stepped = steppedSpot(spot, info, topSixths, direction, event.shiftKey ? 5 : 1)
      if (stepped === null) {
        announce(
          direction === 1 ? 'That is the top of the rack.' : 'That is the bottom of the rack.',
        )
        return
      }
      spot = stepped
    } else if (sides) {
      if (!info.half) return
      // The half on the viewer's left is the rack's right when looking at the rear.
      const viewerLeft = key === 'ArrowLeft'
      spot = { ...spot, bay: (face === 'front') === viewerLeft ? 'left' : 'right' }
    }
    lastPointer.current = null
    keyboardSpot.current = { source: sKey, spot }
    const chosen = spot
    const evaluated = evaluateSpot(source, current, () => chosen)
    if (places) {
      commitSpot(source, evaluated, keepsPlacing(source, event.shiftKey), true)
    } else {
      showGhost(evaluated)
      announce(spotStatus(evaluated))
    }
  }

  function onClick(event: MouseEvent<SVGSVGElement>): void {
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('[data-section-id]')) return // the band handles it
    const placementId = placementIdOf(target)
    if (placementId === null) {
      // Empty rack space: clear the selection.
      if (useUiStore.getState().selection.length > 0) useUiStore.getState().clearSelection()
      return
    }
    const deviceId = target?.closest('[data-device-id]')?.getAttribute('data-device-id') ?? null
    const id = deviceId ?? placementId
    selectInEditor([id], { toggle: event.shiftKey || event.ctrlKey || event.metaKey })
    setActiveId(placementId)
  }

  // ---- Selection
  const selectSection = useCallback(
    (sectionId: string, event?: MouseEvent | KeyboardEvent) => {
      if (event !== undefined && (event.shiftKey || event.ctrlKey || event.metaKey)) {
        selectInEditor([sectionId], { toggle: true })
        return
      }
      showSelection([sectionId])
      const section = sections.find((candidate) => candidate.id === sectionId)
      if (section !== undefined) announce(`Selected ${section.ordinalLabel}.`)
    },
    [sections, announce],
  )

  const selectPlacementView = useCallback(
    (view: PlacementView) => {
      showSelection([view.id])
      setActiveId(view.id)
      announce(`Selected ${view.name}, ${view.position}.`)
    },
    [announce],
  )

  const selectDevice = useCallback(
    (_view: PlacementView, device: DeviceView) => {
      showSelection([device.id])
      announce(`Selected ${device.name}.`)
    },
    [announce],
  )

  // A selection made elsewhere (checks, the inspector's lists, a new part) comes into view. The
  // nearest edge only: a part already on screen stays where it is.
  const primaryId = selection[0]
  useEffect(() => {
    const current = usePlanStore.getState().plan
    if (primaryId === undefined || current === null) return
    const placement = placementForId(current, primaryId)
    if (placement === undefined || placement.face !== face) return
    nodes.current.get(placement.id)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [primaryId, face])

  // ---- Keyboard editing
  const removeWithUndo = useCallback(
    (id: string) => {
      const index = order.indexOf(id)
      const neighbour = order[index + 1] ?? order[index - 1] ?? null
      const outcome = removePlacement(catalog, id)
      announce(outcome.message)
      if (!outcome.ok) return
      const ui = useUiStore.getState()
      if (ui.selection.includes(id)) ui.select(ui.selection.filter((selected) => selected !== id))
      setActiveId(neighbour)
      pendingFocus.current = neighbour ?? ''
      const after = usePlanStore.getState().plan
      toast(outcome.message, {
        action: {
          label: 'Undo',
          onClick: () => {
            const store = usePlanStore.getState()
            if (store.plan !== after) {
              announce('The rack changed since then: use Undo in the toolbar.')
              return
            }
            store.undo()
            announce('Undone: the item is back.')
          },
        },
      })
    },
    [order, catalog, announce],
  )

  const duplicate = useCallback(
    (id: string) => {
      const outcome = duplicatePlacementNearby(catalog, id, spares)
      announce(outcome.message)
      if (!outcome.ok || outcome.createdId === undefined) return
      showSelection([outcome.createdId])
      setActiveId(outcome.createdId)
      pendingFocus.current = outcome.createdId
    },
    [catalog, spares, announce],
  )

  function onSvgKeyDown(event: KeyboardEvent<SVGSVGElement>): void {
    if (event.target === event.currentTarget) {
      const source = useEditorState.getState().placing
      if (source !== null && !event.altKey && !event.ctrlKey && !event.metaKey) {
        onPlacingKey(event, source)
      }
      return
    }
    const id = placementIdOf(event.target)
    if (id === null) return
    const view = viewById.get(id)
    const key = event.key
    const selected = useUiStore.getState().selection.includes(id)
    if (key === 'Enter' || key === ' ') {
      event.preventDefault()
      showSelection([id])
      setActiveId(id)
      if (view !== undefined) {
        announce(`Selected ${view.name}, ${view.position}. The arrow keys now move it.`)
      }
      return
    }
    if (key === 'Escape') {
      // While placing, Esc stops placing (the shell's shortcut).
      if (useEditorState.getState().placing !== null || !selected) return
      event.preventDefault()
      useUiStore.getState().clearSelection()
      announce('Selection cleared. The arrow keys go to the item above or below again.')
      return
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      event.preventDefault()
      const direction = key === 'ArrowUp' ? 1 : -1
      if (event.altKey || selected) {
        if (readOnly) {
          announce(READ_ONLY_MESSAGE)
          return
        }
        if (!selected) showSelection([id])
        announce(movePlacementBy(catalog, id, direction, event.shiftKey ? 5 : 1).message)
        return
      }
      const index = order.indexOf(id)
      const next = order[direction === 1 ? index - 1 : index + 1]
      if (next === undefined) {
        announce(direction === 1 ? 'This is the top item.' : 'This is the bottom item.')
      } else {
        focusPlacement(next)
      }
      return
    }
    if (key === 'Home' || key === 'End') {
      const next = key === 'Home' ? order[0] : order.at(-1)
      if (next === undefined) return
      event.preventDefault()
      focusPlacement(next)
      return
    }
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault()
      if (readOnly) announce(READ_ONLY_MESSAGE)
      else removeWithUndo(id)
      return
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && key.toLowerCase() === 'd') {
      event.preventDefault()
      if (readOnly) announce(READ_ONLY_MESSAGE)
      else duplicate(id)
    }
  }

  function onSvgFocus(event: FocusEvent<SVGSVGElement>): void {
    const id = placementIdOf(event.target)
    setFocusedId(id)
    const keyboard = event.target instanceof Element && isKeyboardFocus(event.target)
    setKeyboardFocusId(id !== null && keyboard ? id : null)
    if (id !== null) {
      setActiveId(id)
      return
    }
    // The drawing itself got keyboard focus while placing (the palette's "Place"): offer the
    // keyboard ghost. A mouse click on empty space focuses it too, but then the click places.
    const source = useEditorState.getState().placing
    if (event.target !== event.currentTarget || source === null) return
    if (!isKeyboardFocus(event.currentTarget)) return
    const info = describeSource(plan, catalog, frame, source)
    const keyed = keyboardSpot.current
    const spot =
      keyed !== null && keyed.source === sourceKey(source)
        ? { ...keyed.spot, face }
        : firstSpot(plan, catalog, frame, info, face)
    keyboardSpot.current = { source: sourceKey(source), spot }
    lastPointer.current = null
    const evaluated = evaluateSpot(source, plan, () => spot)
    showGhost(evaluated)
    announce(
      `Placing ${info.name}: the arrow keys choose a spot, Enter places it. ${spotStatus(evaluated)}`,
    )
  }

  // ---- Sections: the + handles run the Rack tab's insert (the same conflict dialog and words)
  const stackOps = useStackOps(announce, spares)
  const runStackOp = useRef(stackOps.run)
  useLayoutEffect(() => {
    runStackOp.current = stackOps.run
  })

  const insert = useCallback(
    (gap: InsertGap, choice: SectionChoice) => {
      const type = frame.sectionTypes.find((candidate) => candidate.id === choice.typeId)
      if (type === undefined) return
      const request = insertSectionRequest(
        { frame, lookup: catalog },
        type,
        { index: gap.index, phrase: gap.phrase },
        isRecording(usePlanStore.getState().planId),
        typeof type.heightU === 'number' ? undefined : choice.heightU,
      )
      const outcome = runStackOp.current({
        ...request,
        // The new section is selected, so the inspector shows it.
        applied: (before, after) => {
          const createdId = addedSectionId(before, after)
          if (createdId !== undefined) showSelection([createdId])
        },
      })
      if (outcome.status === 'error') {
        announce(outcome.message)
        toast.error(outcome.message)
      }
    },
    [frame, catalog, announce],
  )

  // ---- "Add at U…": the placing banner, the palette and the inspector ask for it (see
  // addAtURequest.ts). What it adds is fixed when it opens: placing ends once something is placed.
  const [addAt, setAddAt] = useState<AddAtRequest>(ADD_AT_CLOSED)
  const addedAt = useRef<string | null>(null)
  useAddAtURequest((source) => {
    const what = source ?? useEditorState.getState().placing
    if (what === null) return
    // Below lg the palette and the inspector ask from inside a sheet: it closes first.
    closeSheetThen(() => setAddAt({ open: true, source: what, fromPlacing: source === undefined }))
  })

  const placedFromDialog = useCallback(
    (placementId: string) => {
      if (addAt.fromPlacing) useEditorState.getState().cancelPlacing()
      showSelection([placementId])
      setActiveId(placementId)
      addedAt.current = placementId
    },
    [addAt.fromPlacing],
  )

  /**
   * What opened the dialog is gone (the placing banner ends with placing; the inspector now shows
   * the new part): focus the new part in the inspector when it came from there, else on the rack.
   */
  const focusAddedPart = useCallback(() => {
    const id = addedAt.current
    addedAt.current = null
    if (id === null) return
    if (!addAt.fromPlacing && focusPanel('inspector')) return
    nodes.current.get(id)?.focus()
  }, [addAt.fromPlacing])

  // ---- Rendering
  const shownGhost = ghost !== null && ghost.face === face ? ghost : null
  const focused = keyboardFocusId === null ? undefined : viewById.get(keyboardFocusId)
  const focusRingView = focused?.face === face ? focused : undefined
  const widthPx = layout.width * pxPerMm
  const heightPx = layout.height * pxPerMm
  const standalone = shellViewport === null
  const summary = `${formatU(uToSixths(totalU))}, ${sections.length} ${sections.length === 1 ? 'section' : 'sections'}, ${faceViews.length} ${faceViews.length === 1 ? 'item' : 'items'}`

  return (
    <section
      aria-label="Rack"
      data-testid="rack-view"
      className={cn('relative flex flex-col', standalone ? 'h-full min-h-0' : 'min-h-full')}
    >
      <div
        ref={setOwnScroller}
        data-testid="rack-scroll"
        className={cn(
          'relative p-2',
          standalone && 'min-h-0 flex-1 overflow-auto overscroll-contain',
        )}
      >
        {sections.length === 0 ? (
          <EmptyStack frame={frame} readOnly={readOnly} onInsert={insert} gaps={gaps} />
        ) : (
          <div className="relative mx-auto" style={{ width: widthPx, height: heightPx }}>
            <svg
              ref={svgRef}
              data-testid="rack-svg"
              role="group"
              aria-label={`Rack, ${face} view: ${summary}`}
              aria-describedby={placing === null ? undefined : placingHelpId}
              tabIndex={-1}
              width={widthPx}
              height={heightPx}
              viewBox={viewBoxOf(layout)}
              data-zoom={zoom}
              className={cn(
                'block rounded-md font-sans outline-none select-none focus-visible:ring-2 focus-visible:ring-ring',
                placing !== null && 'cursor-crosshair',
              )}
              onPointerMove={onPointerMove}
              onPointerLeave={onPointerLeave}
              onClickCapture={onClickCapture}
              onClick={onClick}
              onKeyDown={onSvgKeyDown}
              onFocus={onSvgFocus}
              onBlur={() => {
                setFocusedId(null)
                setKeyboardFocusId(null)
              }}
            >
              <RackDefs patterns={patterns} />
              <RackFrame layout={layout} joints={joints} patterns={patterns} />
              <g data-layer="placements">
                {/* Plan order, never sorted: moving a node in the DOM would drop its focus. */}
                {faceViews.map((view) => (
                  <PlacementShape
                    key={view.id}
                    view={view}
                    layout={layout}
                    patterns={patterns}
                    selected={selection.includes(view.id)}
                    selectedDeviceId={
                      view.devices.find((device) => selection.includes(device.id))?.id ?? null
                    }
                    roving={view.id === rovingId}
                    moving={view.id === movingId}
                    helpId={helpId}
                    register={register}
                  />
                ))}
              </g>
              <g data-layer="sections">
                {sections.map((section) => (
                  <SectionBand
                    key={section.id}
                    section={section}
                    layout={layout}
                    patterns={patterns}
                    selected={selection.includes(section.id)}
                    onActivate={selectSection}
                  />
                ))}
              </g>
              <JointPlates joints={joints} layout={layout} />
              {focusRingView === undefined ? null : (
                <PlacementFocusRing view={focusRingView} layout={layout} />
              )}
              {shownGhost === null ? null : (
                <GhostShape ghost={shownGhost} bay={ghostBay} layout={layout} patterns={patterns} />
              )}
            </svg>
            {readOnly ? null : (
              <InsertHandles
                gaps={gaps}
                layout={layout}
                pxPerMm={pxPerMm}
                frame={frame}
                totalU={totalU}
                onInsert={insert}
              />
            )}
          </div>
        )}
        {placing === null || shownGhost === null ? null : <GhostStatus ghost={shownGhost} />}
      </div>
      <RackContentsList
        groups={groups}
        selection={selection}
        onSelectSection={selectSection}
        onSelectPlacement={selectPlacementView}
        onSelectDevice={selectDevice}
      />
      <p id={helpId} className="sr-only">
        {KEYBOARD_HELP}
      </p>
      <p id={placingHelpId} className="sr-only">
        {PLACING_HELP}
      </p>
      <LiveRegion message={message} />
      {stackOps.dialog}
      <AddAtUDialog
        open={addAt.open}
        onOpenChange={(open) => setAddAt((current) => ({ ...current, open }))}
        source={addAt.source}
        onPlaced={placedFromDialog}
        focusAfterPlacing={focusAddedPart}
      />
    </section>
  )
}

/**
 * The ghost's verdict in full (the drawing has room for a shortened one), pinned to the bottom of
 * the view while placing. Not announced: a click or Enter says the result.
 */
function GhostStatus({ ghost }: { ghost: Ghost }) {
  const Icon = ghost.ok ? CircleCheck : CircleX
  return (
    <p
      aria-hidden="true"
      data-testid="rack-ghost-status"
      className={cn(
        'pointer-events-none sticky bottom-2 z-10 mx-auto mt-2 flex w-fit max-w-full items-center gap-1.5 rounded-full border bg-background/95 px-3 py-1 text-sm shadow-sm',
        ghost.ok ? 'text-foreground' : 'border-destructive/40 text-destructive',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span>{ghostText(ghost)}</span>
    </p>
  )
}

function EmptyStack({
  frame,
  readOnly,
  gaps,
  onInsert,
}: {
  frame: Frame
  readOnly: boolean
  gaps: readonly InsertGap[]
  onInsert: (gap: InsertGap, choice: SectionChoice) => void
}) {
  const gap = gaps[0]
  return (
    <div className="mx-auto grid max-w-sm gap-3 rounded-xl border border-dashed bg-background p-4 text-sm">
      <p className="font-medium">This rack has no sections yet.</p>
      <p className="text-muted-foreground">
        {frame.name} racks are built from sections. Add the first one to start.
      </p>
      {readOnly || gap === undefined ? null : (
        <div className="flex flex-wrap gap-2">
          {sectionChoices(frame).map((choice) => (
            <Button
              key={choice.typeId}
              size="sm"
              variant="outline"
              onClick={() => onInsert(gap, choice)}
            >
              Add a {choice.label} section
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
