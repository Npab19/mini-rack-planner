import { describe, expect, it } from 'vitest'
import {
  BLANK_1U,
  BLANK_2U,
  CATALOG,
  FRAME,
  HALF_BAY_1U,
  makePlan,
  RANGE_FRAME,
  USER_SECTIONS,
} from '@/domain/__fixtures__/frameFixtures'
import { setHeight } from '@/domain/frame'
import {
  defaultTargetU,
  heightChangeText,
  mergeChoices,
  nearestFreeStart,
  placementStarts,
  placementWhere,
  plannedRunU,
  positionText,
  reachableHeights,
  splitChoice,
  stackRows,
  uRange,
} from './stackModel'

describe('positions', () => {
  it('names U ranges and starts inside a U', () => {
    expect(uRange(0, 18)).toBe('U1–U3')
    expect(uRange(18, 24)).toBe('U4')
    expect(positionText(0, 6)).toBe('U1')
    expect(positionText(18, 12)).toBe('U4–U5')
    expect(positionText(21, 3)).toBe('U4 + ½U')
    expect(placementWhere({ y: 18, face: 'rear', bay: 'left' }, 6)).toBe('U4 · rear · left half')
    expect(placementWhere({ y: 0, face: 'front', bay: 'full' }, 12)).toBe('U1–U2 · front')
  })
})

describe('stackRows', () => {
  it('lists sections bottom to top with U ranges, names and Have', () => {
    const plan = makePlan({ sections: [...USER_SECTIONS, { id: 'sec-c', typeId: 's3' }] })
    const rows = stackRows(plan, FRAME)
    expect(rows.map((row) => [row.name, row.have, row.sectionLabel])).toEqual([
      ['3U section, U1–U3', true, 'Section 1 (3U)'],
      ['6U section, U4–U9', true, 'Section 2 (6U)'],
      ['3U section, U10–U12', false, 'Section 3 (3U)'],
    ])
    expect(plannedRunU(rows, 'top')).toBe(3)
    expect(plannedRunU(rows, 'bottom')).toBe(0)
  })
})

describe('split and merge', () => {
  it('splits a planned 6U into 3U + 3U, never an owned or a 3U section', () => {
    const plan = makePlan({
      sections: [
        { id: 'a', typeId: 's6', have: true },
        { id: 'b', typeId: 's6' },
        { id: 'c', typeId: 's3' },
      ],
    })
    const [owned, planned, small] = stackRows(plan, FRAME)
    if (!owned || !planned || !small) throw new Error('rows')
    expect(splitChoice(FRAME, planned)).toMatchObject({ text: '3U + 3U' })
    expect(splitChoice(FRAME, planned)?.parts.map((part) => part.id)).toEqual(['s3', 's3'])
    expect(splitChoice(FRAME, owned)).toBeUndefined()
    expect(splitChoice(FRAME, small)).toBeUndefined()
  })

  it('merges planned neighbours into a section type the frame has', () => {
    const plan = makePlan({
      sections: [
        { id: 'a', typeId: 's3', have: true },
        { id: 'b', typeId: 's3' },
        { id: 'c', typeId: 's3' },
        { id: 'd', typeId: 's6' },
      ],
    })
    const rows = stackRows(plan, FRAME)
    const [, b, c] = rows
    if (!b || !c) throw new Error('rows')
    // b: the owned section below is left alone; 3U + 3U above makes a 6U.
    expect(mergeChoices(FRAME, rows, b)).toEqual([
      expect.objectContaining({ direction: 'above', into: 's6', intoLabel: '6U section' }),
    ])
    // c: 3U + 6U = 9U has no type; 3U + 3U below does.
    expect(mergeChoices(FRAME, rows, c).map((choice) => choice.direction)).toEqual(['below'])
  })

  it('merges into a range type with the summed height', () => {
    const plan = makePlan({
      frame: RANGE_FRAME,
      sections: [
        { id: 'r', typeId: 'rails', heightU: 4 },
        { id: 'k', typeId: 'block' },
      ],
    })
    const rows = stackRows(plan, RANGE_FRAME)
    const [rails] = rows
    if (!rails) throw new Error('rows')
    expect(mergeChoices(RANGE_FRAME, rows, rails)).toEqual([
      expect.objectContaining({ into: { typeId: 'rails', heightU: 5 }, intoLabel: 'Rails (5U)' }),
    ])
  })
})

