import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import type { StackOpResult } from './api'
import {
  BLANK_1U,
  BLANK_2U,
  CATALOG,
  DEAD_ZONE_FRAME,
  FRAME,
  HALF_U_PANEL,
  makePlan,
  NOW,
  RANGE_FRAME,
  REAR_FAN_1U,
  SHELF_1U,
  USER_SECTIONS,
  type PlacementSpec,
} from './__fixtures__/frameFixtures'
import {
  composeHeight,
  insertSection,
  markSection,
  mergeSections,
  moveSection,
  placementAnchor,
  placementsInSection,
  remap,
  removeSection,
  retireSection,
  sectionSpans,
  setHeight,
  splitSection,
  stackJoints,
  totalHeightSixths,
  totalHeightU,
  validateStack,
} from './frame'
import { allowedPhases, boxesOverlap, occupiedBox } from './placement'
import type { Frame, SectionType } from './schema/catalog'
import type { Face } from './schema/common'
import type { Plan } from './schema/plan'

const LATER = '2026-10-12T08:00:00.000Z'

/** In the user's [3U, 6U] rack: one item in the 3U, two in the 6U. */
const SCENARIO: readonly PlacementSpec[] = [
  { id: 'pl-low', itemId: 'blank-1u', y: 6 },
  { id: 'pl-pc', itemId: 'mini-pc-mount-2u', y: 24 },
  { id: 'pl-top', itemId: 'blank-1u', y: 48 },
]

/** 2U across the 3U/6U joint at sixth 18. */
const STRADDLER: PlacementSpec = { id: 'pl-span', itemId: 'blank-2u', y: 12 }

function userPlan(extra: readonly PlacementSpec[] = []): Plan {
  return makePlan({ sections: USER_SECTIONS, placements: [...SCENARIO, ...extra] })
}

function ys(plan: Plan): Record<string, number> {
  return Object.fromEntries(plan.placements.map((placement) => [placement.id, placement.y]))
}

function sectionIds(plan: Plan): string[] {
  return plan.frame.sections.map((section) => section.id)
}

function typeIds(plan: Plan): string[] {
  return plan.frame.sections.map((section) => section.typeId)
}

function kinds(result: StackOpResult): string[] {
  return result.conflicts.map((conflict) => conflict.kind)
}

describe('sectionSpans', () => {
  it('lays sections out bottom -> top in sixths', () => {
    const plan = userPlan()
    expect(sectionSpans(plan, FRAME)).toEqual([
      {
        sectionId: 'sec-a',
        typeId: 's3',
        index: 0,
        startSixths: 0,
        endSixths: 18,
        heightU: 3,
        have: true,
      },
      {
        sectionId: 'sec-b',
        typeId: 's6',
        index: 1,
        startSixths: 18,
        endSixths: 54,
        heightU: 6,
        have: true,
      },
    ])
    expect(totalHeightU(plan, FRAME)).toBe(9)
    expect(totalHeightSixths(plan, FRAME)).toBe(54)
    expect(totalHeightSixths(makePlan(), FRAME)).toBe(0)
  })

  it('uses the stored height for range types and the minimum when none is stored', () => {
    const plan = makePlan({
      frame: RANGE_FRAME,
      sections: [
        { id: 'sec-r', typeId: 'rails', heightU: 4 },
        { id: 'sec-s', typeId: 'rails' },
        { id: 'sec-k', typeId: 'block' },
      ],
    })
    const spans = sectionSpans(plan, RANGE_FRAME)
    expect(spans.map((span) => [span.startSixths, span.endSixths])).toEqual([
      [0, 24],
      [24, 36],
      [36, 42],
    ])
  })

  it('lists joints with their dead zones', () => {
    const plan = userPlan()
    expect(stackJoints(plan, FRAME)).toEqual([
      { ySixths: 18, lowerId: 'sec-a', upperId: 'sec-b', deadY0: 18, deadY1: 18 },
    ])
    expect(stackJoints(plan, DEAD_ZONE_FRAME)[0]).toMatchObject({ deadY0: 17, deadY1: 19 })
  })
})

describe('placementAnchor', () => {
  it('anchors to the section holding the bottom edge', () => {
    const plan = userPlan()
    expect(placementAnchor(plan, FRAME, { y: 0 })).toEqual({ sectionId: 'sec-a', offsetSixths: 0 })
    expect(placementAnchor(plan, FRAME, { y: 18 })).toEqual({ sectionId: 'sec-b', offsetSixths: 0 })
    expect(placementAnchor(plan, FRAME, { y: 24 })).toEqual({ sectionId: 'sec-b', offsetSixths: 6 })
  })

  it('anchors out-of-rack positions to the nearest end', () => {
    const plan = userPlan()
    expect(placementAnchor(plan, FRAME, { y: -6 })).toEqual({
      sectionId: 'sec-a',
      offsetSixths: -6,
    })
    expect(placementAnchor(plan, FRAME, { y: 60 })).toEqual({
      sectionId: 'sec-b',
      offsetSixths: 42,
    })
    expect(placementAnchor(makePlan(), FRAME, { y: 0 })).toBeUndefined()
  })
})

describe('placementsInSection', () => {
  it('lists what is mounted on a section, including items across its joints', () => {
    const plan = userPlan([STRADDLER])
    const ids = (sectionId: string) =>
      placementsInSection(plan, FRAME, sectionId).map((placement) => placement.id)
    expect(ids('sec-a')).toEqual(['pl-low', 'pl-span'])
    expect(ids('sec-b')).toEqual(['pl-pc', 'pl-top', 'pl-span'])
    expect(ids('sec-x')).toEqual([])
  })
})

