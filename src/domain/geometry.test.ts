import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import {
  EIA_EAR_SPACING_MM,
  EIA_HOLE_OFFSETS_PER_U_MM,
  formatU,
  GEAR_WIDTH_GUIDE_MM,
  isWholeU,
  mmToSixthsCeil,
  mmToSixthsFloor,
  NOMINAL_OPENING_MM,
  PANEL_WIDTH_MM,
  panelFaceHeightMm,
  phaseOf,
  railHoleYsMm,
  SIXTH_MM,
  sixthsToMm,
  sixthsToU,
  U_MM,
  uNumberAt,
  uToSixths,
} from './geometry'

describe('constants', () => {
  it('match the 10" rack research facts', () => {
    expect(U_MM).toBe(44.45)
    expect(SIXTH_MM).toBeCloseTo(7.408333, 6)
    expect(PANEL_WIDTH_MM).toBe(254)
    expect(EIA_EAR_SPACING_MM).toBe(236.525)
    expect(EIA_HOLE_OFFSETS_PER_U_MM).toEqual([6.35, 22.225, 38.1])
    expect(NOMINAL_OPENING_MM).toBe(222.25)
    expect(GEAR_WIDTH_GUIDE_MM).toBe(210)
  })
})

describe('conversions', () => {
  it('converts U and sixths', () => {
    expect(uToSixths(1)).toBe(6)
    expect(uToSixths(0.5)).toBe(3)
    expect(uToSixths(1 / 3)).toBe(2)
    expect(uToSixths(12)).toBe(72)
    expect(sixthsToU(9)).toBe(1.5)
  })

  it('keeps whole U exact in millimetres', () => {
    expect(sixthsToMm(6)).toBe(44.45)
    expect(sixthsToMm(3)).toBe(22.225)
    expect(sixthsToMm(12)).toBe(88.9)
    expect(sixthsToMm(2)).toBeCloseTo(14.816667, 6)
  })

  it('rounds millimetres to sixths in the requested direction', () => {
    expect(mmToSixthsCeil(44.45)).toBe(6)
    expect(mmToSixthsCeil(44.46)).toBe(7)
    expect(mmToSixthsCeil(0)).toBe(0)
    expect(Object.is(mmToSixthsCeil(0), 0)).toBe(true)
    expect(mmToSixthsFloor(44.45)).toBe(6)
    expect(mmToSixthsFloor(44.44)).toBe(5)
    expect(mmToSixthsFloor(7)).toBe(0)
  })

  test.prop([fc.integer({ min: 0, max: 600 })])('sixths -> mm -> sixths round-trips', (sixths) => {
    const mm = sixthsToMm(sixths)
    expect(mmToSixthsCeil(mm)).toBe(sixths)
    expect(mmToSixthsFloor(mm)).toBe(sixths)
  })

  test.prop([fc.double({ min: 0, max: 5000, noNaN: true })])(
    'ceil and floor bracket the height',
    (mm) => {
      expect(sixthsToMm(mmToSixthsCeil(mm))).toBeGreaterThanOrEqual(mm - 1e-6)
      expect(sixthsToMm(mmToSixthsFloor(mm))).toBeLessThanOrEqual(mm + 1e-6)
      expect(mmToSixthsCeil(mm) - mmToSixthsFloor(mm)).toBeLessThanOrEqual(1)
    },
  )
})

describe('panelFaceHeightMm', () => {
  it('subtracts 0.794 mm from the nominal height', () => {
    expect(panelFaceHeightMm(6)).toBeCloseTo(43.656, 6)
    expect(panelFaceHeightMm(12)).toBeCloseTo(88.106, 6)
    expect(panelFaceHeightMm(3)).toBeCloseTo(21.431, 6)
    expect(panelFaceHeightMm(0)).toBe(0)
  })
})

describe('formatU', () => {
  it.each([
    [6, '1U'],
    [3, '½U'],
    [9, '1½U'],
    [2, '⅓U'],
    [4, '⅔U'],
    [8, '1⅓U'],
    [10, '1⅔U'],
    [1, '⅙U'],
    [5, '⅚U'],
    [72, '12U'],
    [0, '0U'],
    [-18, '-3U'],
  ])('%i sixths -> %s', (sixths, label) => {
    expect(formatU(sixths)).toBe(label)
  })

  it('flags whole U', () => {
    expect(isWholeU(12)).toBe(true)
    expect(isWholeU(9)).toBe(false)
  })
})

describe('uNumberAt', () => {
  it('labels the U containing y (1-based)', () => {
    expect(uNumberAt(0)).toBe(1)
    expect(uNumberAt(5)).toBe(1)
    expect(uNumberAt(6)).toBe(2)
    expect(uNumberAt(71)).toBe(12)
  })
})

describe('phaseOf', () => {
  it('is the position within its U, also below U1', () => {
    expect(phaseOf(0)).toBe(0)
    expect(phaseOf(27)).toBe(3)
    expect(phaseOf(-1)).toBe(5)
    expect(phaseOf(-6)).toBe(0)
  })
})

describe('railHoleYsMm', () => {
  it('lists every hole centre bottom to top', () => {
    const ys = railHoleYsMm(2)
    expect(ys).toHaveLength(6)
    expect(ys[0]).toBeCloseTo(6.35, 9)
    expect(ys[3]).toBeCloseTo(50.8, 9)
    expect(ys[5]).toBeCloseTo(82.55, 9)
  })

  it('accepts a frame-specific hole pattern', () => {
    expect(railHoleYsMm(1, [10, 30])).toEqual([10, 30])
  })
})
