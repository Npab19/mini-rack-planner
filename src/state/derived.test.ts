import { describe, expect, it } from 'vitest'
import { CATALOG, makePlan, USER_SECTIONS } from '@/domain/__fixtures__/frameFixtures'
import { sampleCatalog, samplePlan } from '@/domain/__fixtures__/samplePlan'
import { createCatalogLookup, catalogBundle } from '@/domain/schema/catalog'
import { planStats } from './derived'

describe('planStats', () => {
  it('sums the stack, the used rack units and what is owned', () => {
    const plan = makePlan({
      sections: [...USER_SECTIONS, { id: 'sec-c', typeId: 's3' }],
      placements: [
        { id: 'pl-blank', itemId: 'blank-1u', y: 0, have: true },
        // Same height on the rear face: counted once.
        { id: 'pl-fan', itemId: 'rear-fan-1u', y: 0, face: 'rear' },
        {
          id: 'pl-pc',
          itemId: 'mini-pc-mount-2u',
          y: 12,
          devices: [{ id: 'dv-pc', deviceId: 'test-mini-pc', slotId: 'bay', have: true }],
        },
        { id: 'pl-half', itemId: 'half-u-panel', y: 23 },
      ],
    })
    const stats = planStats(
      { ...plan, extras: [{ id: 'ex-1', itemId: 'rubber-feet', qty: 4, haveQty: 4 }] },
      CATALOG,
    )
    expect(stats).toEqual({
      heightU: 12,
      // 1U blank/fan + 2U mount + ½U panel overlapping the mount by ⅙U.
      usedSixths: 6 + 12 + 2,
      usedU: 20 / 6,
      freeSixths: 72 - 20,
      freeU: 52 / 6,
      sectionSummary: '3U + 6U + 3U · 12U',
      // Have: 2 sections, the blank, the PC, the feet. Need: 1 section, fan, mount, panel.
      haveCount: 5,
      needCount: 4,
    })
  })

  it('handles the sample plan and an empty stack', () => {
    const stats = planStats(samplePlan(), sampleCatalog())
    expect(stats.heightU).toBe(12)
    expect(stats.sectionSummary).toBe('3U + 6U + 3U · 12U')
    expect(stats.usedU).toBeGreaterThan(0)
    expect(stats.haveCount + stats.needCount).toBeGreaterThan(10)

    const empty = planStats(makePlan(), CATALOG)
    expect(empty).toMatchObject({ heightU: 0, usedU: 0, freeU: 0, sectionSummary: 'No sections' })
  })

  it('falls back to what was built when the frame is unknown', () => {
    const stats = planStats(
      makePlan({ sections: USER_SECTIONS }),
      createCatalogLookup(catalogBundle([])),
    )
    expect(stats).toMatchObject({ heightU: 9, sectionSummary: '3U + 6U · 9U', haveCount: 2 })
    const single = planStats(makePlan({ sections: [{ id: 's', typeId: 's6' }] }), CATALOG)
    expect(single.sectionSummary).toBe('6U')
  })
})