describe('insertSection', () => {
  describe('the user scenario: [3U have, 6U have] plus one 3U', () => {
    it('on top: nothing moves', () => {
      const plan = userPlan()
      const result = insertSection(plan, FRAME, 2, 's3', { id: 'sec-new' })
      expect(result.error).toBeUndefined()
      expect(result.conflicts).toEqual([])
      expect(sectionIds(result.plan)).toEqual(['sec-a', 'sec-b', 'sec-new'])
      expect(result.plan.frame.sections[2]).toEqual({ id: 'sec-new', typeId: 's3' })
      expect(ys(result.plan)).toEqual(ys(plan))
      expect(totalHeightU(result.plan, FRAME)).toBe(12)
    })

    it('at the bottom: everything moves up 18 sixths', () => {
      const result = insertSection(userPlan(), FRAME, 0, 's3')
      expect(ys(result.plan)).toEqual({ 'pl-low': 24, 'pl-pc': 42, 'pl-top': 66 })
    })

    it('between: only what is in the 6U moves up', () => {
      const result = insertSection(userPlan(), FRAME, 1, 's3')
      expect(ys(result.plan)).toEqual({ 'pl-low': 6, 'pl-pc': 42, 'pl-top': 66 })
    })

    it('leaves the sections you have as they are', () => {
      const plan = userPlan()
      for (const index of [0, 1, 2]) {
        const { plan: next } = insertSection(plan, FRAME, index, 's3')
        const owned = next.frame.sections.filter((section) => section.have !== undefined)
        expect(owned).toHaveLength(2)
        expect(owned[0]).toBe(plan.frame.sections[0])
        expect(owned[1]).toBe(plan.frame.sections[1])
      }
    })

    it('does not touch the input plan', () => {
      const plan = userPlan()
      const before = structuredClone(plan)
      insertSection(plan, FRAME, 0, 's3')
      expect(plan).toEqual(before)
    })
  })

  describe('an item across the 3U/6U joint', () => {
    it('blocks an insert at that joint', () => {
      const plan = userPlan([STRADDLER])
      const result = insertSection(plan, FRAME, 1, 's3')
      expect(result.plan).toBe(plan)
      expect(result.conflicts).toEqual([
        {
          kind: 'straddle',
          message:
            'Blank 2U spans Section 1 (3U) and Section 2 (6U), which this change moves apart.',
          placementIds: ['pl-span'],
          sectionIds: ['sec-a', 'sec-b'],
        },
      ])
      expect(result.error).toBe(result.conflicts[0]?.message)
    })

    it('moves it with the lower or the upper section on request', () => {
      const plan = userPlan([STRADDLER])
      const lower = insertSection(plan, FRAME, 1, 's3', { straddle: 'lower' })
      const upper = insertSection(plan, FRAME, 1, 's3', { straddle: 'upper' })
      expect(lower.error).toBeUndefined()
      expect(ys(lower.plan)['pl-span']).toBe(12)
      expect(ys(upper.plan)['pl-span']).toBe(30)
      expect(ys(upper.plan)['pl-pc']).toBe(42)
    })

    it('carries it along when its joint stays intact', () => {
      const plan = userPlan([STRADDLER])
      expect(ys(insertSection(plan, FRAME, 0, 's3').plan)['pl-span']).toBe(30)
      expect(ys(insertSection(plan, FRAME, 2, 's3').plan)['pl-span']).toBe(12)
    })

    it('finds the item height in the catalog when the plan has none', () => {
      const plan = userPlan([STRADDLER])
      const bare: Plan = {
        ...plan,
        placements: plan.placements.map((placement) => {
          const copy = { ...placement }
          delete copy.heightSixths
          return copy
        }),
      }
      // Without a height the item is only known at its y, inside the 3U.
      expect(insertSection(bare, FRAME, 1, 's3').conflicts).toEqual([])
      expect(kinds(insertSection(bare, FRAME, 1, 's3', { catalog: CATALOG }))).toEqual(['straddle'])
    })
  })

  it('records a Have snapshot in recording mode', () => {
    const result = insertSection(userPlan(), FRAME, 2, 's6', {
      have: true,
      at: NOW,
      id: 'sec-c',
      options: { magnets: false },
    })
    expect(result.plan.frame.sections[2]).toEqual({
      id: 'sec-c',
      typeId: 's6',
      options: { magnets: false },
      have: { at: NOW, typeId: 's6', heightU: 6, options: { magnets: false, deep: false } },
    })
  })

  it('refuses unknown types, bad positions and ids in use', () => {
    const plan = userPlan()
    expect(insertSection(plan, FRAME, 0, 's9')).toEqual({
      plan,
      conflicts: [],
      error: 'Test frame has no section type "s9" (it has "s3" and "s6").',
    })
    expect(insertSection(plan, FRAME, 3, 's3').error).toBe(
      'Position 3 is outside a stack of 2 sections.',
    )
    expect(insertSection(plan, FRAME, -1, 's3').error).toMatch(/outside/)
    expect(insertSection(plan, FRAME, 0, 's3', { id: 'sec-a' }).error).toBe(
      'Section id "sec-a" is already used.',
    )
  })

  it('stops at the tallest stack the frame allows', () => {
    const plan = makePlan({
      sections: [
        { id: 'sec-1', typeId: 's6' },
        { id: 'sec-2', typeId: 's6' },
        { id: 'sec-3', typeId: 's6' },
      ],
    })
    const result = insertSection(plan, FRAME, 3, 's3')
    expect(result.plan).toBe(plan)
    expect(result.conflicts).toEqual([
      { kind: 'out-of-bounds', message: 'Test frame stacks go up to 18U; this would make 21U.' },
    ])
  })

  it('stores the height of range sections', () => {
    const plan = makePlan({ frame: RANGE_FRAME })
    const result = insertSection(plan, RANGE_FRAME, 0, 'rails', { heightU: 8, id: 'sec-r' })
    expect(result.plan.frame.sections).toEqual([{ id: 'sec-r', typeId: 'rails', heightU: 8 }])
    expect(insertSection(plan, RANGE_FRAME, 0, 'rails', { heightU: 40 }).error).toBe(
      'Rails can be 2U to 20U, not 40U.',
    )
    expect(insertSection(plan, RANGE_FRAME, 0, 'block', { heightU: 2 }).error).toBe(
      '1U block is always 1U.',
    )
  })
})

