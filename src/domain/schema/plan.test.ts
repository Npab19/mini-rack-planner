import { describe, expect, it } from 'vitest'
import { AlignRecordSchema } from './align'
import { PlanSchema, SnapshotSchema } from './plan'
import { defaultSettings, InventorySchema, SettingsSchema, sparePctFor } from './settings'

const NOW = '2026-10-11T09:30:00.000Z'

const minimalPlan = {
  schema: 1,
  id: 'plan-abc123',
  rackId: 'rack-abc123',
  name: 'KWS 9U -> 12U',
  createdAt: NOW,
  updatedAt: NOW,
  frame: { frameId: 'kws-v2' },
}

describe('PlanSchema', () => {
  it('fills defaults for a minimal plan', () => {
    const plan = PlanSchema.parse(minimalPlan)
    expect(plan.rev).toBe(0)
    expect(plan.frame).toEqual({
      frameId: 'kws-v2',
      options: {},
      caps: { top: {}, bottom: {} },
      sections: [],
    })
    expect(plan.placements).toEqual([])
    expect(plan.equipment).toEqual([])
    expect(plan.extras).toEqual([])
    expect(plan.retired).toEqual([])
    expect(plan.custom).toEqual({ frames: [], items: [], devices: [], hardware: [] })
  })

  it('does not share default arrays between parses', () => {
    const a = PlanSchema.parse(minimalPlan)
    const b = PlanSchema.parse(minimalPlan)
    expect(a.placements).not.toBe(b.placements)
    expect(a.frame.sections).not.toBe(b.frame.sections)
  })

  it('parses a full plan', () => {
    const plan = PlanSchema.parse({
      ...minimalPlan,
      rev: 7,
      catalogRev: 'abc123',
      frame: {
        frameId: 'kws-v2',
        options: { magnets: true },
        caps: { top: { options: { top: 'handle' }, have: { at: NOW } } },
        sections: [
          {
            id: 'sec-1',
            typeId: 's3',
            have: { at: NOW, typeId: 's3', heightU: 3, options: { magnets: true } },
          },
          { id: 'sec-2', typeId: 's6' },
        ],
      },
      placements: [
        {
          id: 'pl-1',
          itemId: 'mini-pc-shelf',
          name: 'Mini PC shelf',
          heightSixths: 12,
          y: 6,
          face: 'front',
          bay: 'left',
          devices: [
            {
              id: 'dv-1',
              deviceId: 'lenovo-m920q',
              slotId: 'bay',
              orientation: 'flat',
              have: true,
            },
          ],
        },
      ],
      equipment: [{ id: 'eq-1', deviceId: 'ms-01', have: false }],
      extras: [{ id: 'ex-1', itemId: 'rubber-feet', qty: 4, haveQty: 4 }],
      retired: [
        {
          id: 'rt-1',
          kind: 'cap',
          snapshot: { at: NOW, options: { top: 'flat' } },
          sourceId: 'top',
        },
      ],
    })
    expect(plan.frame.caps.bottom).toEqual({})
    expect(plan.frame.caps.top.have?.options).toEqual({})
    expect(plan.placements[0]?.devices[0]?.have).toBe(true)
    expect(plan.extras[0]?.haveQty).toBe(4)
  })

  it('rejects other schema versions and malformed fields', () => {
    expect(PlanSchema.safeParse({ ...minimalPlan, schema: 2 }).success).toBe(false)
    expect(PlanSchema.safeParse({ ...minimalPlan, createdAt: 'yesterday' }).success).toBe(false)
    expect(PlanSchema.safeParse({ ...minimalPlan, id: 'Plan 1' }).success).toBe(false)
    const placement = { id: 'pl-1', itemId: 'blank-1u', y: 1.5, face: 'front' }
    expect(PlanSchema.safeParse({ ...minimalPlan, placements: [placement] }).success).toBe(false)
    expect(
      PlanSchema.safeParse({ ...minimalPlan, extras: [{ id: 'ex-1', itemId: 'x', qty: -1 }] })
        .success,
    ).toBe(false)
  })

  it('only accepts custom: ids for entries the plan carries', () => {
    const hardware = { kind: 'hardware', name: 'My bolt', category: 'screw' }
    const withHardware = (id: string) => ({
      ...minimalPlan,
      custom: { hardware: [{ ...hardware, id }] },
    })
    expect(PlanSchema.safeParse(withHardware('custom:my-bolt')).success).toBe(true)
    const shadowing = PlanSchema.safeParse(withHardware('m6x8-shcs'))
    expect(shadowing.success).toBe(false)
    expect(shadowing.error?.issues[0]?.path).toEqual(['custom', 'hardware', 0, 'id'])
  })

  it('accepts ISO timestamps with offsets in snapshots', () => {
    expect(SnapshotSchema.safeParse({ at: '2026-10-11T11:30:00+02:00' }).success).toBe(true)
    expect(SnapshotSchema.safeParse({ at: '2026-10-11' }).success).toBe(false)
  })
})

