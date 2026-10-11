import { describe, expect, it } from 'vitest'
import type { EquipmentUSummary } from '@/domain/devices'
import { KWS_FRAME, kwsCatalog } from '@/domain/__fixtures__/kws'
import { dimsText, estimateText, growPlan, summaryText, trayNeedText } from './equipmentView'

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
