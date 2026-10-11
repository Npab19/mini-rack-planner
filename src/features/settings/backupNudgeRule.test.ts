import { describe, expect, it } from 'vitest'
import {
  BACKUP_NUDGE_AFTER_DAYS,
  BACKUP_NUDGE_SNOOZE_DAYS,
  shouldShowBackupNudge,
} from './backupNudgeRule'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-11T12:00:00.000Z')

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString()
}

describe('shouldShowBackupNudge', () => {
  const plans = [{ updatedAt: daysAgo(1) }]

  it('needs at least one plan', () => {
    expect(shouldShowBackupNudge({ plans: [], meta: {}, now: NOW })).toBe(false)
    expect(shouldShowBackupNudge({ plans, meta: {}, now: NOW })).toBe(true)
  })

  it(`waits ${BACKUP_NUDGE_AFTER_DAYS} days after a backup`, () => {
    const recent = { lastBackupAt: daysAgo(BACKUP_NUDGE_AFTER_DAYS - 1) }
    const old = { lastBackupAt: daysAgo(BACKUP_NUDGE_AFTER_DAYS + 1) }
    const changed = [{ updatedAt: daysAgo(2) }]
    expect(shouldShowBackupNudge({ plans: changed, meta: recent, now: NOW })).toBe(false)
    expect(shouldShowBackupNudge({ plans: changed, meta: old, now: NOW })).toBe(true)
  })

  it('stays away when no plan changed since an old backup', () => {
    const meta = { lastBackupAt: daysAgo(30) }
    expect(shouldShowBackupNudge({ plans: [{ updatedAt: daysAgo(31) }], meta, now: NOW })).toBe(
      false,
    )
    // An unreadable change time counts as a change.
    expect(shouldShowBackupNudge({ plans: [{ updatedAt: '?' }], meta, now: NOW })).toBe(true)
  })

  it(`respects "Later" for ${BACKUP_NUDGE_SNOOZE_DAYS} days`, () => {
    const snoozed = { nudgeDismissedAt: daysAgo(BACKUP_NUDGE_SNOOZE_DAYS - 1) }
    const expired = { nudgeDismissedAt: daysAgo(BACKUP_NUDGE_SNOOZE_DAYS + 1) }
    expect(shouldShowBackupNudge({ plans, meta: snoozed, now: NOW })).toBe(false)
    expect(shouldShowBackupNudge({ plans, meta: expired, now: NOW })).toBe(true)
  })
})