describe('settings', () => {
  it('has sensible defaults', () => {
    expect(defaultSettings()).toEqual({
      currency: 'USD',
      filamentCostPerKg: { PLA: 20, PETG: 22 },
      sparePct: { screw: 0.1, nut: 0.1, insert: 0.1, magnet: 0.05, default: 0 },
      packPrices: {},
    })
  })

  it('validates values', () => {
    expect(SettingsSchema.safeParse({ currency: 'usd' }).success).toBe(false)
    expect(SettingsSchema.safeParse({ sparePct: { screw: 10 } }).success).toBe(false)
    expect(
      SettingsSchema.safeParse({ packPrices: { 'm6x8-shcs': [{ size: 50, price: 4.5 }] } }).success,
    ).toBe(true)
  })

  it('looks up spare fractions with a fallback', () => {
    const settings = defaultSettings()
    expect(sparePctFor(settings, 'magnet')).toBe(0.05)
    expect(sparePctFor(settings, 'washer')).toBe(0)
    expect(sparePctFor({ ...settings, sparePct: {} }, 'screw')).toBe(0)
  })

  it('keeps inventory counts non-negative', () => {
    expect(InventorySchema.safeParse({ 'hw:m6x8-shcs': 12 }).success).toBe(true)
    expect(InventorySchema.safeParse({ 'hw:m6x8-shcs': -1 }).success).toBe(false)
  })
})

describe('AlignRecordSchema', () => {
  const record = {
    schema: 'mrp.align/1',
    catalogPartId: 'kws-v2/leg-6u',
    match: {
      fileSha256: 'a'.repeat(64),
      sig: { tri: 12000, areaMm2: 51000.5, volMm3: 120000, extMm: [20, 266.7, 30] },
      nameHints: ['6U leg'],
    },
    pose: {
      basis: ['+x', '-z', '+y'],
      anchor: { mesh: ['mid', 'min', 'max'], slot: ['mid', 'min', 'max'] },
    },
    provenance: { method: 'curated', conf: 1 },
  }

  it('parses a record and fills pose defaults', () => {
    const parsed = AlignRecordSchema.parse(record)
    expect(parsed.pose.mirrorX).toBe(false)
    expect(parsed.pose.offsetMm).toEqual([0, 0, 0])
  })

  it('requires the basis to be a signed permutation', () => {
    const bad = { ...record, pose: { ...record.pose, basis: ['+x', '-x', '+y'] } }
    expect(AlignRecordSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects other formats and malformed hashes', () => {
    expect(AlignRecordSchema.safeParse({ ...record, schema: 'mrp.align/2' }).success).toBe(false)
    expect(AlignRecordSchema.safeParse({ ...record, match: { fileSha256: 'XYZ' } }).success).toBe(
      false,
    )
  })
})