describe('removeSection', () => {
  // sec-a [0, 18) have, sec-m [18, 36) planned, sec-b [36, 72) have.
  function middlePlan(placements: readonly PlacementSpec[] = []): Plan {
    return makePlan({
      sections: [
        { id: 'sec-a', typeId: 's3', have: true },
        { id: 'sec-m', typeId: 's3' },
        { id: 'sec-b', typeId: 's6', have: true },
      ],
      placements,
    })
  }

  it('removes an empty planned section and moves the ones above down', () => {
    const plan = middlePlan([
      { id: 'pl-b', itemId: 'blank-1u', y: 42 },
      { id: 'pl-a', itemId: 'blank-1u', y: 0 },
    ])
    const result = removeSection(plan, FRAME, 'sec-m')
    expect(result.error).toBeUndefined()
    expect(sectionIds(result.plan)).toEqual(['sec-a', 'sec-b'])
    expect(ys(result.plan)).toEqual({ 'pl-b': 24, 'pl-a': 0 })
    expect(result.plan.placements[1]).toBe(plan.placements[1])
  })

  it('never removes a section you have', () => {
    const plan = middlePlan()
    const result = removeSection(plan, FRAME, 'sec-a')
    expect(result.plan).toBe(plan)
    expect(result.conflicts).toEqual([
      {
        kind: 'have-locked',
        message: 'Section 1 (3U) is in your rack, so retire it instead of removing it.',
        sectionIds: ['sec-a'],
      },
    ])
  })

  it('asks before removing what is mounted on it', () => {
    const plan = middlePlan([
      { id: 'pl-m', itemId: 'blank-1u', y: 24 },
      { id: 'pl-cross', itemId: 'blank-2u', y: 12 },
    ])
    const result = removeSection(plan, FRAME, 'sec-m')
    expect(result.plan).toBe(plan)
    expect(result.conflicts).toEqual([
      {
        kind: 'section-not-empty',
        message: 'Section 2 (3U) still holds Blank 1U and Blank 2U.',
        placementIds: ['pl-m', 'pl-cross'],
        sectionIds: ['sec-m'],
      },
    ])
  })

  it('names placements by their catalog name; the stored copy is for unknown ids', () => {
    const base = middlePlan([
      { id: 'pl-m', itemId: 'blank-1u', y: 24 },
      { id: 'pl-gone', itemId: 'gone-panel', y: 27 },
    ])
    const plan: Plan = {
      ...base,
      placements: base.placements.map((placement) => ({ ...placement, name: 'Old name' })),
    }
    const result = removeSection(plan, FRAME, 'sec-m', { catalog: CATALOG })
    expect(result.conflicts[0]?.message).toBe('Section 2 (3U) still holds Blank 1U and Old name.')
  })

  describe('with its placements', () => {
    const plan = middlePlan([
      {
        id: 'pl-owned',
        itemId: 'shelf-1u',
        y: 18,
        have: true,
        devices: [
          { id: 'dv-1', deviceId: 'test-sbc', slotId: 'deck', have: true },
          { id: 'dv-2', deviceId: 'test-sbc', slotId: 'deck' },
        ],
      },
      {
        id: 'pl-new',
        itemId: 'shelf-1u',
        y: 30,
        devices: [{ id: 'dv-3', deviceId: 'test-mini-pc', slotId: 'deck', have: true }],
      },
      { id: 'pl-b', itemId: 'blank-1u', y: 42 },
    ])

    it('retires owned ones and sends their other devices back to the tray', () => {
      const result = removeSection(plan, FRAME, 'sec-m', { removePlacements: true })
      expect(result.error).toBeUndefined()
      expect(ys(result.plan)).toEqual({ 'pl-b': 24 })
      expect(result.plan.retired).toEqual([
        {
          id: expect.stringMatching(/^rt-/),
          kind: 'placement',
          snapshot: { at: NOW, itemId: 'shelf-1u', options: {} },
          sourceId: 'pl-owned',
          devices: ['test-sbc'],
        },
      ])
      expect(result.plan.equipment).toEqual([
        { id: expect.stringMatching(/^eq-/), deviceId: 'test-sbc', have: false },
        { id: expect.stringMatching(/^eq-/), deviceId: 'test-mini-pc', have: true },
      ])
    })

    it('drops planned devices on request but never owned ones', () => {
      const result = removeSection(plan, FRAME, 'sec-m', {
        removePlacements: true,
        needDevices: 'drop',
      })
      expect(result.plan.equipment.map(({ deviceId, have }) => ({ deviceId, have }))).toEqual([
        { deviceId: 'test-mini-pc', have: true },
      ])
    })
  })

  it('reports an unknown section', () => {
    expect(removeSection(middlePlan(), FRAME, 'sec-x').error).toBe(
      'There is no section "sec-x" in this rack.',
    )
  })
})

describe('moveSection', () => {
  it('carries what is mounted on a section and shifts the rest', () => {
    const result = moveSection(userPlan(), FRAME, 'sec-a', 1)
    expect(result.error).toBeUndefined()
    expect(sectionIds(result.plan)).toEqual(['sec-b', 'sec-a'])
    expect(ys(result.plan)).toEqual({ 'pl-low': 42, 'pl-pc': 6, 'pl-top': 30 })
  })

  it('blocks when an item spans a joint that changes', () => {
    const plan = userPlan([STRADDLER])
    const result = moveSection(plan, FRAME, 'sec-a', 1)
    expect(result.plan).toBe(plan)
    expect(result.conflicts.map(({ kind, placementIds }) => ({ kind, placementIds }))).toEqual([
      { kind: 'straddle', placementIds: ['pl-span'] },
    ])
  })

  it('carries an item across a joint that stays intact', () => {
    const plan = makePlan({
      sections: [
        { id: 'sec-a', typeId: 's3' },
        { id: 'sec-b', typeId: 's3' },
        { id: 'sec-c', typeId: 's6' },
      ],
      placements: [{ id: 'pl-bc', itemId: 'blank-2u', y: 30 }],
    })
    const result = moveSection(plan, FRAME, 'sec-a', 2)
    expect(sectionIds(result.plan)).toEqual(['sec-b', 'sec-c', 'sec-a'])
    expect(ys(result.plan)).toEqual({ 'pl-bc': 12 })
  })

  it('leaves the plan alone for the same position and refuses bad ones', () => {
    const plan = userPlan()
    const same = moveSection(plan, FRAME, 'sec-a', 0)
    expect(same).toEqual({ plan, conflicts: [] })
    expect(same.plan).toBe(plan)
    expect(moveSection(plan, FRAME, 'sec-a', 2).error).toBe(
      'Position 2 is outside a stack of 2 sections.',
    )
    expect(moveSection(plan, FRAME, 'sec-x', 0).error).toMatch(/no section "sec-x"/)
  })
})

