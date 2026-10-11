import { describe, expect, it } from 'vitest'
import { SIXTH_MM, sixthsToMm } from '@/domain/geometry'
import { snapY } from '@/domain/placement'
import {
  applyMatrix,
  centredStart,
  clientToRack,
  clientToSvg,
  invertMatrix,
  type MatrixLike,
  type ScreenCtmSource,
} from './pointer'
import { rackLayout, svgYOfSixths, type RackLayout } from './rackLayout'

/**
 * The screen CTM of an SVG drawn at `pxPerMm` (zoom included) whose viewBox starts at
 * (minX, minY), with its box at (left, top) in client px (scrolling moves `left`/`top`).
 */
function screenCtm(pxPerMm: number, minX: number, minY: number, left: number, top: number) {
  return {
    a: pxPerMm,
    b: 0,
    c: 0,
    d: pxPerMm,
    e: left - minX * pxPerMm,
    f: top - minY * pxPerMm,
  } satisfies MatrixLike
}

/** What `svg.getScreenCTM()` gives the helper: a matrix with an `inverse()`. */
function source(matrix: MatrixLike | null): ScreenCtmSource {
  return {
    getScreenCTM: () =>
      matrix === null
        ? null
        : {
            inverse: () => {
              const inverse = invertMatrix(matrix)
              if (inverse === null) throw new Error('singular')
              return inverse
            },
          },
  }
}

/** Client px of an SVG point under `matrix`. */
function toClient(matrix: MatrixLike, x: number, y: number) {
  return applyMatrix(matrix, x, y)
}

const TWELVE_U = rackLayout({ topSixths: 72 })

describe('invertMatrix', () => {
  it('inverts translations, scales and rotations (round trip)', () => {
    const angle = Math.PI / 7
    const matrix: MatrixLike = {
      a: 2 * Math.cos(angle),
      b: 2 * Math.sin(angle),
      c: -3 * Math.sin(angle),
      d: 3 * Math.cos(angle),
      e: 40,
      f: -12,
    }
    const inverse = invertMatrix(matrix)
    expect(inverse).not.toBeNull()
    if (inverse === null) return
    for (const [x, y] of [
      [0, 0],
      [10, -4],
      [254, 533.4],
    ] as const) {
      const there = applyMatrix(matrix, x, y)
      const back = applyMatrix(inverse, there.x, there.y)
      expect(back.x).toBeCloseTo(x, 9)
      expect(back.y).toBeCloseTo(y, 9)
    }
  })

  it('returns null for a singular matrix (nothing maps back)', () => {
    expect(invertMatrix({ a: 0, b: 0, c: 0, d: 0, e: 5, f: 5 })).toBeNull()
    expect(invertMatrix({ a: 1, b: 2, c: 2, d: 4, e: 0, f: 0 })).toBeNull()
  })
})

describe('clientToSvg', () => {
  it.each([
    { zoom: 0.5, minX: -24, minY: 0, left: 0, top: 0 },
    { zoom: 1, minX: -24, minY: 0, left: 120, top: 64 },
    { zoom: 2, minX: -24, minY: 0, left: -300, top: -900 },
    { zoom: 4, minX: 10, minY: -50, left: 33.5, top: 7.25 },
  ])('maps client px back to mm at zoom $zoom (viewBox at $minX,$minY)', (view) => {
    const matrix = screenCtm(1.5 * view.zoom, view.minX, view.minY, view.left, view.top)
    for (const [x, y] of [
      [view.minX, view.minY],
      [127, 266.7],
      [254, 533.4],
    ] as const) {
      const client = toClient(matrix, x, y)
      const svg = clientToSvg(source(matrix), client.x, client.y)
      expect(svg?.x).toBeCloseTo(x, 9)
      expect(svg?.y).toBeCloseTo(y, 9)
    }
  })

  it('gives null without a CTM or for a non-finite pointer', () => {
    expect(clientToSvg(source(null), 10, 10)).toBeNull()
    const matrix = screenCtm(1.5, 0, 0, 0, 0)
    expect(clientToSvg(source(matrix), Number.NaN, 10)).toBeNull()
    expect(clientToSvg(source(matrix), 10, Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('clientToRack', () => {
  /** Client px of the middle of a sixth `ySixths` up the rack, at x mm, in `layout`. */
  function clientAt(matrix: MatrixLike, layout: RackLayout, xMm: number, ySixths: number) {
    return toClient(matrix, xMm, svgYOfSixths(layout, ySixths))
  }

  it.each([0.25, 0.5, 1, 2, 4])(
    'finds the same sixth at %s× zoom, wherever the drawing is scrolled',
    (zoom) => {
      for (const scroll of [
        { left: 0, top: 0 },
        { left: -210, top: -1337 },
      ]) {
        const matrix = screenCtm(1.5 * zoom, TWELVE_U.leftX, 0, scroll.left, scroll.top)
        // The middle of U5 is 27 sixths up; the middle of U1 is 3.
        for (const sixths of [3, 27, 27.5, 71]) {
          const client = clientAt(matrix, TWELVE_U, 100, sixths)
          const point = clientToRack(source(matrix), client.x, client.y, TWELVE_U)
          expect(point?.rawSixths).toBeCloseTo(sixths, 9)
          expect(point?.yMm).toBeCloseTo(sixthsToMm(sixths), 9)
          expect(point?.xMm).toBeCloseTo(100, 9)
        }
      }
    },
  )

  it('follows the viewBox when the drawing grows below U1 (a stray placement)', () => {
    const stretched = rackLayout({ topSixths: 72, contentLowSixths: -12, contentHighSixths: 90 })
    expect(stretched.height).toBeGreaterThan(TWELVE_U.height)
    const matrix = screenCtm(1.5, stretched.leftX, 0, 50, 20)
    const client = clientAt(matrix, stretched, 127, -6)
    expect(clientToRack(source(matrix), client.x, client.y, stretched)?.rawSixths).toBeCloseTo(
      -6,
      9,
    )
  })

  it('maps one CSS pixel to the expected fraction of a sixth', () => {
    const matrix = screenCtm(1.5, TWELVE_U.leftX, 0, 0, 0)
    const a = clientToRack(source(matrix), 10, 100, TWELVE_U)
    const b = clientToRack(source(matrix), 10, 101, TWELVE_U)
    // Down the screen is down the rack.
    expect((a?.rawSixths ?? 0) - (b?.rawSixths ?? 0)).toBeCloseTo(1 / 1.5 / SIXTH_MM, 9)
  })
})

describe('centredStart + snapY (where the ghost lands)', () => {
  it('puts a 1U item on the U under the pointer', () => {
    // Anywhere in U5 (sixths 24 up to 30) gives U5.
    for (const pointer of [24.1, 25, 27, 29.9]) {
      expect(snapY(centredStart(pointer, 6), [0])).toBe(24)
    }
    expect(snapY(centredStart(23.9, 6), [0])).toBe(18)
  })

  it('covers the U under the pointer and the nearer neighbour with a 2U item', () => {
    expect(snapY(centredStart(28.5, 12), [0])).toBe(24) // upper half of U5: U5–U6
    expect(snapY(centredStart(25.5, 12), [0])).toBe(18) // lower half of U5: U4–U5
  })

  it('picks the half of the U under the pointer for a ½U item', () => {
    expect(snapY(centredStart(25, 3), [0, 3])).toBe(24)
    expect(snapY(centredStart(28.5, 3), [0, 3])).toBe(27)
  })
})
