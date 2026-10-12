import { describe, expect, it } from 'vitest'
import {
  clientPointOf,
  distance,
  EDGE_SCROLL_MAX_PX,
  edgeScrollDelta,
  grabOffsetSixths,
  isInsideRect,
  midpoint,
  moveTargetY,
  pinchZoom,
} from './gesture'

describe('points and rects', () => {
  it('measures distances and midpoints between two pointers', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(midpoint({ x: 10, y: 20 }, { x: 30, y: 60 })).toEqual({ x: 20, y: 40 })
  })

  it('tells whether a point is inside a rect, edges included', () => {
    const rect = { left: 10, top: 20, right: 110, bottom: 220 }
    expect(isInsideRect(rect, { x: 10, y: 20 })).toBe(true)
    expect(isInsideRect(rect, { x: 110, y: 220 })).toBe(true)
    expect(isInsideRect(rect, { x: 60, y: 120 })).toBe(true)
    expect(isInsideRect(rect, { x: 9.9, y: 120 })).toBe(false)
    expect(isInsideRect(rect, { x: 60, y: 220.1 })).toBe(false)
  })

  it('reads no point from something that is not a mouse or pointer event', () => {
    expect(clientPointOf(undefined)).toBeNull()
    expect(clientPointOf({ clientX: 1, clientY: 2 })).toBeNull()
  })
})

describe('moving a placed part', () => {
  it('keeps the grabbed U under the pointer', () => {
    // A 2U part at U5–U6 (sixths 24–36) grabbed in the middle of its upper U (sixth 33).
    const offset = grabOffsetSixths(33, 24, 12)
    expect(offset).toBe(9)
    // The pointer goes to the middle of U9 (sixth 51): the grabbed U (the upper one) is U9, so
    // the part starts at U8.
    expect(moveTargetY(51, offset, [0])).toBe(42)
    // Grabbed in its lower U, the same pointer puts its bottom at U9.
    expect(moveTargetY(51, grabOffsetSixths(27, 24, 12), [0])).toBe(48)
  })

  it('clamps the grab to the part and snaps to the allowed phases', () => {
    expect(grabOffsetSixths(10, 24, 12)).toBe(0)
    expect(grabOffsetSixths(50, 24, 12)).toBe(12)
    expect(grabOffsetSixths(Number.NaN, 24, 12)).toBe(0)
    // A ½U part with phases 0 and 3 lands on the nearest half.
    expect(moveTargetY(16.2, 1.5, [0, 3])).toBe(15)
    expect(moveTargetY(17.8, 1.5, [0, 3])).toBe(15)
    expect(moveTargetY(19.6, 1.5, [0, 3])).toBe(18)
  })
})

describe('pinchZoom', () => {
  it('scales the start zoom by how far the fingers spread, within the limits', () => {
    expect(pinchZoom(1, 100, 150, 0.25, 4)).toBeCloseTo(1.5, 9)
    expect(pinchZoom(2, 200, 100, 0.25, 4)).toBeCloseTo(1, 9)
    expect(pinchZoom(1, 100, 1000, 0.25, 4)).toBe(4)
    expect(pinchZoom(1, 100, 1, 0.25, 4)).toBe(0.25)
  })

  it('keeps the start zoom when the fingers start on the same spot', () => {
    expect(pinchZoom(1.25, 0, 50, 0.25, 4)).toBe(1.25)
    expect(pinchZoom(1.25, 50, 0, 0.25, 4)).toBe(1.25)
  })
})

describe('edgeScrollDelta', () => {
  it('scrolls toward the edge the pointer is near, faster closer to it', () => {
    // A 400 px tall viewport from y = 100 to 500, 40 px zones.
    expect(edgeScrollDelta(300, 100, 500)).toBe(0)
    expect(edgeScrollDelta(139, 100, 500)).toBeLessThan(0)
    expect(edgeScrollDelta(101, 100, 500)).toBe(-Math.ceil((39 / 40) * EDGE_SCROLL_MAX_PX))
    expect(edgeScrollDelta(461, 100, 500)).toBeGreaterThan(0)
    expect(edgeScrollDelta(499, 100, 500)).toBe(Math.ceil((39 / 40) * EDGE_SCROLL_MAX_PX))
    expect(Math.abs(edgeScrollDelta(105, 100, 500))).toBeGreaterThan(
      Math.abs(edgeScrollDelta(130, 100, 500)),
    )
  })

  it('does not scroll outside the viewport or in one too small for two zones', () => {
    expect(edgeScrollDelta(90, 100, 500)).toBe(0)
    expect(edgeScrollDelta(510, 100, 500)).toBe(0)
    expect(edgeScrollDelta(105, 100, 170)).toBe(0)
  })
})