describe('splitSection', () => {
  // sec-p [18, 54) planned; pl-mid [30, 42) ends up across the new joint at 36.
  function planned6(): Plan {
    return makePlan({
      sections: [
        { id: 'sec-a', typeId: 's3', have: true },
        { id: 'sec-p', typeId: 's6', options: { magnets: false } },
      ],
      placements: [
        { id: 'pl-mid', itemId: 'blank-2u', y: 30 },
        { id: 'pl-low', itemId: 'blank-1u', y: 0 },
      ],
    })
  }

  it('splits a planned 6U into two 3U sections and keeps every position', () => {
    const plan = planned6()
    const result = splitSection(plan, FRAME, 'sec-p', ['s3', 's3'], { ids: ['sec-p1', 'sec-p2'] })
    expect(result.error).toBeUndefined()
    expect(result.plan.frame.sections.slice(1)).toEqual([
      { id: 'sec-p1', typeId: 's3', options: { magnets: false } },
      { id: 'sec-p2', typeId: 's3', options: { magnets: false } },
    ])
    expect(ys(result.plan)).toEqual(ys(plan))
  })

  it('needs the heights to add up', () => {
    expect(splitSection(planned6(), FRAME, 'sec-p', ['s3']).error).toBe(
      '3U = 3U, but Section 2 (6U) is 6U.',
    )
    expect(splitSection(planned6(), FRAME, 'sec-p', ['s6', 's3']).error).toBe(
      '6U + 3U = 9U, but Section 2 (6U) is 6U.',
    )
    expect(splitSection(planned6(), FRAME, 'sec-p', []).error).toBe(
      'Pick the sections to split it into.',
    )
    expect(splitSection(planned6(), FRAME, 'sec-p', ['s3', 's4']).error).toMatch(/"s4"/)
  })

  it('only splits planned sections', () => {
    const plan = planned6()
    const result = splitSection(plan, FRAME, 'sec-a', ['s3'])
    expect(result.plan).toBe(plan)
    expect(result.conflicts).toEqual([
      {
        kind: 'have-locked',
        message: 'Section 1 (3U) is in your rack, so only planned sections can be split.',
        sectionIds: ['sec-a'],
      },
    ])
  })
})

describe('mergeSections', () => {
  // sec-p1 [18, 36), sec-p2 [36, 54); pl-cross [30, 42) spans their joint.
  function planned33(): Plan {
    return makePlan({
      sections: [
        { id: 'sec-a', typeId: 's3', have: true },
        { id: 'sec-p1', typeId: 's3', options: { magnets: false } },
        { id: 'sec-p2', typeId: 's3' },
      ],
      placements: [
        { id: 'pl-p2', itemId: 'blank-1u', y: 42 },
        { id: 'pl-cross', itemId: 'blank-2u', y: 30 },
      ],
    })
  }

  it('merges two planned neighbours, given in either order, and keeps positions', () => {
    const plan = planned33()
    for (const [a, b] of [
      ['sec-p1', 'sec-p2'],
      ['sec-p2', 'sec-p1'],
    ] as const) {
      const result = mergeSections(plan, FRAME, a, b, 's6', { id: 'sec-m' })
      expect(result.error).toBeUndefined()
      expect(result.plan.frame.sections.slice(1)).toEqual([
        { id: 'sec-m', typeId: 's6', options: { magnets: false } },
      ])
      expect(ys(result.plan)).toEqual(ys(plan))
    }
  })

  it('refuses non-neighbours, owned sections and a type of the wrong height', () => {
    const plan = makePlan({
      sections: [
        { id: 'sec-1', typeId: 's3' },
        { id: 'sec-2', typeId: 's3', have: true },
        { id: 'sec-3', typeId: 's3' },
      ],
    })
    expect(mergeSections(plan, FRAME, 'sec-1', 'sec-3', 's6').error).toBe(
      'Section 1 (3U) and Section 3 (3U) are not neighbours.',
    )
    expect(kinds(mergeSections(plan, FRAME, 'sec-1', 'sec-2', 's6'))).toEqual(['have-locked'])
    expect(mergeSections(planned33(), FRAME, 'sec-p1', 'sec-p2', 's3').error).toBe(
      '3U section is 3U; the two sections add up to 6U.',
    )
    expect(mergeSections(planned33(), FRAME, 'sec-p1', 'sec-p1', 's6').error).toBe(
      'Pick two different sections to merge.',
    )
  })

  it('merges range sections into their combined height', () => {
    const plan = makePlan({
      frame: RANGE_FRAME,
      sections: [
        { id: 'sec-1', typeId: 'rails', heightU: 4 },
        { id: 'sec-2', typeId: 'block' },
      ],
    })
    const result = mergeSections(plan, RANGE_FRAME, 'sec-1', 'sec-2', 'rails', { id: 'sec-m' })
    expect(result.plan.frame.sections).toEqual([{ id: 'sec-m', typeId: 'rails', heightU: 5 }])
  })
})

