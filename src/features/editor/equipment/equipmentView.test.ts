import { describe, expect, it } from 'vitest'
import type { EquipmentUSummary } from '@/domain/devices'
import { KWS_FRAME, kwsCatalog, kwsPlan } from '@/domain/__fixtures__/kws'
import {
  dimsText,
  equipmentName,
  estimateText,
  fitReport,
  growPlan,
  summaryText,
  trayNeedText,
} from './equipmentView'

const CATALOG = kwsCatalog()

function summary(overrides: Partial<EquipmentUSummary> = {}): EquipmentUSummary {
  return {
    rackSixths: 54,
    usedSixths: 42,
    freeSixths: 12,
    neededSixths: 18,
    shortfallSixths: 18,
    perDevice: [],
    ...overrides,
  }
}

describe('summaryText', () => {
  it('reads like "Needs ~10U · rack 9U, 2U free → add 3U"', () => {
    expect(summaryText(summary(), false)).toBe('Needs ~10U · rack 9U, 2U free → add 3U')
    expect(trayNeedText(summary())).toBe('The equipment waiting here needs ~3U.')
  })

  it('says when it fits, and describes the rack alone with an empty tray', () => {
    const fits = summary({ rackSixths: 72, freeSixths: 30, shortfallSixths: 0 })
    expect(summaryText(fits, false)).toBe('Needs ~10U · rack 12U, 5U free · it fits')
    const empty = summary({ neededSixths: 0, shortfallSixths: 0 })
    expect(summaryText(empty, true)).toBe('Rack 9U · 7U used, 2U free')
    expect(trayNeedText(empty)).toBeUndefined()
  })

  it('keeps fractions of a U exact', () => {
    expect(summaryText(summary({ usedSixths: 39, freeSixths: 15, neededSixths: 3 }), false)).toBe(
      'Needs ~7U · rack 9U, 2½U free → add 3U',
    )
  })
})

describe('estimateText and dimsText', () => {
  it('says where the space estimate comes from', () => {
    expect(estimateText({ sixths: 6, via: 'mount', itemId: 'lenovo-tiny-mount' }, CATALOG)).toBe(
      '~1U on Lenovo Tiny mount',
    )
    expect(estimateText({ sixths: 6, via: 'rackmount' }, CATALOG)).toBe(
      '1U, mounts directly with its own ears',
    )
    expect(estimateText({ sixths: 24, via: 'estimate' }, CATALOG)).toBe(
      '~4U, estimated from its height',
    )
    expect(dimsText({ dims: { w: 179, d: 183, h: 34.5 } })).toBe('179 × 183 × 34.5 mm')
  })
})

describe('growPlan', () => {
  it('grows by the shortfall within the frame’s limits', () => {
    expect(growPlan(summary(), KWS_FRAME)).toEqual({ targetU: 12, addText: '3U' })
    expect(growPlan(summary({ shortfallSixths: 0 }), KWS_FRAME)).toBeUndefined()
    const tall = growPlan(summary({ rackSixths: 29 * 6 }), KWS_FRAME)
    expect(tall).toMatchObject({ targetU: 32, addText: '3U' })
    expect(tall?.blocked).toBe(
      'Adding 3U would make the rack 32U; KWS Rack v2 stacks go up to 30U.',
    )
  })
})

describe('fitReport', () => {
  const plan = kwsPlan({
    sections: [3, 6],
    equipment: [
      { id: 'eq-pc', deviceId: 'lenovo-m720q' },
      { id: 'eq-nas', deviceId: 'nas-2bay' },
      { id: 'eq-x', deviceId: 'mystery-box' },
    ],
  })
  const placed = (...ids: string[]) =>
    ids.map((equipmentId) => ({ equipmentId, placementId: `pl-${equipmentId}` }))

  it('names tray entries by their device, or their id when unknown', () => {
    expect(equipmentName(plan, CATALOG, 'eq-pc')).toBe('Lenovo ThinkCentre M720q Tiny')
    expect(equipmentName(plan, CATALOG, 'eq-x')).toBe('mystery-box')
    expect(equipmentName(plan, CATALOG, 'eq-gone')).toBe('eq-gone')
  })

  it('says what was placed and where the rack grew', () => {
    const all = fitReport(
      { placed: placed('eq-pc', 'eq-nas'), unplaced: [], addedU: 3 },
      plan,
      CATALOG,
      'top',
    )
    expect(all).toEqual({
      placed: 2,
      headline: 'Placed all 2 devices and added 3U at the top.',
      leftOver: [],
      announcement: 'Placed all 2 devices and added 3U at the top.',
    })
    expect(
      fitReport({ placed: placed('eq-pc'), unplaced: [], addedU: 6 }, plan, CATALOG, 'bottom', true)
        .headline,
    ).toBe('Placed the device and added 6U at the bottom, marked In my rack.')
    expect(
      fitReport({ placed: placed('eq-pc'), unplaced: [], addedU: 0 }, plan, CATALOG, 'top')
        .headline,
    ).toBe('Placed the device.')
  })

  it('lists what is still waiting, and why', () => {
    const report = fitReport(
      {
        placed: placed('eq-pc'),
        unplaced: [{ equipmentId: 'eq-nas', reason: 'No mount in the catalog takes it yet.' }],
        addedU: 0,
      },
      plan,
      CATALOG,
      'top',
    )
    expect(report.headline).toBe('Placed 1 device of 2.')
    expect(report.leftOver).toEqual([
      {
        equipmentId: 'eq-nas',
        name: 'Fixture 2-bay NAS',
        reason: 'No mount in the catalog takes it yet.',
      },
    ])
    expect(report.announcement).toBe(
      'Placed 1 device of 2. Fixture 2-bay NAS is still waiting: No mount in the catalog takes it yet.',
    )
  })

  it('says when nothing could be placed, or nothing was waiting', () => {
    const unplaced = [
      { equipmentId: 'eq-nas', reason: 'a' },
      { equipmentId: 'eq-x', reason: 'b' },
    ]
    expect(fitReport({ placed: [], unplaced, addedU: 0 }, plan, CATALOG, 'top').headline).toBe(
      'None of the 2 devices could be placed.',
    )
    expect(fitReport({ placed: [], unplaced: [], addedU: 0 }, plan, CATALOG, 'top').headline).toBe(
      'Nothing is waiting to be placed.',
    )
  })
})
