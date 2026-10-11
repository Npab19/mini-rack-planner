import { describe, expect, it } from 'vitest'
import { EIA_EAR_SPACING_MM, PANEL_HEIGHT_REDUCTION_MM, U_MM } from '@/domain/geometry'
import {
  BASE_PX_PER_MM,
  basePxPerMm,
  bayAtX,
  EDGE_MARGIN_MM,
  fitZoom,
  holeColumnsX,
  innerBox,
  MIN_BASE_PX_PER_MM,
  openingOriginX,
  panelBox,
  rackLayout,
  railHoleYsMm,
  sixthsAtSvgY,
  svgYOfSixths,
  viewBoxOf,
  visualSide,
} from './rackLayout'

const NINE_U = rackLayout({ topSixths: 54, innerWidthMm: 222 })

describe('rackLayout', () => {
  it('draws the stack with room around it, in mm', () => {
    expect(NINE_U.topMm).toBeCloseTo(9 * U_MM + EDGE_MARGIN_MM)
    expect(NINE_U.bottomMm).toBe(-EDGE_MARGIN_MM)
    expect(NINE_U.height).toBeCloseTo(9 * U_MM + 2 * EDGE_MARGIN_MM)
    expect(NINE_U.panelWidthMm).toBe(254)
    expect(NINE_U.railWidthMm).toBe(16)
    expect(NINE_U.leftX).toBeLessThan(0)
    expect(NINE_U.bandX).toBeGreaterThan(254)
    expect(NINE_U.width).toBeCloseTo(NINE_U.rightX - NINE_U.leftX)
    expect(viewBoxOf(NINE_U)).toBe(`${NINE_U.leftX} 0 ${NINE_U.width} ${NINE_U.height}`)
  })

  it('grows to show placements outside the stack', () => {
    const grown = rackLayout({ topSixths: 54, contentLowSixths: -6, contentHighSixths: 66 })
    expect(grown.bottomMm).toBeCloseTo(-U_MM - EDGE_MARGIN_MM)
    expect(grown.topMm).toBeCloseTo(11 * U_MM + EDGE_MARGIN_MM)
  })

  it('flips Y: the bottom of U1 is lower on screen than the top of the stack', () => {
    expect(svgYOfSixths(NINE_U, 0)).toBeCloseTo(9 * U_MM + EDGE_MARGIN_MM)
    expect(svgYOfSixths(NINE_U, 54)).toBeCloseTo(EDGE_MARGIN_MM)
    for (const sixths of [0, 3.5, 27, 54]) {
      expect(sixthsAtSvgY(NINE_U, svgYOfSixths(NINE_U, sixths))).toBeCloseTo(sixths, 9)
    }
  })
})

describe('scale', () => {
  it('draws 1.5 px per mm at 100 %, smaller in a narrow container (a 360 px phone)', () => {
    expect(basePxPerMm(0, NINE_U)).toBe(BASE_PX_PER_MM)
    expect(basePxPerMm(2000, NINE_U)).toBe(BASE_PX_PER_MM)
    const phone = basePxPerMm(360 - 16, NINE_U)
    expect(phone).toBeLessThan(BASE_PX_PER_MM)
    expect(NINE_U.width * phone).toBeCloseTo(344)
    expect(basePxPerMm(50, NINE_U)).toBe(MIN_BASE_PX_PER_MM)
  })

  it('fits the drawing height to a viewport', () => {
    const zoom = fitZoom(600, NINE_U, BASE_PX_PER_MM)
    expect(NINE_U.height * BASE_PX_PER_MM * zoom).toBeCloseTo(600)
    expect(fitZoom(0, NINE_U, BASE_PX_PER_MM)).toBe(1)
  })
})

describe('panels and bays', () => {
  it('draws a 1U panel 0.794 mm short of 1U, centred on its U', () => {
    const box = panelBox(NINE_U, 18, 6, 'full', 'front')
    expect(box.x).toBe(0)
    expect(box.width).toBe(254)
    expect(box.height).toBeCloseTo(U_MM - PANEL_HEIGHT_REDUCTION_MM)
    const nominalTop = svgYOfSixths(NINE_U, 24)
    expect(box.y).toBeCloseTo(nominalTop + PANEL_HEIGHT_REDUCTION_MM / 2)
  })

  it('gives zero-height placeholders a small visible height', () => {
    expect(panelBox(NINE_U, 12, 0, 'full', 'front').height).toBeGreaterThan(0)
  })

  it('mirrors half bays seen from the rear', () => {
    expect(visualSide('left', 'front')).toBe('left')
    expect(visualSide('left', 'rear')).toBe('right')
    expect(visualSide('full', 'rear')).toBe('full')
    expect(panelBox(NINE_U, 0, 6, 'left', 'front')).toMatchObject({ x: 0, width: 127 })
    expect(panelBox(NINE_U, 0, 6, 'right', 'front')).toMatchObject({ x: 127, width: 127 })
    expect(panelBox(NINE_U, 0, 6, 'left', 'rear')).toMatchObject({ x: 127, width: 127 })
    expect(bayAtX(20, NINE_U, 'front')).toBe('left')
    expect(bayAtX(200, NINE_U, 'front')).toBe('right')
    expect(bayAtX(20, NINE_U, 'rear')).toBe('right')
  })

  it('puts slot origins at the inner edge of the rail (or the middle for the right half)', () => {
    expect(openingOriginX(NINE_U, 'full', 'front')).toBe(16)
    expect(openingOriginX(NINE_U, 'left', 'front')).toBe(16)
    expect(openingOriginX(NINE_U, 'right', 'front')).toBe(127)
    const full = innerBox({ x: 0, y: 10, width: 254, height: 40 }, NINE_U, 'full')
    expect(full).toMatchObject({ x: 16, width: 222 })
    const right = innerBox({ x: 127, y: 10, width: 127, height: 40 }, NINE_U, 'right')
    expect(right.x).toBe(129)
    expect(right.x + right.width).toBe(238)
  })
})

describe('rails', () => {
  it('centres the ear-hole columns at the frame spacing', () => {
    const [left, right] = holeColumnsX(NINE_U)
    expect(right - left).toBeCloseTo(EIA_EAR_SPACING_MM)
    expect((left + right) / 2).toBeCloseTo(127)
  })

  it('has three holes per U at the EIA offsets', () => {
    const holes = railHoleYsMm(NINE_U)
    expect(holes).toHaveLength(27)
    expect(holes.slice(0, 4)).toEqual([6.35, 22.225, 38.1, U_MM + 6.35])
  })
})