describe('setHeight', () => {
  it('9U -> 12U at the top adds one planned 3U', () => {
    const plan = userPlan()
    const result = setHeight(plan, FRAME, 12, 'top')
    expect(result.error).toBeUndefined()
    expect(result.plan.frame.sections.slice(0, 2)).toEqual(plan.frame.sections)
    expect(result.plan.frame.sections[2]).toEqual({
      id: expect.stringMatching(/^sec-/),
      typeId: 's3',
    })
    expect(ys(result.plan)).toEqual(ys(plan))
  })

  it('9U -> 12U at the bottom adds a planned 3U below and moves everything up', () => {
    const result = setHeight(userPlan(), FRAME, 12, 'bottom')
    expect(typeIds(result.plan)).toEqual(['s3', 's3', 's6'])
    expect(result.plan.frame.sections[0]?.have).toBeUndefined()
    expect(ys(result.plan)).toEqual({ 'pl-low': 24, 'pl-pc': 42, 'pl-top': 66 })
  })

  it('reports a height that cannot be built, with the nearest ones that can', () => {
    const plan = userPlan()
    const result = setHeight(plan, FRAME, 10, 'top')
    expect(result.plan).toBe(plan)
    expect(result.conflicts).toEqual([
      {
        kind: 'unreachable-height',
        message:
          '10U is not possible: 9U stays and the rest has to be made of 3U and 6U sections. Try 9U or 12U.',
      },
    ])
    expect(result.error).toBe(result.conflicts[0]?.message)
  })

  it('never removes what you have', () => {
    const result = setHeight(userPlan(), FRAME, 6, 'top')
    expect(result.conflicts).toEqual([
      {
        kind: 'unreachable-height',
        message:
          '6U is not possible: the sections that stay add up to 9U (sections you have are never removed). Try 9U.',
      },
    ])
  })

  it('stays within the frame limits and whole U', () => {
    expect(setHeight(userPlan(), FRAME, 21, 'top').conflicts).toEqual([
      {
        kind: 'out-of-bounds',
        message: 'Test frame stacks are 3U to 18U, so 21U is not possible.',
      },
    ])
    expect(setHeight(userPlan(), FRAME, 12.5, 'top').error).toBe('Rack heights are whole U.')
  })

  it('uses the fewest sections, larger ones lower', () => {
    expect(typeIds(setHeight(userPlan(), FRAME, 15, 'top').plan)).toEqual(['s3', 's6', 's6'])
    expect(typeIds(setHeight(userPlan(), FRAME, 18, 'top').plan)).toEqual(['s3', 's6', 's6', 's3'])
    expect(typeIds(setHeight(userPlan(), FRAME, 18, 'bottom').plan)).toEqual([
      's6',
      's3',
      's3',
      's6',
    ])
    expect(typeIds(setHeight(makePlan(), FRAME, 12, 'top').plan)).toEqual(['s6', 's6'])
  })

  describe('with a planned 3U on top that holds something', () => {
    // sec-p [54, 72); pl-p [60, 66).
    const plan = makePlan({
      sections: [...USER_SECTIONS, { id: 'sec-p', typeId: 's3' }],
      placements: [{ id: 'pl-p', itemId: 'blank-1u', y: 60 }],
    })

    it('rebuilds the planned run and keeps what still fits', () => {
      const taller = setHeight(plan, FRAME, 15, 'top')
      expect(taller.error).toBeUndefined()
      expect(typeIds(taller.plan)).toEqual(['s3', 's6', 's6'])
      expect(ys(taller.plan)).toEqual({ 'pl-p': 60 })
      expect(setHeight(plan, FRAME, 12, 'top').plan).toBe(plan)
    })

    it('asks before dropping a planned section that is not empty', () => {
      const result = setHeight(plan, FRAME, 9, 'top')
      expect(result.plan).toBe(plan)
      expect(result.conflicts).toEqual([
        {
          kind: 'section-not-empty',
          message: 'Section 3 (3U) still holds Blank 1U.',
          placementIds: ['pl-p'],
          sectionIds: ['sec-p'],
        },
      ])
      const deleted = setHeight(plan, FRAME, 9, 'top', { orphans: 'delete' })
      expect(sectionIds(deleted.plan)).toEqual(['sec-a', 'sec-b'])
      expect(deleted.plan.placements).toEqual([])
      const kept = setHeight(plan, FRAME, 9, 'top', { orphans: 'keep' })
      expect(ys(kept.plan)).toEqual({ 'pl-p': 60 })
    })
  })

  it('removes an empty planned run', () => {
    const plan = makePlan({ sections: [...USER_SECTIONS, { id: 'sec-p', typeId: 's3' }] })
    expect(sectionIds(setHeight(plan, FRAME, 9, 'top').plan)).toEqual(['sec-a', 'sec-b'])
  })

  it('reuses planned sections that stay the same', () => {
    const plan = makePlan({
      sections: [...USER_SECTIONS, { id: 'sec-p6', typeId: 's6', options: { magnets: false } }],
    })
    const result = setHeight(plan, FRAME, 18, 'top')
    expect(result.plan.frame.sections.slice(0, 3)).toEqual(plan.frame.sections)
    expect(typeIds(result.plan)).toEqual(['s3', 's6', 's6', 's3'])
  })

  it('keeps content of a bottom run next to the sections above it', () => {
    // sec-p [0, 18) planned under the user's rack; pl-p [12, 18) sits at its top.
    const plan = makePlan({
      sections: [{ id: 'sec-p', typeId: 's3' }, ...USER_SECTIONS],
      placements: [
        { id: 'pl-p', itemId: 'blank-1u', y: 12 },
        { id: 'pl-b', itemId: 'blank-1u', y: 42 },
      ],
    })
    const result = setHeight(plan, FRAME, 15, 'bottom')
    expect(typeIds(result.plan)).toEqual(['s6', 's3', 's6'])
    expect(ys(result.plan)).toEqual({ 'pl-p': 30, 'pl-b': 60 })
  })

  it('loses what sits at the far end of a bottom run that shrinks', () => {
    // sec-p6 [0, 36): pl-outer [0, 6) at the rack bottom, pl-inner [30, 36) next to the 3U above.
    const plan = makePlan({
      sections: [{ id: 'sec-p6', typeId: 's6' }, ...USER_SECTIONS],
      placements: [
        { id: 'pl-outer', itemId: 'blank-1u', y: 0 },
        { id: 'pl-inner', itemId: 'blank-1u', y: 30 },
      ],
    })
    expect(setHeight(plan, FRAME, 12, 'bottom').conflicts).toEqual([
      {
        kind: 'section-not-empty',
        message: 'Section 1 (6U) still holds Blank 1U.',
        placementIds: ['pl-outer'],
        sectionIds: ['sec-p6'],
      },
    ])
    const result = setHeight(plan, FRAME, 12, 'bottom', { orphans: 'delete' })
    expect(typeIds(result.plan)).toEqual(['s3', 's3', 's6'])
    expect(ys(result.plan)).toEqual({ 'pl-inner': 12 })
  })
})

