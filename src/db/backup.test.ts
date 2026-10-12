import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { makePlan, USER_SECTIONS } from '@/domain/__fixtures__/frameFixtures'
import { samplePlan } from '@/domain/__fixtures__/samplePlan'
import type { Plan } from '@/domain/schema/plan'
import {
  BACKUP_FORMAT,
  BackupFileSchema,
  exportBackup,
  importBackup,
  MAX_BACKUP_BYTES,
  parseBackupText,
  readBackupFile,
  serializeBackup,
  type BackupFile,
} from './backup'
import { getDb, resetDbForTests } from './db'
import { BackupFormatError } from './errors'
import { getInventory, setQty } from './inventoryRepo'
import { listLibrary, putLibraryEntry } from './libraryRepo'
import { createPlan, getPlan, savePlan } from './plansRepo'
import { getSettings, updateSettings } from './settingsRepo'

const NAS_PART = {
  kind: 'device',
  id: 'custom:my-nas',
  brand: 'DIY',
  model: 'Tiny NAS',
  category: 'nas',
  dims: { w: 150, d: 150, h: 60 },
  verified: { by: 'me', date: '2026-10-01', method: 'calipers' },
} as const

beforeEach(async () => {
  await resetDbForTests()
})

/** The file as it would be written and read back (JSON drops undefined and copies everything). */
function viaJson(file: BackupFile): unknown {
  return JSON.parse(serializeBackup(file))
}

async function seed(): Promise<{ sample: Plan; user: Plan }> {
  const sample = await createPlan(samplePlan())
  const user = await createPlan(makePlan({ sections: USER_SECTIONS }))
  await putLibraryEntry(NAS_PART)
  await updateSettings({ currency: 'EUR' })
  await setQty('hw:m6-nyloc', 12)
  return { sample, user }
}

/** Plan content without the bookkeeping that import changes (rev). */
function content(plan: Plan): Plan {
  return { ...plan, rev: 0 }
}

describe('exportBackup', () => {
  it('exports a valid backup file without model files', async () => {
    const { sample } = await seed()
    const file = await exportBackup({ includeSettings: true })
    const parsed = BackupFileSchema.parse(viaJson(file))
    expect(parsed.format).toBe(BACKUP_FORMAT)
    expect(parsed.plans).toHaveLength(2)
    expect(parsed.library.map((entry) => entry.id)).toEqual(['custom:my-nas'])
    expect(parsed.settings?.currency).toBe('EUR')
    expect(parsed.inventory).toEqual({ 'hw:m6-nyloc': 12 })
    expect(Object.keys(parsed)).not.toContain('models')

    const one = await exportBackup({ planIds: [sample.id], includeSettings: false })
    expect(one.plans).toEqual([sample])
    expect(one.library).toEqual([])
    expect(one.settings).toBeUndefined()
    expect(one.inventory).toBeUndefined()
  })
  it('exports a plan with the parts of your own it uses, even without the library', async () => {
    await putLibraryEntry(NAS_PART)
    const stored = await createPlan({
      ...makePlan({ sections: USER_SECTIONS }),
      equipment: [{ id: 'eq-nas', deviceId: NAS_PART.id, have: false }],
    })
    const one = await exportBackup({ planIds: [stored.id], includeSettings: false })
    expect(one.library).toEqual([])
    const [exported] = one.plans as Plan[]
    expect(exported?.custom.devices).toEqual([NAS_PART])
    expect(exported?.equipment).toEqual(stored.equipment)

    // Imported elsewhere as a copy, it still knows the device.
    await resetDbForTests()
    const result = await importBackup(viaJson(one), 'copy')
    const copy = (await getPlan(result.planIds[0] ?? '')).plan
    expect(copy.custom.devices.map((device) => device.id)).toEqual([NAS_PART.id])
    expect(copy.equipment.map((entry) => entry.deviceId)).toEqual([NAS_PART.id])
  })
})

