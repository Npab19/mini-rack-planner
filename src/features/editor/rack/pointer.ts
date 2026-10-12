/**
 * Pointer -> rack position. Pure: the only DOM call is the caller's `svg.getScreenCTM()`, passed
 * in as a `ScreenCtmSource`, so the maths runs (and is tested) without a browser.
 *
 * The screen CTM maps SVG user units (mm) to client CSS px. It already accounts for the viewBox,
 * the zoom (the SVG's px size), the scroll container's pan, page scroll and CSS transforms on
 * ancestors, so it is read at event time and never cached across a gesture (spike S2).
 */
import { SIXTH_MM } from '@/domain/geometry'
import type { RackLayout } from './rackLayout'

/** A 2D affine matrix in SVG/DOMMatrix order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export interface MatrixLike {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

/** What `SVGGraphicsElement.getScreenCTM()` returns, reduced to what the mapping uses. */
export interface ScreenCtmSource {
  getScreenCTM(): { inverse(): MatrixLike } | null
}

export interface Point {
  x: number
  y: number
}

export function applyMatrix(m: MatrixLike, x: number, y: number): Point {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }
}

/** Inverse of an affine matrix; null when it is singular (nothing maps back). */
export function invertMatrix(m: MatrixLike): MatrixLike | null {
  const det = m.a * m.d - m.b * m.c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  }
}

/** Client px -> SVG user units through `getScreenCTM().inverse()`; null when it cannot map. */
export function clientToSvg(
  source: ScreenCtmSource,
  clientX: number,
  clientY: number,
): Point | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null
  const ctm = source.getScreenCTM()
  if (ctm === null) return null
  const point = applyMatrix(ctm.inverse(), clientX, clientY)
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null
}

/** The screen CTM with its own entries too (DOMMatrix has both), for the forward mapping. */
export interface ScreenMatrixSource {
  getScreenCTM(): (MatrixLike & { inverse(): MatrixLike }) | null
}

/** SVG user units -> client px through `getScreenCTM()`; null when it cannot map. */
export function svgToClient(source: ScreenMatrixSource, x: number, y: number): Point | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const ctm = source.getScreenCTM()
  if (ctm === null) return null
  const point = applyMatrix(ctm, x, y)
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null
}

export interface RackPoint {
  /** X in the drawing (0 = left edge of the panel area as seen by the viewer). */
  xMm: number
  /** Rack height in mm (0 = bottom of U1). */
  yMm: number
  /** The same height in (fractional) sixths of a U. */
  rawSixths: number
}

/** Client px -> rack coordinates of the drawing `layout` describes. */
export function clientToRack(
  source: ScreenCtmSource,
  clientX: number,
  clientY: number,
  layout: RackLayout,
): RackPoint | null {
  const point = clientToSvg(source, clientX, clientY)
  if (point === null) return null
  const yMm = layout.topMm - point.y
  return { xMm: point.x, yMm, rawSixths: yMm / SIXTH_MM }
}

/**
 * Raw start (fractional sixths) for an item `heightSixths` tall centred on the pointer; `snapY`
 * then picks the nearest allowed start. Centring keeps tall items under the pointer: a 2U item
 * covers the U under the pointer and the nearer neighbour.
 */
export function centredStart(rawSixths: number, heightSixths: number): number {
  return rawSixths - Math.max(heightSixths, 0) / 2
}