describe('composeHeight', () => {
  const heights = (heightU: number) =>
    composeHeight(heightU, FRAME.sectionTypes)?.map((type) => type.heightU)

  it('uses the fewest sections, larger ones first', () => {
    expect(heights(0)).toEqual([])
    expect(heights(3)).toEqual([3])
    expect(heights(9)).toEqual([6, 3])
    expect(heights(12)).toEqual([6, 6])
    expect(heights(15)).toEqual([6, 6, 3])
    expect(heights(1)).toBeUndefined()
    expect(heights(-3)).toBeUndefined()
    expect(heights(4.5)).toBeUndefined()
  })

  it('breaks ties toward larger sections and never uses range types', () => {
    const types: SectionType[] = [
      { id: 's3', label: '3U', heightU: 3 },
      { id: 's6', label: '6U', heightU: 6 },
      { id: 's9', label: '9U', heightU: 9 },
      { id: 'any', label: 'Any', heightU: { min: 1, max: 30 } },
    ]
    expect(composeHeight(12, types)?.map((type) => type.id)).toEqual(['s9', 's3'])
    expect(composeHeight(1, types)).toBeUndefined()
  })

  it('takes the first declared type of a height', () => {
    const types: SectionType[] = [
      { id: 'grill-3', label: 'Grill 3U', heightU: 3 },
      { id: 'plain-3', label: 'Plain 3U', heightU: 3 },
    ]
    expect(composeHeight(6, types)?.map((type) => type.id)).toEqual(['grill-3', 'grill-3'])
  })
})

describe('retireSection', () => {
  it('turns an owned section into a retired entry and moves the rest down', () => {
    const plan = makePlan({
      sections: USER_SECTIONS,
      placements: [{ id: 'pl-b', itemId: 'blank-1u', y: 24 }],
    })
    const result = retireSection(plan, FRAME, 'sec-a', LATER)
    expect(result.error).toBeUndefined()
    expect(sectionIds(result.plan)).toEqual(['sec-b'])
    expect(ys(result.plan)).toEqual({ 'pl-b': 6 })
    expect(result.plan.retired).toEqual([
      {
        id: expect.stringMatching(/^rt-/),
        kind: 'section',
        snapshot: { at: LATER, typeId: 's3', heightU: 3, options: {} },
        sourceId: 'sec-a',
      },
    ])
  })

  it('takes what is mounted on it along on request', () => {
    const plan = makePlan({
      sections: USER_SECTIONS,
      placements: [
        {
          id: 'pl-a',
          itemId: 'shelf-1u',
          y: 0,
          have: true,
          devices: [{ id: 'dv-1', deviceId: 'test-sbc', slotId: 'deck', have: true }],
        },
      ],
    })
    expect(kinds(retireSection(plan, FRAME, 'sec-a', LATER))).toEqual(['section-not-empty'])
    const result = retireSection(plan, FRAME, 'sec-a', LATER, { removePlacements: true })
    expect(result.plan.placements).toEqual([])
    expect(
      result.plan.retired.map((entry) => [
        entry.kind,
        entry.sourceId,
        entry.snapshot.at,
        entry.devices,
      ]),
    ).toEqual([
      ['placement', 'pl-a', LATER, ['test-sbc']],
      ['section', 'sec-a', LATER, undefined],
    ])
  })

  it('only retires sections you have', () => {
    const plan = makePlan({ sections: [{ id: 'sec-p', typeId: 's3' }] })
    expect(retireSection(plan, FRAME, 'sec-p', LATER).error).toBe(
      'Section 1 (3U) is not in your rack yet; remove it instead.',
    )
  })
})

describe('markSection', () => {
  it('captures what is built: type, height and the options its parts use', () => {
    const plan = makePlan({
      sections: [{ id: 'sec-p', typeId: 's6', options: { magnets: false } }],
    })
    const withDeep: Plan = { ...plan, frame: { ...plan.frame, options: { deep: true } } }
    const result = markSection(withDeep, 'sec-p', true, LATER, FRAME)
    expect(result.error).toBeUndefined()
    expect(result.plan.frame.sections[0]).toEqual({
      id: 'sec-p',
      typeId: 's6',
      options: { magnets: false },
      have: { at: LATER, typeId: 's6', heightU: 6, options: { magnets: false, deep: true } },
    })
  })

  it('unmarks, and leaves an unchanged section alone', () => {
    const plan = makePlan({ sections: USER_SECTIONS })
    const unmarked = markSection(plan, 'sec-a', false, LATER, FRAME).plan
    expect(unmarked.frame.sections[0]).toEqual({ id: 'sec-a', typeId: 's3' })
    expect(markSection(unmarked, 'sec-a', false, LATER, FRAME).plan).toBe(unmarked)
    const marked = markSection(unmarked, 'sec-a', true, NOW, FRAME).plan
    expect(markSection(marked, 'sec-a', true, LATER, FRAME).plan).toBe(marked)
    expect(markSection(plan, 'sec-x', true, LATER, FRAME).error).toMatch(/no section "sec-x"/)
  })
})

