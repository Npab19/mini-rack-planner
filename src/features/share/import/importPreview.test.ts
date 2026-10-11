import { describe, expect, it } from 'vitest'
import { BACKUP_FORMAT } from '@/db/backup'
import { BackupFormatError } from '@/db/errors'
import { samplePlan } from '@/domain/__fixtures__/samplePlan'
import { canReplace, importablePlans, previewImport } from './importPreview'

const PART = {
  kind: 'device',
  id: 'custom:lab-switch',
  brand: 'DIY',
  model: 'Lab switch',
  category: 'switch',
  dims: { w: 200, d: 100, h: 30 },
  verified: { by: 'me', date: '2026-10-01', method: 'calipers' },
}

function backup(extra: Record<string, unknown> = {}) {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    app: { version: '0.1.0', sha: 'abc' },
    exportedAt: '2026-10-11T10:00:00.000Z',
    plans: [samplePlan()],
    library: [PART],
    ...extra,
  }
}

describe('previewImport', () => {
  it('counts plans and parts and says what else comes along', () => {
    const preview = previewImport(
      backup({ settings: { currency: 'EUR' }, inventory: { 'hw:nut-m6-nyloc': 10 } }),
    )
    expect(preview).toMatchObject({
      kind: 'backup',
      appVersion: '0.1.0',
      exportedAt: '2026-10-11T10:00:00.000Z',
      parts: { valid: 1, invalid: 0 },
      settings: 'valid',
      inventory: 'valid',
      problems: [],
    })
    expect(preview.plans).toEqual([
      {
        position: 1,
        id: 'plan-kws-sample',
        name: 'KWS 9U → 12U',
        updatedAt: '2026-10-11T09:30:00.000Z',
        status: 'ok',
      },
    ])
    expect(canReplace(preview)).toBe(true)
  })

  it('lists entries that cannot be imported and marks plans from a newer version', () => {
    const newer = { ...samplePlan(), id: 'plan-newer', name: 'From the future', schema: 2 }
    const broken = { ...samplePlan(), id: 'plan-broken', name: 'Broken', frame: 'nope' }
    const preview = previewImport(
      backup({
        plans: [samplePlan(), newer, broken],
        library: [PART, { ...PART, id: 'lab-switch' }],
        settings: { currency: 42 },
      }),
    )
    expect(preview.plans.map((plan) => [plan.name, plan.status])).toEqual([
      ['KWS 9U → 12U', 'ok'],
      ['From the future', 'read-only'],
      ['Broken', 'invalid'],
    ])
    expect(importablePlans(preview).map((plan) => plan.id)).toEqual([
      'plan-kws-sample',
      'plan-newer',
    ])
    expect(preview.parts).toEqual({ valid: 1, invalid: 1 })
    expect(preview.settings).toBe('invalid')
    expect(preview.inventory).toBe('none')
    expect(preview.problems).toHaveLength(2)
    expect(preview.problems[0]).toMatch(/^Plan 3 \(“Broken”\) cannot be imported\./)
    expect(preview.problems[1]).toMatch(/^Part 2 \(lab-switch\) cannot be imported\. .*custom:/)
    expect(canReplace(preview)).toBe(false)
  })

  it('reads a bare plan file as a single plan', () => {
    const preview = previewImport(samplePlan())
    expect(preview.kind).toBe('plan')
    expect(preview.plans.map((plan) => plan.status)).toEqual(['ok'])
    expect(preview.settings).toBe('none')
  })

  it('refuses files it cannot import at all', () => {
    expect(() => previewImport([1, 2])).toThrow(BackupFormatError)
    expect(() => previewImport({ hello: 'world' })).toThrow(/not a Mini Rack Planner backup/)
    expect(() => previewImport({ format: 'other-app' })).toThrow(/"other-app" file/)
    expect(() => previewImport(backup({ version: 2 }))).toThrow(/newer version/)
    expect(() => previewImport(backup({ plans: 'many' }))).toThrow(/damaged/)
  })
})
