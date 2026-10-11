import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { exportBackup, importBackup } from './backup'
import {
  BACKUP_META_KEY,
  dismissBackupNudge,
  getBackupMeta,
  parseBackupMeta,
  recordBackup,
} from './backupMetaRepo'
import { getDb, resetDbForTests } from './db'
import { getSettings, SETTINGS_KEY } from './settingsRepo'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-11T12:00:00.000Z')

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString()
}

beforeEach(async () => {
  await resetDbForTests()
})

describe('backup metadata', () => {
  it('records the last backup and the dismissal under its own settings key', async () => {
    expect(await getBackupMeta()).toEqual({})
    await recordBackup(new Date(NOW))
    await dismissBackupNudge(new Date(NOW + 1000))
    expect(await getBackupMeta()).toEqual({
      lastBackupAt: '2026-10-11T12:00:00.000Z',
      nudgeDismissedAt: '2026-10-11T12:00:01.000Z',
    })
    // The global settings row is untouched.
    expect(await getDb().settings.get(SETTINGS_KEY)).toBeUndefined()
    expect((await getDb().settings.get(BACKUP_META_KEY))?.value).toMatchObject({
      lastBackupAt: '2026-10-11T12:00:00.000Z',
    })
  })

  it('drops unreadable fields instead of failing', () => {
    expect(parseBackupMeta(undefined)).toEqual({})
    expect(parseBackupMeta(['x'])).toEqual({})
    expect(parseBackupMeta({ lastBackupAt: 'yesterday', nudgeDismissedAt: 42 })).toEqual({})
    expect(parseBackupMeta({ lastBackupAt: daysAgo(1), extra: true })).toEqual({
      lastBackupAt: daysAgo(1),
    })
  })

  it('is neither exported in backups nor overwritten by importing one', async () => {
    await recordBackup(new Date(NOW))
    const file = await exportBackup({ includeSettings: true })
    expect(JSON.stringify(file)).not.toContain('lastBackupAt')

    await importBackup(
      { ...file, settings: { ...(await getSettings()), currency: 'EUR' } },
      'replace',
    )
    expect((await getSettings()).currency).toBe('EUR')
    expect((await getBackupMeta()).lastBackupAt).toBe('2026-10-11T12:00:00.000Z')
  })
})