describe('importBackup', () => {
  it('round-trips everything through replace', async () => {
    const { sample, user } = await seed()
    const file = viaJson(await exportBackup({ includeSettings: true }))
    await resetDbForTests()

    const result = await importBackup(file, 'replace')
    expect(result).toMatchObject({
      added: 2,
      updated: 0,
      skipped: 0,
      removed: 0,
      library: { added: 1 },
      settingsImported: true,
      inventoryImported: true,
      errors: [],
    })
    expect(content((await getPlan(sample.id)).plan)).toEqual(content(sample))
    expect(content((await getPlan(user.id)).plan)).toEqual(content(user))
    expect((await listLibrary()).entries.map((entry) => entry.id)).toEqual(['custom:my-nas'])
    expect((await getSettings()).currency).toBe('EUR')
    expect(await getInventory()).toEqual({ 'hw:m6-nyloc': 12 })
  })

  it('replace removes what the file does not have and bumps revisions of open plans', async () => {
    const { sample, user } = await seed()
    await savePlan(sample, 1)
    const file = viaJson(await exportBackup({ planIds: [sample.id], includeSettings: false }))

    const result = await importBackup(file, 'replace')
    expect(result).toMatchObject({ added: 0, updated: 1, removed: 1 })
    expect(await getDb().plans.count()).toBe(1)
    await expect(getPlan(user.id)).rejects.toThrow()
    // Higher than any revision a tab may hold, so an open editor gets a conflict.
    expect((await getPlan(sample.id)).rev).toBe(3)
    expect((await listLibrary()).entries).toEqual([])
    // Settings and inventory are only replaced when the file has them.
    expect((await getSettings()).currency).toBe('EUR')
    expect(await getInventory()).toEqual({ 'hw:m6-nyloc': 12 })
  })

  it('merge adds new plans, takes newer ones and skips older or equal ones', async () => {
    const { sample } = await seed()
    const fresh = makePlan({ sections: USER_SECTIONS })
    const incoming = {
      format: BACKUP_FORMAT,
      version: 1,
      app: { version: 'test', sha: 'test' },
      exportedAt: '2030-01-01T00:00:00.000Z',
      plans: [
        { ...sample, name: 'From the file', updatedAt: '2030-01-01T00:00:00.000Z' },
        { ...fresh, id: 'plan-from-file' },
      ],
      library: [NAS_PART, { ...NAS_PART, id: 'custom:other-nas' }],
    }
    const result = await importBackup(incoming, 'merge')
    expect(result).toMatchObject({ added: 1, updated: 1, skipped: 0, errors: [] })
    expect(result.library).toEqual({ added: 1, updated: 0, skipped: 1 })
    expect(result.planIds).toEqual([sample.id, 'plan-from-file'])
    const merged = await getPlan(sample.id)
    expect(merged.plan.name).toBe('From the file')
    expect(merged.rev).toBe(2)
    expect(merged.plan.updatedAt).toBe('2030-01-01T00:00:00.000Z')

    const older = await importBackup(
      { ...incoming, plans: [{ ...sample, name: 'Old', updatedAt: '2020-01-01T00:00:00.000Z' }] },
      'merge',
    )
    expect(older).toMatchObject({ added: 0, updated: 0, skipped: 1 })
    expect((await getPlan(sample.id)).plan.name).toBe('From the file')
  })

  // Regression: with nothing to merge in the library, the settings write used to run outside the
  // transaction (lost Dexie zone), which then committed early with only the plans written.
  it('merges a full backup without custom parts, settings and inventory included', async () => {
    const user = await createPlan(makePlan({ sections: USER_SECTIONS }))
    await updateSettings({ currency: 'EUR' })
    await setQty('hw:m6-nyloc', 3)
    const file = viaJson(await exportBackup({ includeSettings: true }))
    await resetDbForTests()

    const result = await importBackup(file, 'merge')
    expect(result).toMatchObject({
      added: 1,
      settingsImported: true,
      inventoryImported: true,
      errors: [],
    })
    expect(result.library).toEqual({ added: 0, updated: 0, skipped: 0 })
    expect((await getPlan(user.id)).plan.name).toBe(user.name)
    expect((await getSettings()).currency).toBe('EUR')
    expect(await getInventory()).toEqual({ 'hw:m6-nyloc': 3 })
  })

  it('merges a backup that holds only settings', async () => {
    await updateSettings({ currency: 'GBP' })
    const file = viaJson(await exportBackup({ includeSettings: true }))
    await resetDbForTests()

    const result = await importBackup(file, 'merge')
    expect(result).toMatchObject({ added: 0, settingsImported: true, planIds: [] })
    expect((await getSettings()).currency).toBe('GBP')
  })

  it('copy gives new ids, resets ownership and keeps plans of one rack together', async () => {
    const sample = await createPlan(samplePlan())
    const sibling = await createPlan({ ...samplePlan(), id: 'plan-sibling', name: 'Idea 2' })
    const file = viaJson(await exportBackup({ includeSettings: true }))

    const result = await importBackup(file, 'copy')
    expect(result).toMatchObject({ added: 2, updated: 0, errors: [] })
    expect(result.warnings).toContain(
      'Settings and parts on hand in the file were not imported (copy mode).',
    )
    const copyId = result.renamedIds[sample.id]
    const siblingCopyId = result.renamedIds[sibling.id]
    expect(copyId).toBeDefined()
    expect(copyId).not.toBe(sample.id)
    const copy = (await getPlan(copyId ?? '')).plan
    const siblingCopy = (await getPlan(siblingCopyId ?? '')).plan
    expect(copy.rackId).not.toBe(sample.rackId)
    expect(siblingCopy.rackId).toBe(copy.rackId)
    // The originals are still here, so the copy's name says it is one.
    expect(copy.name).toBe('KWS 9U → 12U (copy)')
    expect(copy.frame.sections.every((section) => section.have === undefined)).toBe(true)
    expect(copy.placements.every((placement) => placement.have === undefined)).toBe(true)
    expect(copy.retired).toEqual([])
    expect(copy.placements[0]?.id).not.toBe(sample.placements[0]?.id)
    expect(await getDb().plans.count()).toBe(4)
  })

  it('accepts a single plan file', async () => {
    const plan = samplePlan()
    const result = await importBackup(JSON.parse(JSON.stringify(plan)), 'merge')
    expect(result).toMatchObject({ added: 1, planIds: [plan.id] })
    expect((await getPlan(plan.id)).plan.name).toBe(plan.name)
  })

  it('reports invalid plans and imports the rest; replace refuses such a file', async () => {
    const plan = samplePlan()
    const file = {
      format: BACKUP_FORMAT,
      version: 1,
      plans: [plan, { id: 'plan-bad', name: 'Broken', frame: { frameId: 'Bad Id' } }],
      library: [{ ...NAS_PART, id: 'not-custom' }],
    }
    const merged = await importBackup(file, 'merge')
    expect(merged.added).toBe(1)
    expect(merged.errors).toHaveLength(2)
    expect(merged.errors[0]).toMatch(/^Plan 2 \("Broken"\) was not imported/)
    expect(merged.errors[1]).toMatch(/^Part 1 \(not-custom\) was not imported/)

    await resetDbForTests()
    const replaced = await importBackup(file, 'replace').catch((error) => error)
    expect(replaced).toBeInstanceOf(BackupFormatError)
    expect((replaced as BackupFormatError).details).toHaveLength(2)
    expect(await getDb().plans.count()).toBe(0)
  })

  it('stores a plan from a newer app untouched and opens it read-only', async () => {
    const newer = { ...samplePlan(), schema: 2, futureOnly: true }
    const result = await importBackup(
      { format: BACKUP_FORMAT, version: 1, plans: [newer], library: [] },
      'merge',
    )
    expect(result.added).toBe(1)
    expect(result.warnings[0]).toMatch(/newer version/)
    const loaded = await getPlan(newer.id)
    expect(loaded.readOnly).toBe(true)
    expect((await getDb().plans.get(newer.id))?.plan).toMatchObject({ futureOnly: true })

    const copied = await importBackup(
      { format: BACKUP_FORMAT, version: 1, plans: [newer], library: [] },
      'copy',
    )
    expect(copied.added).toBe(0)
    expect(copied.errors[0]).toMatch(/cannot be copied/)
  })

  it('rejects files that are not backups, or from a newer backup format', async () => {
    const cases: unknown[] = [
      null,
      'backup',
      [samplePlan()],
      { format: 'something-else', version: 1 },
      { hello: 'world' },
      { format: BACKUP_FORMAT, version: 2, plans: [] },
      { format: BACKUP_FORMAT, version: 1, plans: 'nope' },
      { format: BACKUP_FORMAT, plans: [] },
    ]
    for (const input of cases) {
      await expect(importBackup(input, 'merge')).rejects.toBeInstanceOf(BackupFormatError)
    }
    await expect(
      importBackup({ format: BACKUP_FORMAT, version: 2, plans: [] }, 'merge'),
    ).rejects.toThrow(/newer version/)
    expect(await getDb().plans.count()).toBe(0)
  })
})

describe('reading backup files', () => {
  it('parses JSON (with a byte order mark) and rejects broken or oversized text', async () => {
    expect(parseBackupText('﻿{"a":1}')).toEqual({ a: 1 })
    expect(() => parseBackupText('{"a":')).toThrow(BackupFormatError)
    expect(() => parseBackupText(' '.repeat(MAX_BACKUP_BYTES + 1))).toThrow(/larger than 20 MB/)
    await expect(readBackupFile(new Blob(['{"b":2}']))).resolves.toEqual({ b: 2 })
    const huge = new Blob([new Uint8Array(MAX_BACKUP_BYTES + 1)])
    await expect(readBackupFile(huge)).rejects.toThrow(/larger than 20 MB/)
  })
})