describe('Set height', () => {
  it('reaches the kept height plus whole sections, the current height included', () => {
    const built = stackRows(makePlan({ sections: [...USER_SECTIONS] }), FRAME)
    expect(reachableHeights(built, FRAME, 'top')).toEqual([9, 12, 15, 18])
    expect(defaultTargetU(reachableHeights(built, FRAME, 'top'), 9)).toBe(12)

    // A planned 3U at the bottom can be rebuilt: from the 6U that stays upwards.
    const plannedBottom = stackRows(
      makePlan({
        sections: [
          { id: 'p', typeId: 's3' },
          { id: 'h', typeId: 's6', have: true },
        ],
      }),
      FRAME,
    )
    expect(reachableHeights(plannedBottom, FRAME, 'bottom')).toEqual([6, 9, 12, 15, 18])
    expect(reachableHeights(plannedBottom, FRAME, 'top')).toEqual([9, 12, 15, 18])
    expect(defaultTargetU([9], 9)).toBe(9)
    expect(defaultTargetU([], 9)).toBeUndefined()
  })

  it('says what a height change adds or removes', () => {
    const built = makePlan({ sections: [...USER_SECTIONS] })
    const grown = setHeight(built, FRAME, 12, 'top')
    expect(heightChangeText(stackRows(built, FRAME), stackRows(grown.plan, FRAME), 'top')).toBe(
      '9U → 12U: adds 1 section (3U) on top.',
    )
    const planned = makePlan({
      sections: [...USER_SECTIONS, { id: 'p3', typeId: 's3' }, { id: 'p6', typeId: 's6' }],
    })
    const shrunk = setHeight(planned, FRAME, 12, 'top')
    expect(heightChangeText(stackRows(planned, FRAME), stackRows(shrunk.plan, FRAME), 'top')).toBe(
      '18U → 12U: removes 1 planned section (6U) on top.',
    )
  })
})

describe('where a placement can go', () => {
  const plan = makePlan({
    sections: [...USER_SECTIONS],
    placements: [
      { id: 'one', itemId: BLANK_1U.id, y: 0 },
      { id: 'two', itemId: BLANK_2U.id, y: 12 },
    ],
  })

  it('lists free starts on the placement’s face, its own spot included', () => {
    const one = plan.placements[0]
    if (one === undefined) throw new Error('placement')
    expect(placementStarts(plan, CATALOG, FRAME, one)).toEqual([0, 6, 24, 30, 36, 42, 48])
  })

  it('finds the nearest free spot (the higher one on a tie)', () => {
    expect(
      nearestFreeStart(plan, CATALOG, FRAME, { itemId: BLANK_1U.id, face: 'front', near: 18 }),
    ).toEqual({ y: 24, face: 'front', bay: 'full' })
    expect(
      nearestFreeStart(plan, CATALOG, FRAME, { itemId: BLANK_1U.id, face: 'front', near: 30 }),
    ).toEqual({ y: 30, face: 'front', bay: 'full' })
  })

  it('tries both halves for half-width parts, and only faces the part mounts on', () => {
    const left = makePlan({
      sections: [...USER_SECTIONS],
      placements: [{ id: 'l', itemId: HALF_BAY_1U.id, y: 0, bay: 'left' }],
    })
    expect(
      nearestFreeStart(left, CATALOG, FRAME, { itemId: HALF_BAY_1U.id, face: 'front', near: 0 }),
    ).toEqual({ y: 0, face: 'front', bay: 'right' })
    expect(
      nearestFreeStart(left, CATALOG, FRAME, { itemId: HALF_BAY_1U.id, face: 'rear', near: 0 }),
    ).toBeUndefined()
  })
})
