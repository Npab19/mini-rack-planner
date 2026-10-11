import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type RefObject } from 'react'
import { DRAWING, RACK_CENTER } from './rackModel'

/**
 * Camera for the rack face: zoom + pan, rendered either by changing the SVG viewBox (the SVG fills
 * the viewport) or by a CSS transform on a wrapper around a fixed-size SVG. Both draw the same
 * picture; the spike exercises both so the DnD maths is proven independent of the technique.
 */
export type ViewMode = 'viewbox' | 'css'
export type Zoom = 50 | 100 | 200

export const ZOOMS: readonly Zoom[] = [50, 100, 200]
export const VIEW_MODES: readonly ViewMode[] = ['viewbox', 'css']
/** 100 % zoom draws 1 mm as 1.5 CSS px (a 12U rack is 800 px tall). */
export const BASE_PX_PER_MM = 1.5
export const PAN_STEP_PX = 60

export function isZoom(value: unknown): value is Zoom {
  return value === 50 || value === 100 || value === 200
}

export function isViewMode(value: unknown): value is ViewMode {
  return value === 'viewbox' || value === 'css'
}

interface Size {
  width: number
  height: number
}

interface Camera {
  zoom: Zoom
  /** Drawing point (mm) shown at the centre of the viewport. */
  center: { x: number; y: number }
}

export interface RackViewGeometry {
  /** viewBox mode: the viewBox for an SVG that fills the viewport. */
  viewBox: string
  /** css mode: intrinsic SVG size (px) and the wrapper transform. */
  svgWidth: number
  svgHeight: number
  transform: string
}

export interface RackView {
  mode: ViewMode
  zoom: Zoom
  center: { x: number; y: number }
  pxPerMm: number
  geometry: RackViewGeometry
  setMode: (mode: ViewMode) => void
  setZoom: (zoom: Zoom) => void
  /** Moves the drawing by (dx, dy) screen px, like dragging the canvas. */
  panBy: (dx: number, dy: number) => void
  reset: () => void
  /** Changes whenever the drawing moves on screen (for recomputing a ghost mid-gesture). */
  viewKey: string
}

export function scaleOf(zoom: Zoom): number {
  return (BASE_PX_PER_MM * zoom) / 100
}

export function viewGeometry(camera: Camera, viewport: Size): RackViewGeometry {
  const scale = scaleOf(camera.zoom)
  const width = viewport.width || DRAWING.width * scale
  const height = viewport.height || DRAWING.height * scale
  const viewBox = [
    camera.center.x - width / scale / 2,
    camera.center.y - height / scale / 2,
    width / scale,
    height / scale,
  ]
    .map((n) => n.toFixed(4))
    .join(' ')
  const translateX = width / 2 - (camera.center.x - DRAWING.minX) * scale
  const translateY = height / 2 - (camera.center.y - DRAWING.minY) * scale
  return {
    viewBox,
    svgWidth: DRAWING.width * BASE_PX_PER_MM,
    svgHeight: DRAWING.height * BASE_PX_PER_MM,
    transform: `translate(${translateX.toFixed(2)}px, ${translateY.toFixed(2)}px) scale(${camera.zoom / 100})`,
  }
}

const WHEEL_LINE_PX = 16

export function useRackView(
  viewportRef: RefObject<HTMLElement | null>,
  initial: { mode: ViewMode; zoom: Zoom },
): RackView {
  const [mode, setMode] = useState<ViewMode>(initial.mode)
  const [camera, setCamera] = useState<Camera>({ zoom: initial.zoom, center: RACK_CENTER })
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = () => {
      // Padding box: the SVG fills it, so the border must not count towards the scale.
      const width = element.clientWidth
      const height = element.clientHeight
      setViewport((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [viewportRef])

  const panBy = useCallback((dx: number, dy: number) => {
    setCamera((previous) => {
      const scale = scaleOf(previous.zoom)
      return {
        ...previous,
        center: { x: previous.center.x - dx / scale, y: previous.center.y - dy / scale },
      }
    })
  }, [])

  // Wheel pans the canvas. React's onWheel is passive, so preventDefault needs a native listener.
  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PX : 1
      panBy(-event.deltaX * unit, -event.deltaY * unit)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [viewportRef, panBy])

  const setZoom = useCallback((zoom: Zoom) => {
    setCamera((previous) => ({ ...previous, zoom }))
  }, [])

  const reset = useCallback(() => {
    setCamera((previous) => ({ ...previous, center: RACK_CENTER }))
  }, [])

  const geometry = useMemo(() => viewGeometry(camera, viewport), [camera, viewport])
  const viewKey = `${mode}|${camera.zoom}|${camera.center.x}|${camera.center.y}|${viewport.width}x${viewport.height}`

  return {
    mode,
    zoom: camera.zoom,
    center: camera.center,
    pxPerMm: scaleOf(camera.zoom),
    geometry,
    setMode,
    setZoom,
    panBy,
    reset,
    viewKey,
  }
}