describe('validateStack', () => {
  it('accepts the user rack', () => {
    expect(validateStack(userPlan(), FRAME)).toEqual([])
  })

  it('flags an empty stack and a plan for another frame', () => {
    expect(validateStack(makePlan(), FRAME)).toEqual([
      { severity: 'warning', code: 'empty-stack', message: 'The rack has no sections yet.' },
    ])
    const other = makePlan({ frame: RANGE_FRAME, sections: [{ id: 'sec-1', typeId: 's3' }] })
    expect(validateStack(other, FRAME).map((issue) => issue.code)).toEqual(['frame-mismatch'])
  })

  it('flags unknown types, bad heights, reused ids and a stack out of bounds', () => {
    const plan = makePlan({
      sections: [
        { id: 'sec-1', typeId: 's9' },
        { id: 'sec-2', typeId: 's6', heightU: 5 },
        { id: 'sec-2', typeId: 's6' },
        { id: 'sec-4', typeId: 's6' },
        { id: 'sec-5', typeId: 's6' },
      ],
    })
    const issues = validateStack(plan, FRAME)
    expect(issues.map((issue) => [issue.severity, issue.code, issue.targetId])).toEqual([
      ['error', 'unknown-section-type', 'sec-1'],
      ['error', 'section-height', 'sec-2'],
      ['error', 'duplicate-section-id', 'sec-2'],
      ['error', 'out-of-bounds', undefined],
    ])
    expect(issues[3]?.message).toBe('Test frame stacks are 3U to 18U; this one is 23U.')
  })

  it('notes owned sections the plan rebuilds as something else', () => {
    const plan = makePlan({ sections: USER_SECTIONS })
    const rebuilt: Plan = {
      ...plan,
      frame: {
        ...plan.frame,
        sections: plan.frame.sections.map((section) =>
          section.id === 'sec-a' ? { ...section, typeId: 's6' } : section,
        ),
      },
    }
    expect(validateStack(rebuilt, FRAME)).toEqual([
      {
        severity: 'info',
        code: 'have-changed',
        message: 'Section 1 (6U) is built as 3U section (3U); the plan rebuilds it as 6U section.',
        targetId: 'sec-a',
      },
    ])
  })
})

