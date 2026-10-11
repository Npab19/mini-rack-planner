/**
 * When this browser last exported a full backup, and when the backup nudge was put off. Stored in
 * the settings table under its own key, apart from the global settings: it describes this origin's
 * copy of the data, so backups never carry it and importing one never overwrites it.
 */
import { withRetry } from './retry'

/** The row's key in the settings table (the global settings live under "settings"). */
export const BACKUP_META_KEY = 'backup'

export interface BackupMeta {
  /** ISO time of the last "Export everything" from this browser. */
  lastBackupAt?: string
  /** ISO time the backup nudge was last put off with "Later". */
  nudgeDismissedAt?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validIso(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined
}

/** Stored metadata with anything unreadable dropped (another app version may have written it). */
export function parseBackupMeta(value: unknown): BackupMeta {
  const meta: BackupMeta = {}
  if (!isRecord(value)) return meta
  const lastBackupAt = validIso(value.lastBackupAt)
  if (lastBackupAt !== undefined) meta.lastBackupAt = lastBackupAt
  const nudgeDismissedAt = validIso(value.nudgeDismissedAt)
  if (nudgeDismissedAt !== undefined) meta.nudgeDismissedAt = nudgeDismissedAt
  return meta
}

export async function getBackupMeta(): Promise<BackupMeta> {
  const row = await withRetry((db) => db.settings.get(BACKUP_META_KEY))
  return parseBackupMeta(row?.value)
}

async function updateBackupMeta(patch: BackupMeta): Promise<BackupMeta> {
  return withRetry((db) =>
    db.transaction('rw', db.settings, async () => {
      const stored = await db.settings.get(BACKUP_META_KEY)
      const next = { ...parseBackupMeta(stored?.value), ...patch }
      await db.settings.put({ key: BACKUP_META_KEY, value: next })
      return next
    }),
  )
}

/** Remembers a successful "Export everything". */
export function recordBackup(at: Date = new Date()): Promise<BackupMeta> {
  return updateBackupMeta({ lastBackupAt: at.toISOString() })
}

/** Puts the backup nudge off (see `BACKUP_NUDGE_SNOOZE_DAYS` in the settings feature). */
export function dismissBackupNudge(at: Date = new Date()): Promise<BackupMeta> {
  return updateBackupMeta({ nudgeDismissedAt: at.toISOString() })
}
