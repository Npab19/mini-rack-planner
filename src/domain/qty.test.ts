import { describe, expect, it } from 'vitest'
import {
  evaluateCondition,
  evaluateLength,
  evaluateQty,
  jointPasses,
  type ConditionContext,
  type QtyContext,
} from './qty'

// A [6, 3, 6] stack seen as a whole.
const stackCtx: QtyContext = {
  u: 15,
  sectionCounts: { s6: 2, s3: 1 },
  sectionCountAny: 3,
  joints: [
    ['s6', 's3'],
    ['s3', 's6'],
  ],
}

describe('evaluateQty', () => {
  it('returns plain numbers as is', () => {
    expect(evaluateQty(16, stackCtx)).toBe(16)
  })

  it('adds every term of a formula', () => {
    expect(evaluateQty({ base: 7 }, stackCtx)).toBe(7)
    expect(evaluateQty({ perU: 12 }, stackCtx)).toBe(180)
    expect(evaluateQty({ perSection: { s6: 56, s3: 16 } }, stackCtx)).toBe(128)
    expect(evaluateQty({ perSectionAny: 16 }, stackCtx)).toBe(48)
    expect(evaluateQty({ perJoint: 1 }, stackCtx)).toBe(2)
    expect(evaluateQty({ base: 7, perSection: { s6: 56, s3: 16 } }, stackCtx)).toBe(135)
  })

  it('ignores section types that are not in scope', () => {
    expect(evaluateQty({ perSection: { s9: 4 } }, stackCtx)).toBe(0)
  })

  it('applies the joint filter', () => {
    const qty = { perJoint: 3, jointFilter: { notAdjacentTo: ['s3'] } }
    expect(evaluateQty(qty, stackCtx)).toBe(0)
    expect(evaluateQty(qty, { ...stackCtx, joints: [['s6', 's6']] })).toBe(3)
  })

  it('does not round', () => {
    expect(evaluateQty({ perU: 0.5 }, { ...stackCtx, u: 3 })).toBe(1.5)
  })

  it('treats an empty formula as zero', () => {
    expect(evaluateQty({}, stackCtx)).toBe(0)
  })
})

describe('jointPasses', () => {
  it('passes without a filter and rejects either neighbour', () => {
    expect(jointPasses(['s3', 's6'], undefined)).toBe(true)
    expect(jointPasses(['s3', 's6'], { notAdjacentTo: ['s6'] })).toBe(false)
    expect(jointPasses(['s3', 's6'], { notAdjacentTo: ['s3'] })).toBe(false)
    expect(jointPasses(['s6', 's6'], { notAdjacentTo: ['s3'] })).toBe(true)
  })
})

describe('evaluateLength', () => {
  it('computes base + perU × u and never goes negative', () => {
    expect(evaluateLength({ base: -5, perU: 44.45 }, { u: 6 })).toBeCloseTo(261.7, 9)
    expect(evaluateLength({ base: -50, perU: 0 }, { u: 6 })).toBe(0)
  })
})

describe('evaluateCondition', () => {
  const ctx: ConditionContext = {
    options: { magnets: true, top: 'handle', depth: 250 },
    stack: { u: 12, sectionTypes: ['s3', 's6', 's3'] },
  }

  it('treats a missing condition as true', () => {
    expect(evaluateCondition(undefined, ctx)).toBe(true)
  })

  it('matches option values by equality or membership', () => {
    expect(evaluateCondition({ option: { magnets: true } }, ctx)).toBe(true)
    expect(evaluateCondition({ option: { magnets: false } }, ctx)).toBe(false)
    expect(evaluateCondition({ option: { top: ['flat', 'handle'] } }, ctx)).toBe(true)
    expect(evaluateCondition({ option: { top: ['flat', 'fan'] } }, ctx)).toBe(false)
    expect(evaluateCondition({ option: { depth: 250 } }, ctx)).toBe(true)
  })

  it('requires every listed option to match', () => {
    expect(evaluateCondition({ option: { magnets: true, top: 'flat' } }, ctx)).toBe(false)
  })

  it('reads a missing option as undefined', () => {
    expect(evaluateCondition({ option: { grill: true } }, ctx)).toBe(false)
    expect(evaluateCondition({ not: { option: { grill: true } } }, ctx)).toBe(true)
  })

  it('checks stack facts', () => {
    expect(evaluateCondition({ stack: { minU: 12, maxU: 12 } }, ctx)).toBe(true)
    expect(evaluateCondition({ stack: { minU: 13 } }, ctx)).toBe(false)
    expect(evaluateCondition({ stack: { maxU: 9 } }, ctx)).toBe(false)
    expect(evaluateCondition({ stack: { minSections: 3, maxSections: 3 } }, ctx)).toBe(true)
    expect(evaluateCondition({ stack: { maxSections: 2 } }, ctx)).toBe(false)
    expect(evaluateCondition({ stack: { topTypeId: 's3', bottomTypeId: 's3' } }, ctx)).toBe(true)
    expect(evaluateCondition({ stack: { topTypeId: 's6' } }, ctx)).toBe(false)
  })

  it('combines with all / any / not', () => {
    const magnets = { option: { magnets: true } }
    const flat = { option: { top: 'flat' } }
    expect(evaluateCondition({ all: [magnets, { stack: { minU: 9 } }] }, ctx)).toBe(true)
    expect(evaluateCondition({ all: [magnets, flat] }, ctx)).toBe(false)
    expect(evaluateCondition({ any: [flat, magnets] }, ctx)).toBe(true)
    expect(evaluateCondition({ any: [] }, ctx)).toBe(false)
    expect(evaluateCondition({ all: [] }, ctx)).toBe(true)
    expect(evaluateCondition({ not: { all: [magnets, flat] } }, ctx)).toBe(true)
  })

  it('sees an empty stack', () => {
    const empty: ConditionContext = { options: {}, stack: { u: 0, sectionTypes: [] } }
    expect(evaluateCondition({ stack: { topTypeId: 's3' } }, empty)).toBe(false)
    expect(evaluateCondition({ stack: { maxSections: 0 } }, empty)).toBe(true)
  })
})
