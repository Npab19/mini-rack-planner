import { describe, expect, it } from 'vitest'
import {
  checkPlacement,
  formatSpan,
  grabbedStepOf,
  keyboardDelta,
  RACK_HEIGHT_MM,
  sixthsOfSvgY,
  snapStart,
  svgYOfSixths,
  U_MM,
  uNumber,
  type Placement,
} from './rackModel'

const seed: Placement[] = [
  { id: 'patch', kind: '1u', y: 42 }, // U8
  { id: 'pi', kind: 'half', y: 0 }, // lower half of U1
]

/** Centre of a U row, in fractional sixths. */
const centreOfU = (u: number) => (u - 1) * 6 + 3

describe('snapStart', () => {
  it('puts the bottom U of a palette item on the U under the pointer', () => {
    expect(snapStart(centreOfU(5), 6)).toBe(24)
    expect(uNumber(snapStart(centreOfU(5), 6))).toBe(5)
    // Anywhere inside U5 maps to U5, including just above its lower edge.
    expect(snapStart(24.01, 6)).toBe(24)
    expect(snapStart(29.99, 6)).toBe(24)
  })

  it('snaps half-U items to the half under the pointer', () => {
    expect(snapStart(12 + 1.5, 3)).toBe(12) // lower half of U3
    expect(snapStart(15 + 1.5, 3)).toBe(15) // upper half of U3
  })

  it('keeps the grabbed U under the pointer when moving', () => {
    // A 2U item grabbed by its upper U and dropped with the pointer in U9 starts at U8.
    expect(snapStart(centreOfU(9), 6, 1)).toBe(42)
  })

  it('returns negative or past-the-top starts so the caller can explain why', () => {
    expect(snapStart(-2, 6)).toBe(-6)
    expect(snapStart(centreOfU(13), 6)).toBe(72)
  })
})

describe('grabbedStepOf', () => {
  const shelf: Placement = { id: 's', kind: '2u', y: 24 }
  it('finds which U of the item the pointer is on', () => {
    expect(grabbedStepOf(centreOfU(5), shelf)).toBe(0)
    expect(grabbedStepOf(centreOfU(6), shelf)).toBe(1)
  })
  it('clamps pointers on the item edge into the item', () => {
    expect(grabbedStepOf(23.9, shelf)).toBe(0)
    expect(grabbedStepOf(36.5, shelf)).toBe(1)
  })
})

describe('checkPlacement', () => {
  it('accepts free space', () => {
    expect(checkPlacement(seed, { kind: '2u', y: 24 })).toEqual({
      ok: true,
      message: 'Fits at U5–U6',
    })
  })

  it('rejects overlaps and names the blocking item', () => {
    const verdict = checkPlacement(seed, { kind: '2u', y: 36 })
    expect(verdict.ok).toBe(false)
    expect(verdict).toMatchObject({ code: 'overlap', conflictId: 'patch' })
    expect(verdict.message).toBe('Overlaps 1U patch panel at U8')
  })

  it('treats a half-U neighbour in the same U as an overlap only if the halves meet', () => {
    expect(checkPlacement(seed, { kind: 'half', y: 3 }).ok).toBe(true) // upper half of U1
    expect(checkPlacement(seed, { kind: '1u', y: 0 }).ok).toBe(false)
  })

  it('rejects positions outside the rack', () => {
    expect(checkPlacement(seed, { kind: '2u', y: 66 })).toMatchObject({
      ok: false,
      code: 'out-of-rack',
    })
    expect(checkPlacement(seed, { kind: '1u', y: -6 })).toMatchObject({
      ok: false,
      code: 'out-of-rack',
    })
  })

  it('rejects positions off the item grid', () => {
    expect(checkPlacement(seed, { kind: '1u', y: 9 })).toMatchObject({
      ok: false,
      code: 'off-grid',
    })
  })

  it('never lets a moved item block itself', () => {
    expect(checkPlacement(seed, { kind: '1u', y: 42, ignoreId: 'patch' }).ok).toBe(true)
  })
})

describe('formatSpan', () => {
  it('formats whole and half U spans', () => {
    expect(formatSpan(24, 12)).toBe('U5–U6')
    expect(formatSpan(42, 6)).toBe('U8')
    expect(formatSpan(12, 3)).toBe('lower half of U3')
    expect(formatSpan(15, 3)).toBe('upper half of U3')
  })
})

describe('keyboardDelta', () => {
  it('moves 1U, or 5U with Shift', () => {
    expect(keyboardDelta('ArrowUp', false)).toBe(6)
    expect(keyboardDelta('ArrowDown', true)).toBe(-30)
    expect(keyboardDelta('ArrowLeft', false)).toBeNull()
  })
})

describe('SVG y axis', () => {
  it('maps the bottom of U1 to the bottom of the rack drawing', () => {
    expect(svgYOfSixths(0)).toBeCloseTo(RACK_HEIGHT_MM)
    expect(svgYOfSixths(72)).toBeCloseTo(0)
  })

  it('round-trips', () => {
    for (const sixths of [0, 3, 27, 51.5, 72]) {
      expect(sixthsOfSvgY(svgYOfSixths(sixths))).toBeCloseTo(sixths, 9)
    }
  })

  it('puts the centre of U5 4.5U above the bottom', () => {
    expect(svgYOfSixths(centreOfU(5))).toBeCloseTo(RACK_HEIGHT_MM - 4.5 * U_MM, 9)
  })
})
