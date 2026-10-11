import { describe, expect, it } from 'vitest'
import { loadBundledCatalog } from '@/catalog/loader'
import { createLookup } from '@/catalog/resolver'
import { computeBom } from '@/domain/bom'
import { runChecks } from '@/domain/checks'
import { PlanSchema } from '@/domain/schema/plan'
import { defaultSettings } from '@/domain/schema/settings'
import { buildSamplePlan, SAMPLE_NAME, SampleUnavailableError } from './sample'

const NOW = '2026-10-11T09:30:00.000Z'
// The sample is made from the catalog the app bundles, so this test reads it on purpose.
const bundled = loadBundledCatalog()

describe('buildSamplePlan', () => {
  it('builds KWS 9U -> 12U from the bundled catalog: built 3U + 6U, a new 3U on top', () => {
    const { plan, skipped } = buildSamplePlan(bundled.lookup, NOW)
    expect(skipped).toEqual([])
    expect(PlanSchema.safeParse(plan).success).toBe(true)
    expect(plan.name).toBe(SAMPLE_NAME)
    expect(plan.frame.frameId).toBe('kws-rack-v2')
    expect(
      plan.frame.sections.map((section) => [section.typeId, section.have !== undefined]),
    ).toEqual([
      ['s3', true],
      ['s6', true],
      ['s3', false],
    ])
    expect(plan.frame.caps.top.have).toBeDefined()
    expect(plan.frame.caps.bottom.have).toBeDefined()
  })

  it('marks what sits in the built 9U as Have and the new section’s contents as Need', () => {
    const { plan } = buildSamplePlan(bundled.lookup, NOW)
    const summary = plan.placements.map((placement) => ({
      itemId: placement.itemId,
      y: placement.y,
      have: placement.have !== undefined,
      devices: placement.devices.map((device) => [device.deviceId, device.have]),
    }))
    expect(summary).toEqual([
      { itemId: 'kws-power-supplies-shelf-2u', y: 0, have: true, devices: [] },
      { itemId: 'generic-blank-1u', y: 12, have: true, devices: [] },
      {
        itemId: 'lenovo-tiny-mount-1u',
        y: 18,
        have: true,
        devices: [['lenovo-thinkcentre-m720q-tiny', true]],
      },
      {
        itemId: 'two-3-5-drive-rack-1u',
        y: 54,
        have: false,
        devices: [
          ['drive-3-5-inch', false],
          ['drive-3-5-inch', false],
        ],
      },
    ])
    expect(plan.placements[0]?.have).toMatchObject({
      at: NOW,
      itemId: 'kws-power-supplies-shelf-2u',
    })
  })

  it('is a clean plan: no placement errors, and a shopping list for the new 3U', () => {
    const { plan } = buildSamplePlan(bundled.lookup, NOW)
    const errors = runChecks(plan, bundled.lookup, defaultSettings()).filter(
      (issue) => issue.severity === 'error',
    )
    expect(errors).toEqual([])
    const bom = computeBom(plan, bundled.lookup, defaultSettings(), {})
    const plate = bom.lines.find((line) => line.key === 'print:kws-rack-v2/plate-3u')
    expect(plate).toMatchObject({ target: 2, asBuilt: 1, need: 1 })
    const drives = bom.lines.find((line) => line.key === 'device:drive-3-5-inch')
    expect(drives?.need).toBe(2)
  })

  it('gets fresh ids every time', () => {
    const a = buildSamplePlan(bundled.lookup, NOW).plan
    const b = buildSamplePlan(bundled.lookup, NOW).plan
    expect(a.id).not.toBe(b.id)
    expect(a.rackId).not.toBe(b.rackId)
    expect(a.placements[0]?.id).not.toBe(b.placements[0]?.id)
  })

  it('leaves out mounts and devices the catalog does not have', () => {
    const entries = [
      ...bundled.lookup.allFrames(),
      ...bundled.lookup.allItems().filter((item) => item.id !== 'generic-blank-1u'),
      ...bundled.lookup.allDevices().filter((device) => device.id !== 'drive-3-5-inch'),
      ...bundled.lookup.allHardware(),
    ]
    const { plan, skipped } = buildSamplePlan(createLookup(entries), NOW)
    expect(skipped).toEqual(['generic-blank-1u', 'drive-3-5-inch', 'drive-3-5-inch'])
    expect(plan.placements.map((placement) => placement.itemId)).toEqual([
      'kws-power-supplies-shelf-2u',
      'lenovo-tiny-mount-1u',
      'two-3-5-drive-rack-1u',
    ])
    expect(plan.placements[2]?.devices).toEqual([])
  })

  it('explains when the KWS frame itself is missing', () => {
    const lookup = createLookup(bundled.lookup.allItems())
    expect(() => buildSamplePlan(lookup, NOW)).toThrow(SampleUnavailableError)
  })
})
