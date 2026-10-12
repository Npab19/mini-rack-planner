/**
 * The rack's camera (M3b): zoom (`uiStore.zoom`: the toolbar's buttons, the [ ] keys and Fit) and
 * pan (the scroll position of the rack's scroll container), plus the gestures that change them:
 * Ctrl/Cmd + wheel and pinch zoom around the pointer; background drags, swipes and two-finger
 * pans scroll (`panBy` and `zoomKeeping`, called by `useRackDnd`).
 *
 * Nothing is cached across a gesture. Zooming reads the drawing point under the anchor through the
 * SVG's screen CTM before the zoom re-renders, and corrects the scroll position right after (a
 * layout effect), so that point stays exactly where it was on screen whatever the padding or
 * centring around the drawing. Toolbar zooms keep the middle of the view still; Fit (and a rack
 * that opens taller than the view) scrolls to the top left.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { useUiStore } from '@/state/uiStore'
import { useFitRequest } from '../toolbar/fitRequest'
import type { ClientPoint } from './gesture'
import { clientToSvg, svgToClient, type Point } from './pointer'
import { basePxPerMm, fitZoom, type RackLayout } from './rackLayout'
import { useElementSize, type ElementSize } from './useElementSize'

/** Space around the drawing inside the scroll container (px, both sides together). */
export const VIEWPORT_PADDING_PX = 16
/** Ctrl + wheel: zoom factor per wheel pixel (exponential, so in and out are symmetric). */
export const WHEEL_ZOOM_RATE = 0.0015

export interface RackCamera {
  /** 1 = 100 %. */
  zoom: number
  /** CSS px per mm at 100 % (smaller in a narrow view, so the rack fits a phone). */
  basePx: number
  pxPerMm: number
  viewport: ElementSize
  /** Changes whenever the drawing's size on screen changes (zoom, view size). */
  viewKey: string
  /** Moves the drawing by screen px, like dragging it: positive dx shows more of the left. */
  panBy: (dx: number, dy: number) => void
  /** The drawing point (SVG user units, mm) under a client point now; null without a CTM. */
  drawingAt: (point: ClientPoint) => Point | null
  /**
   * Zooms so the drawing point `keep` ends up under the client point `at` (a pinch: the point
   * between the fingers, which may have moved too). Without `keep` it is a plain zoom.
   */
  zoomKeeping: (zoom: number, keep: Point | null, at: ClientPoint) => void
  /** Zooms keeping what is under a client point still (Ctrl + wheel). */
  zoomAt: (zoom: number, at: ClientPoint) => void
  /** Zooms so the whole drawing height fits the view, then shows its top left. */
  fitToView: () => void
}

type Anchor = { kind: 'point'; keep: Point; at: ClientPoint } | { kind: 'origin' }

export interface UseRackViewOptions {
  /** The scroll container (the shell's rack viewport, or the rack's own). */
  scroller: HTMLElement | null
  svgRef: RefObject<SVGSVGElement | null>
  layout: RackLayout
  /** A rack taller than the view starts fitted, once per plan. */
  planId: string | null
}

function screenCtmOf(svg: SVGSVGElement | null): SVGSVGElement | null {
  return svg !== null && typeof svg.getScreenCTM === 'function' ? svg : null
}