describe('remap', () => {
  it('keeps placements where they are when the old stack was empty', () => {
    const plan = makePlan({ placements: [{ id: 'pl-1', itemId: 'blank-1u', y: 6 }] })
    const result = remap(plan, [{ id: 'sec-new', typeId: 's3' }], FRAME)
    expect(ys(result.plan)).toEqual({ 'pl-1': 6 })
    expect(sectionIds(result.plan)).toEqual(['sec-new'])
  })

  it('keeps placements above the stack at their distance to the top', () => {
    const plan = makePlan({
      sections: USER_SECTIONS,
      placements: [{ id: 'pl-out', itemId: 'blank-1u', y: 60 }],
    })
    expect(ys(insertSection(plan, FRAME, 1, 's3').plan)).toEqual({ 'pl-out': 78 })
  })

  it('moves an item sticking out of the stack with the section it sits on', () => {
    const plan = makePlan({
      sections: USER_SECTIONS,
      placements: [{ id: 'pl-stick', itemId: 'blank-2u', y: 48 }],
    })
    expect(ys(insertSection(plan, FRAME, 2, 's3').plan)).toEqual({ 'pl-stick': 48 })
    expect(ys(insertSection(plan, FRAME, 0, 's3').plan)).toEqual({ 'pl-stick': 66 })
  })

  it('refuses reused ids and replacements that are not consecutive', () => {
    const plan = userPlan()
    const twice = [
      { id: 'sec-a', typeId: 's3' },
      { id: 'sec-a', typeId: 's6' },
    ]
    expect(remap(plan, twice, FRAME).error).toBe('Section id "sec-a" is used twice.')
    const replacements = [{ from: ['sec-b', 'sec-a'], to: ['sec-x'] }]
    expect(remap(plan, [{ id: 'sec-x', typeId: 's6' }], FRAME, { replacements }).error).toBe(
      'A replacement must name consecutive sections of the old and the new stack.',
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Properties

describe('properties', () => {
  // Room to grow, so inserts are rarely refused for height.
  const ROOMY: Frame = { ...FRAME, stack: { ...FRAME.stack, maxU: 60 } }
  // Front gear is at most 150 mm deep and rear gear 30 mm in a 200 mm frame: generated layouts
  // never collide across faces, so every generated plan starts valid.
  const ITEMS = [BLANK_1U, BLANK_2U, HALF_U_PANEL, SHELF_1U, REAR_FAN_1U]

  const stackArb = fc.array(
    fc.record({ typeId: fc.constantFrom('s3', 's6'), have: fc.boolean() }),
    { minLength: 1, maxLength: 5 },
  )
  const seedsArb = fc.array(
    fc.record({
      item: fc.constantFrom(...ITEMS),
      gap: fc.nat({ max: 9 }),
      rear: fc.boolean(),
      have: fc.boolean(),
    }),
    { maxLength: 10 },
  )

  type StackSeed = { typeId: string; have: boolean }
  type ItemSeed = { item: (typeof ITEMS)[number]; gap: number; rear: boolean; have: boolean }

  function firstValidY(from: number, phases: readonly number[]): number {
    for (let y = from; y < from + 6; y++) if (phases.includes(y % 6)) return y
    return from
  }

  /** Sections bottom -> top, then items stacked per face from the bottom with gaps. */
  function buildPlan(stack: readonly StackSeed[], seeds: readonly ItemSeed[]): Plan {
    const sections = stack.map((section, index) => ({ id: `sec-${index}`, ...section }))
    const top = sections.reduce((sum, section) => sum + (section.typeId === 's3' ? 18 : 36), 0)
    const cursor: Record<Face, number> = { front: 0, rear: 0 }
    const placements: PlacementSpec[] = []
    for (const [index, seed] of seeds.entries()) {
      const face: Face =
        seed.rear && seed.item.faces.includes('rear') ? 'rear' : (seed.item.faces[0] ?? 'front')
      const y = firstValidY(cursor[face] + seed.gap, allowedPhases(seed.item, FRAME).phases)
      if (y + seed.item.heightSixths > top) continue
      placements.push({ id: `pl-${index}`, itemId: seed.item.id, y, face, have: seed.have })
      cursor[face] = y + seed.item.heightSixths
    }
    return makePlan({ frame: ROOMY, sections, placements })
  }

  function overlaps(plan: Plan): string[] {
    const boxes = plan.placements.map((placement) => occupiedBox(plan, CATALOG, placement, ROOMY))
    const pairs: string[] = []
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        if (boxesOverlap(a, b)) pairs.push(`${a.placementId} × ${b.placementId}`)
      }
    }
    return pairs
  }

  function outOfRack(plan: Plan): string[] {
    const top = totalHeightSixths(plan, ROOMY)
    return plan.placements
      .map((placement) => occupiedBox(plan, CATALOG, placement, ROOMY))
      .filter((box) => box.y0 < 0 || box.y1 > top)
      .map((box) => box.placementId ?? '?')
  }

  type Op =
    | { kind: 'insert'; at: number; typeId: string }
    | { kind: 'move'; from: number; to: number }
    | { kind: 'remove'; pick: number; removePlacements: boolean }

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      kind: fc.constant('insert' as const),
      at: fc.nat({ max: 6 }),
      typeId: fc.constantFrom('s3', 's6'),
    }),
    fc.record({
      kind: fc.constant('move' as const),
      from: fc.nat({ max: 6 }),
      to: fc.nat({ max: 6 }),
    }),
    fc.record({
      kind: fc.constant('remove' as const),
      pick: fc.nat({ max: 6 }),
      removePlacements: fc.boolean(),
    }),
  )

  function apply(plan: Plan, op: Op): StackOpResult | undefined {
    const sections = plan.frame.sections
    switch (op.kind) {
      case 'insert':
        return insertSection(plan, ROOMY, op.at % (sections.length + 1), op.typeId)
      case 'move': {
        const section = sections[op.from % Math.max(sections.length, 1)]
        if (section === undefined) return undefined
        return moveSection(plan, ROOMY, section.id, op.to % sections.length)
      }
      case 'remove': {
        const planned = sections.filter((section) => section.have === undefined)
        const section = planned[op.pick % Math.max(planned.length, 1)]
        if (section === undefined) return undefined
        return removeSection(plan, ROOMY, section.id, { removePlacements: op.removePlacements })
      }
    }
  }

  test.prop([stackArb, seedsArb, fc.array(opArb, { minLength: 1, maxLength: 5 })])(
    'insert, move and remove of planned sections never overlap or push anything out',
    (stack, seeds, ops) => {
      let plan = buildPlan(stack, seeds)
      expect(overlaps(plan)).toEqual([])
      expect(outOfRack(plan)).toEqual([])
      for (const op of ops) {
        const result = apply(plan, op)
        if (result === undefined) continue
        if (result.error !== undefined) {
          expect(result.plan).toBe(plan)
          continue
        }
        expect(overlaps(result.plan)).toEqual([])
        expect(outOfRack(result.plan)).toEqual([])
        plan = result.plan
      }
    },
  )

  test.prop([stackArb, seedsArb, fc.nat({ max: 6 }), fc.constantFrom('s3', 's6')])(
    'inserting a planned section and removing it again gives the same plan',
    (stack, seeds, at, typeId) => {
      const plan = buildPlan(stack, seeds)
      const index = at % (plan.frame.sections.length + 1)
      const inserted = insertSection(plan, ROOMY, index, typeId, { id: 'sec-new' })
      if (inserted.error !== undefined) {
        // Only items across the joint it goes into can stop it (one conflict per item).
        expect(kinds(inserted).length).toBeGreaterThan(0)
        expect(new Set(kinds(inserted))).toEqual(new Set(['straddle']))
        expect(inserted.plan).toBe(plan)
        return
      }
      const removed = removeSection(inserted.plan, ROOMY, 'sec-new')
      expect(removed.error).toBeUndefined()
      expect(removed.plan).toEqual(plan)
    },
  )

  test.prop([stackArb, seedsArb, fc.nat(), fc.nat()])(
    'moving a section there and back gives the same plan',
    (stack, seeds, from, to) => {
      const plan = buildPlan(stack, seeds)
      const count = plan.frame.sections.length
      const section = plan.frame.sections[from % count]
      if (section === undefined) return
      const there = moveSection(plan, ROOMY, section.id, to % count)
      if (there.error !== undefined) return
      const back = moveSection(there.plan, ROOMY, section.id, from % count)
      expect(back.error).toBeUndefined()
      expect(back.plan).toEqual(plan)
    },
  )

  // Mostly buildable heights (multiples of 3U), some that are not.
  const targetArb = fc.oneof(
    fc.integer({ min: 1, max: 15 }).map((n) => n * 3),
    fc.integer({ min: 3, max: 45 }),
  )

  test.prop([stackArb, seedsArb, targetArb, fc.constantFrom('top' as const, 'bottom' as const)])(
    'setHeight never changes the sections you have',
    (stack, seeds, targetU, at) => {
      const plan = buildPlan(stack, seeds)
      const result = setHeight(plan, ROOMY, targetU, at)
      const owned = (candidate: Plan) =>
        candidate.frame.sections.filter((section) => section.have !== undefined)
      const before = owned(plan)
      const after = owned(result.plan)
      expect(after).toHaveLength(before.length)
      for (const [index, section] of after.entries()) expect(section).toBe(before[index])
      if (result.error !== undefined) {
        expect(result.plan).toBe(plan)
        return
      }
      expect(totalHeightU(result.plan, ROOMY)).toBe(targetU)
      expect(overlaps(result.plan)).toEqual([])
      expect(outOfRack(result.plan)).toEqual([])
    },
  )
})
