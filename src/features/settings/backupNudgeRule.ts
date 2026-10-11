/**
 * When the Plans page suggests a backup. The metadata itself lives in the data layer
 * (`@/db/backupMetaRepo`, `useBackupMeta` in `@/state/backupMeta`); this is only the rule.
 */
import type { BackupMeta } from '@/db/backupMetaRepo'

/** The nudge shows once the last backup is this old (or there is none). */
export const BACKUP_NUDGE_AFTER_DAYS = 14
/** "Later" keeps the nudge away this long. */
export const BACKUP_NUDGE_SNOOZE_DAYS = 14

const DAY_MS = 86_400_000

function timeOf(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined
  const time = Date.parse(iso)
  return Number.isFinite(time) ? time : undefined
}

export interface BackupNudgeInput {
  /** The saved plans (only their change times matter). */
  plans: readonly { updatedAt: string }[]
  meta: BackupMeta
  /** Epoch milliseconds. */
  now: number
}

/**
 * Whether to suggest a backup: there is at least one plan, the nudge was not put off within
 * BACKUP_NUDGE_SNOOZE_DAYS, and there is no backup from the last BACKUP_NUDGE_AFTER_DAYS. An older
 * backup made after the last plan change still holds everything, so it does not count as missing.
 */
export function shouldShowBackupNudge({ plans, meta, now }: BackupNudgeInput): boolean {
  if (plans.length === 0) return false
  const dismissedAt = timeOf(meta.nudgeDismissedAt)
  if (dismissedAt !== undefined && now - dismissedAt < BACKUP_NUDGE_SNOOZE_DAYS * DAY_MS) {
    return false
  }
  const lastBackupAt = timeOf(meta.lastBackupAt)
  if (lastBackupAt === undefined) return true
  if (now - lastBackupAt < BACKUP_NUDGE_AFTER_DAYS * DAY_MS) return false
  // An unreadable change time counts as a change: better one reminder too many than one too few.
  return plans.some((plan) => (timeOf(plan.updatedAt) ?? Number.POSITIVE_INFINITY) > lastBackupAt)
}
