import { describe, expect, it } from 'vitest'
import { ZOOM_MAX, ZOOM_MIN } from '@/state/uiStore'
import { canZoomIn, canZoomOut, formatZoom, ZOOM_STEPS, zoomInFrom, zoomOutFrom } from './zoom'

describe('zoom steps', () => {
  it('climb from the smallest to the largest zoom through 100 %', () => {
    expect(ZOOM_STEPS[0]).toBe(ZOOM_MIN)
    expect(ZOOM_STEPS.at(-1)).toBe(ZOOM_MAX)
    expect(ZOOM_STEPS).toContain(1)
    expect(ZOOM_STEPS.toSorted((a, b) => a - b)).toEqual(ZOOM_STEPS)
  })

  it('step in and out from 100 %', () => {
    expect(zoomInFrom(1)).toBe(1.1)
    expect(zoomOutFrom(1)).toBe(0.9)
    expect(zoomOutFrom(zoomInFrom(1))).toBe(1)
  })

  it('snap a fitted zoom onto the steps', () => {
    expect(zoomInFrom(0.83)).toBe(0.9)
    expect(zoomOutFrom(0.83)).toBe(0.75)
    // Within half a percent counts as the step itself.
    expect(zoomInFrom(0.749)).toBe(0.9)
    expect(zoomOutFrom(0.751)).toBe(0.67)
  })

  it('stop at the limits', () => {
    expect(zoomInFrom(ZOOM_MAX)).toBe(ZOOM_MAX)
    expect(zoomOutFrom(ZOOM_MIN)).toBe(ZOOM_MIN)
    expect(canZoomIn(ZOOM_MAX)).toBe(false)
    expect(canZoomOut(ZOOM_MIN)).toBe(false)
    expect(canZoomIn(3.9)).toBe(true)
    expect(canZoomOut(0.3)).toBe(true)
  })

  it('format as a whole percentage', () => {
    expect(formatZoom(1)).toBe('100%')
    expect(formatZoom(0.67)).toBe('67%')
    expect(formatZoom(1.125)).toBe('113%')
  })
})
