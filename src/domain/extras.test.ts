import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { computeBom } from './bom'
import {
  addExtra,
  catalogExtras,
  MAX_EXTRA_QTY,
  removeExtra,
  setExtraHaveQty,
  setExtraQty,
  type ExtraOpResult,
} from './extras'
import { hardwareKey } from './ids'
import type { Plan } from './schema/plan'
import { defaultSettings } from './schema/settings'
import { EDITOR_IDS } from './__fixtures__/editorFixtures'
import { KWS_IDS, kwsCatalog, kwsPlan, parseEntries } from './__fixtures__/kws'

const LATER = '2026-10-12T08:00:00.000Z'
const FEET = EDITOR_IDS.rubberFeet
const FOOT_KEY = hardwareKey(KWS_IDS.rubberFoot)
const SETTINGS = defaultSettings()

/** A 3U rack (built) with a line of 2 rubber-feet sets, `haveQty` of them owned. */
function withFeet(haveQty: number, qty = 2): Plan {
  return kwsPlan({
    sections: [{ u: 3, have: true }],
    extras: [{ id: 'ex-feet', itemId: FEET, qty, haveQty }],
  })
}

function applied(result: ExtraOpResult): Plan {
  if (result.error !== undefined) throw new Error(result.error)
  expect(result.conflicts).toEqual([])
  return result.plan
}

/** Feet on the BOM's rubber-foot line: [planned, owned]. Each set holds 4 feet. */
function feetLine(plan: Plan): [number, number] {
  const line = computeBom(plan, kwsCatalog(), SETTINGS, {}).lines.find(
    (candidate) => candidate.key === FOOT_KEY,
  )
  return [line?.target ?? 0, line?.asBuilt ?? 0]
}

/** Owned sets of rubber feet anywhere in the plan: on the line plus "Removed but owned". */
function ownedFeet(plan: Plan): number {
  const onLine = plan.extras
    .filter((extra) => extra.itemId === FEET)
    .reduce((total, extra) => total + extra.haveQty, 0)
  const removed = plan.retired
    .filter((entry) => entry.kind === 'extra' && entry.snapshot.itemId === FEET)
    .reduce((total, entry) => total + (entry.qty ?? 0), 0)
  return onLine + removed
}

describe('catalogExtras', () => {
  it('lists only accessories, by name', () => {
    const [clips] = parseEntries([
      {
        kind: 'extra',
        id: 'cable-clips',
        name: 'Cable clips',
        category: 'accessory',
        verified: { by: 'fixture', date: '2026-10-11', method: 'page' },
        heightSixths: 0,
        depthMm: 0,
      },
    ])
    if (clips === undefined) throw new Error('No fixture')
    expect(catalogExtras(kwsCatalog([clips])).map((item) => item.id)).toEqual(['cable-clips', FEET])
    expect(catalogExtras(kwsCatalog()).every((item) => item.kind === 'extra')).toBe(true)
  })
})

describe('addExtra', () => {
  const empty = kwsPlan({ sections: [3] })

  it('starts a line with a new id, owned as asked (clamped to the quantity)', () => {
    const result = addExtra(empty, FEET, 3, { haveQty: 5 })
    const next = applied(result)
    expect(result.extraId).toMatch(/^ex-/)
    expect(next.extras).toEqual([{ id: result.extraId, itemId: FEET, qty: 3, haveQty: 3 }])
    expect(applied(addExtra(empty, FEET, 2)).extras[0]).toMatchObject({ qty: 2, haveQty: 0 })
    expect(feetLine(next)).toEqual([12, 12])
  })

  it('adds to the line the accessory already has', () => {
    const result = addExtra(withFeet(1), FEET, 2.9, { haveQty: 1 })
    expect(result.extraId).toBe('ex-feet')
    expect(applied(result).extras).toEqual([{ id: 'ex-feet', itemId: FEET, qty: 4, haveQty: 2 }])
  })

  it('refuses nothing, too many and malformed ids, leaving the plan as it is', () => {
    const plan = withFeet(0)
    const cases: Array<[string, number, string]> = [
      [FEET, 0, 'Add at least one.'],
      [FEET, Number.NaN, 'Add at least one.'],
      [FEET, MAX_EXTRA_QTY - 1, `A plan can list up to ${MAX_EXTRA_QTY} of one accessory.`],
      ['Not An Id', 1, '"Not An Id" is not an accessory id.'],
    ]
    for (const [itemId, qty, error] of cases) {
      expect(addExtra(plan, itemId, qty)).toEqual({ plan, conflicts: [], error })
    }
  })
})

