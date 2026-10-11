import { describe, expect, it } from 'vitest'
import { backupFileName } from '@/db/backup'
import { localDateStamp } from './date'

describe('localDateStamp', () => {
  it('is the local calendar day, whatever the UTC date is', () => {
    // Local midnight-adjacent times: toISOString() would roll over in many time zones.
    expect(localDateStamp(new Date(2026, 9, 11, 23, 59))).toBe('2026-10-11')
    expect(localDateStamp(new Date(2026, 0, 2, 0, 1))).toBe('2026-01-02')
  })

  it('dates backup files the same way', () => {
    expect(backupFileName(new Date(2026, 9, 11, 23, 59))).toBe(
      'mini-rack-planner-backup-2026-10-11.json',
    )
  })
})