export function useRackView({ scroller, svgRef, layout, planId }: UseRackViewOptions): RackCamera {
  const zoom = useUiStore((state) => state.zoom)
  const viewport = useElementSize(scroller)
  const basePx = basePxPerMm(viewport.width - VIEWPORT_PADDING_PX, layout)
  const pxPerMm = basePx * zoom

  // Scroll positions are written through a ref (never through a value held in state).
  const scrollerRef = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    scrollerRef.current = scroller
  }, [scroller])
  /** Where the next zoom's render must put the drawing (set before the zoom changes). */
  const pending = useRef<Anchor | null>(null)

  const drawingAt = useCallback(
    (point: ClientPoint): Point | null => {
      const svg = screenCtmOf(svgRef.current)
      return svg === null ? null : clientToSvg(svg, point.x, point.y)
    },
    [svgRef],
  )

  const applyAnchor = useCallback(
    (anchor: Anchor) => {
      const element = scrollerRef.current
      if (element === null) return
      if (anchor.kind === 'origin') {
        element.scrollTop = 0
        element.scrollLeft = 0
        return
      }
      const svg = screenCtmOf(svgRef.current)
      const now = svg === null ? null : svgToClient(svg, anchor.keep.x, anchor.keep.y)
      if (now === null) return
      element.scrollLeft += now.x - anchor.at.x
      element.scrollTop += now.y - anchor.at.y
    },
    [svgRef],
  )

  // After a zoom renders, put the anchored point back where it belongs.
  const renderedZoom = useRef(zoom)
  useLayoutEffect(() => {
    if (renderedZoom.current === zoom) return
    renderedZoom.current = zoom
    const anchor = pending.current
    pending.current = null
    if (anchor !== null) applyAnchor(anchor)
  }, [zoom, applyAnchor])

  // A zoom from elsewhere (the toolbar, the keys) keeps the middle of the view still. The store
  // notifies before React re-renders, so the CTM read here is still the old one.
  useEffect(
    () =>
      useUiStore.subscribe((state, previous) => {
        if (state.zoom === previous.zoom || pending.current !== null) return
        const element = scrollerRef.current
        if (element === null) return
        const rect = element.getBoundingClientRect()
        const at = {
          x: rect.left + element.clientWidth / 2,
          y: rect.top + element.clientHeight / 2,
        }
        const keep = drawingAt(at)
        if (keep !== null) pending.current = { kind: 'point', keep, at }
      }),
    [drawingAt],
  )

  const zoomKeeping = useCallback(
    (next: number, keep: Point | null, at: ClientPoint) => {
      const ui = useUiStore.getState()
      // Several zooms before one render (fast wheels): the first point is the one to keep.
      const earlier = pending.current
      const point = earlier?.kind === 'point' ? earlier.keep : keep
      if (point !== null) pending.current = { kind: 'point', keep: point, at }
      const before = ui.zoom
      ui.setZoom(next)
      if (useUiStore.getState().zoom !== before) return
      // At a zoom limit nothing re-renders: apply the move now (a two-finger pan still pans).
      const anchor = pending.current
      pending.current = null
      if (anchor !== null) applyAnchor(anchor)
    },
    [applyAnchor],
  )

  const zoomAt = useCallback(
    (next: number, at: ClientPoint) => zoomKeeping(next, drawingAt(at), at),
    [zoomKeeping, drawingAt],
  )

  const panBy = useCallback((dx: number, dy: number) => {
    const element = scrollerRef.current
    if (element === null) return
    if (dx !== 0) element.scrollLeft -= dx
    if (dy !== 0) element.scrollTop -= dy
  }, [])

  const fitToView = useCallback(() => {
    const element = scrollerRef.current
    const width = (element?.clientWidth ?? 0) - VIEWPORT_PADDING_PX
    const height = (element?.clientHeight ?? 0) - VIEWPORT_PADDING_PX
    const before = useUiStore.getState().zoom
    pending.current = { kind: 'origin' }
    useUiStore.getState().setZoom(fitZoom(height, layout, basePxPerMm(width, layout)))
    // Already at that zoom: nothing re-renders to take the anchor.
    if (useUiStore.getState().zoom === before) pending.current = null
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

  // Ctrl/Cmd + wheel zooms around the pointer (trackpad pinches arrive as Ctrl + wheel too); a
  // plain wheel scrolls as usual. React's onWheel is passive, so preventDefault needs this.
  const zoomAtRef = useRef(zoomAt)
  useLayoutEffect(() => {
    zoomAtRef.current = zoomAt
  }, [zoomAt])
  useEffect(() => {
    if (scroller === null) return
    const element = scroller
    function onWheel(event: WheelEvent): void {
      if (!(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
      const current = useUiStore.getState().zoom
      zoomAtRef.current(current * Math.exp(-event.deltaY * unit * WHEEL_ZOOM_RATE), {
        x: event.clientX,
        y: event.clientY,
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [scroller])

  return {
    zoom,
    basePx,
    pxPerMm,
    viewport,
    viewKey: `${zoom}|${basePx}|${viewport.width}x${viewport.height}`,
    panBy,
    drawingAt,
    zoomKeeping,
    zoomAt,
    fitToView,
  }
}