describe('setExtraQty', () => {
  it('changes how many the plan uses; the same count changes nothing', () => {
    const plan = withFeet(1)
    const next = applied(setExtraQty(plan, 'ex-feet', 5))
    expect(next.extras[0]).toMatchObject({ qty: 5, haveQty: 1 })
    expect(next.retired).toEqual([])
    expect(feetLine(next)).toEqual([20, 4])
    const same = setExtraQty(plan, 'ex-feet', 2.4)
    expect(same.plan).toBe(plan)
    expect(same.error).toBeUndefined()
  })

  it('keeps the owned ones beyond the new quantity under Removed but owned', () => {
    const plan = withFeet(2)
    const result = setExtraQty(plan, 'ex-feet', 1, { at: LATER })
    const next = applied(result)
    expect(next.extras[0]).toMatchObject({ qty: 1, haveQty: 1 })
    expect(next.retired).toEqual([
      {
        id: result.retiredId,
        kind: 'extra',
        snapshot: { at: LATER, itemId: FEET, options: {} },
        sourceId: 'ex-feet',
        qty: 1,
      },
    ])
    // What you own is still counted as built: 4 planned, 8 owned (4 of them left over).
    expect(feetLine(next)).toEqual([4, 8])
    expect(feetLine(plan)).toEqual([8, 8])
  })

  it('adds to the removed accessories already kept for it', () => {
    const plan = applied(setExtraQty(withFeet(3, 3), 'ex-feet', 2, { at: LATER }))
    const result = setExtraQty(plan, 'ex-feet', 1, { at: '2026-10-13T08:00:00.000Z' })
    const next = applied(result)
    expect(next.retired).toHaveLength(1)
    expect(next.retired[0]).toMatchObject({
      id: plan.retired[0]?.id,
      qty: 2,
      snapshot: { at: '2026-10-13T08:00:00.000Z' },
    })
    expect(result.retiredId).toBe(plan.retired[0]?.id)
  })

  it('refuses none, too many, not a number and unknown lines', () => {
    const plan = withFeet(0)
    const cases: Array<[string, number, string]> = [
      ['ex-feet', 0, 'Keep at least one, or remove the accessory instead.'],
      ['ex-feet', MAX_EXTRA_QTY + 1, `A plan can list up to ${MAX_EXTRA_QTY} of one accessory.`],
      ['ex-feet', Number.POSITIVE_INFINITY, 'Enter a whole number.'],
      ['ex-nope', 3, 'There is no accessory "ex-nope" in this plan.'],
    ]
    for (const [extraId, qty, error] of cases) {
      expect(setExtraQty(plan, extraId, qty)).toEqual({ plan, conflicts: [], error })
    }
  })
})

describe('setExtraHaveQty', () => {
  it('counts the owned ones, whole and within 0..qty', () => {
    const plan = withFeet(0, 4)
    expect(applied(setExtraHaveQty(plan, 'ex-feet', 2.7)).extras[0]?.haveQty).toBe(2)
    expect(applied(setExtraHaveQty(plan, 'ex-feet', 9)).extras[0]?.haveQty).toBe(4)
    expect(applied(setExtraHaveQty(withFeet(3, 4), 'ex-feet', -1)).extras[0]?.haveQty).toBe(0)
    expect(feetLine(applied(setExtraHaveQty(plan, 'ex-feet', 3)))).toEqual([16, 12])
  })

  it('returns the same plan when nothing changes, and refuses what it cannot count', () => {
    const plan = withFeet(1)
    expect(setExtraHaveQty(plan, 'ex-feet', 1).plan).toBe(plan)
    expect(setExtraHaveQty(plan, 'ex-feet', Number.NaN)).toEqual({
      plan,
      conflicts: [],
      error: 'Enter a whole number.',
    })
    expect(setExtraHaveQty(plan, 'ex-x', 1).error).toBe(
      'There is no accessory "ex-x" in this plan.',
    )
  })
})

describe('removeExtra', () => {
  it('takes a line you own none of out of the plan', () => {
    const result = removeExtra(withFeet(0), 'ex-feet')
    expect(applied(result).extras).toEqual([])
    expect(result.plan.retired).toEqual([])
    expect(result.retiredId).toBeUndefined()
  })

  it('keeps the ones you own under Removed but owned', () => {
    const plan = withFeet(2, 3)
    const result = removeExtra(plan, 'ex-feet', { at: LATER })
    const next = applied(result)
    expect(next.extras).toEqual([])
    expect(next.retired).toEqual([expect.objectContaining({ id: result.retiredId, qty: 2 })])
    expect(feetLine(next)).toEqual([0, 8])
  })

  it('refuses unknown lines', () => {
    const plan = withFeet(1)
    expect(removeExtra(plan, 'ex-x')).toEqual({
      plan,
      conflicts: [],
      error: 'There is no accessory "ex-x" in this plan.',
    })
  })

  it('never mutates its input', () => {
    const plan = withFeet(2)
    const copy = structuredClone(plan)
    removeExtra(plan, 'ex-feet')
    setExtraQty(plan, 'ex-feet', 1)
    setExtraHaveQty(plan, 'ex-feet', 0)
    addExtra(plan, FEET, 3)
    expect(plan).toEqual(copy)
  })
})

describe('extras: properties', () => {
  const step = fc.oneof(
    fc.record({ op: fc.constant('qty' as const), n: fc.integer({ min: -2, max: 12 }) }),
    fc.record({ op: fc.constant('remove' as const) }),
    fc.record({ op: fc.constant('add' as const), n: fc.integer({ min: 1, max: 6 }) }),
  )

  test.prop([fc.integer({ min: 0, max: 6 }), fc.array(step, { maxLength: 8 })])(
    'planning fewer or removing never loses what you own, and haveQty stays within 0..qty',
    (owned, steps) => {
      let plan = withFeet(owned, 6)
      const ownedBefore = ownedFeet(plan)
      for (const next of steps) {
        const line = plan.extras.find((extra) => extra.itemId === FEET)
        const result =
          next.op === 'add'
            ? addExtra(plan, FEET, next.n)
            : line === undefined
              ? undefined
              : next.op === 'qty'
                ? setExtraQty(plan, line.id, next.n)
                : removeExtra(plan, line.id)
        if (result === undefined) continue
        if (result.error !== undefined) expect(result.plan).toBe(plan)
        plan = result.plan
      }
      expect(ownedFeet(plan)).toBe(ownedBefore)
      for (const extra of plan.extras) {
        expect(extra.haveQty).toBeGreaterThanOrEqual(0)
        expect(extra.haveQty).toBeLessThanOrEqual(extra.qty)
      }
      // The BOM counts every owned set: 4 feet each.
      expect(feetLine(plan)[1]).toBe(ownedBefore * 4)
    },
  )
})
