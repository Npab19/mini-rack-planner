/**
 * What a picked backup or plan file holds, before anything is written: its kind, the plans (and
 * which of them cannot be imported), the custom parts, and whether settings and inventory come
 * along. It follows the rules of `importBackup` (src/db/backup.ts), which stays the authority:
 * the preview only explains what the import will do.
 */
import { BACKUP_FORMAT, BACKUP_VERSION } from '@/db/backup'
import { BackupFormatError, errorMessage, LibraryEntryError } from '@/db/errors'
import { validateLibraryEntry } from '@/db/libraryRepo'
import {
  migratePlan,
  parseNewerPlanReadOnly,
  PlanInvalidError,
  PlanTooNewError,
} from '@/domain/migrate'
import { InventorySchema, SettingsSchema } from '@/domain/schema/settings'

export type PreviewPlanStatus =
  /** Imports normally. */
  | 'ok'
  /** Made by a newer app version: imports read-only (merge / replace), cannot be copied. */
  | 'read-only'
  /** Cannot be imported. */
  | 'invalid'

export interface PreviewPlan {
  /** Position in the file, from 1. */
  position: number
  id?: string
  name: string
  updatedAt?: string
  status: PreviewPlanStatus
  /** Why it cannot be imported. */
  problem?: string
}

export type PreviewPart = 'none' | 'valid' | 'invalid'

export interface ImportPreview {
  /** A full backup, or a single plan file (a bare plan, as older exports wrote them). */
  kind: 'backup' | 'plan'
  /** App version that wrote the backup. */
  appVersion?: string
  exportedAt?: string
  plans: PreviewPlan[]
  parts: { valid: number; invalid: number }
  settings: PreviewPart
  inventory: PreviewPart
  /** Every entry that will not be imported, and why. */
  problems: string[]
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, max = 200): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined
}

const NOT_A_BACKUP = 'This file is not a Mini Rack Planner backup or plan.'
const DAMAGED = 'This backup file is damaged or incomplete, so nothing can be imported.'

function previewPlan(doc: unknown, index: number): PreviewPlan {
  const record = isRecord(doc) ? doc : {}
  const base = {
    position: index + 1,
    id: text(record.id, 100),
    name: text(record.name) ?? `Plan ${index + 1}`,
    updatedAt: text(record.updatedAt, 40),
  }
  try {
    const { plan } = migratePlan(doc)
    return { ...base, id: plan.id, name: plan.name || base.name, status: 'ok' }
  } catch (error) {
    if (error instanceof PlanTooNewError && parseNewerPlanReadOnly(doc) !== undefined) {
      return { ...base, status: 'read-only' }
    }
    const detail =
      error instanceof PlanInvalidError
        ? [
            error.message,
            ...error.issues.slice(0, 2).map((issue) => `${issue.path}: ${issue.message}`),
          ].join(' ')
        : errorMessage(error)
    return { ...base, status: 'invalid', problem: detail }
  }
}

function partProblem(input: unknown, index: number, error: unknown): string {
  const id = isRecord(input) && typeof input.id === 'string' ? ` (${input.id.slice(0, 100)})` : ''
  const why =
    error instanceof LibraryEntryError
      ? [error.message, ...error.problems.slice(0, 2)].join(' ')
      : errorMessage(error)
  return `Part ${index + 1}${id} cannot be imported. ${why}`
}

function partState(value: unknown, valid: (input: unknown) => boolean): PreviewPart {
  if (value === undefined) return 'none'
  return valid(value) ? 'valid' : 'invalid'
}

/**
 * Reads a parsed file (see `readBackupFile`) without importing it.
 * @throws BackupFormatError when the file cannot be imported at all
 */
export function previewImport(json: unknown): ImportPreview {
  if (!isRecord(json)) throw new BackupFormatError(NOT_A_BACKUP)
  // A bare plan (no envelope) imports like a backup holding just that plan.
  if (json.format === undefined && isRecord(json.frame) && typeof json.id === 'string') {
    const plan = previewPlan(json, 0)
    return {
      kind: 'plan',
      plans: [plan],
      parts: { valid: 0, invalid: 0 },
      settings: 'none',
      inventory: 'none',
      problems: plan.problem === undefined ? [] : [`${plan.name}: ${plan.problem}`],
    }
  }
  if (json.format !== BACKUP_FORMAT) {
    throw new BackupFormatError(
      typeof json.format === 'string'
        ? `This is a "${json.format.slice(0, 60)}" file, not a Mini Rack Planner backup.`
        : NOT_A_BACKUP,
    )
  }
  const version = json.version
  if (typeof version === 'number' && Number.isInteger(version) && version > BACKUP_VERSION) {
    throw new BackupFormatError(
      `This backup was made by a newer version of Mini Rack Planner (backup format ${version}). Update the app to import it.`,
    )
  }
  // Missing lists are empty (like the import's own defaults); anything else must be a list.
  const planDocs = json.plans === undefined ? [] : json.plans
  const partDocs = json.library === undefined ? [] : json.library
  if (version !== BACKUP_VERSION || !Array.isArray(planDocs) || !Array.isArray(partDocs)) {
    throw new BackupFormatError(DAMAGED)
  }

  const problems: string[] = []
  const plans = planDocs.map((doc, index) => previewPlan(doc, index))
  for (const plan of plans) {
    if (plan.status === 'invalid') {
      problems.push(
        `Plan ${plan.position} (“${plan.name}”) cannot be imported. ${plan.problem ?? ''}`.trim(),
      )
    }
  }
  let validParts = 0
  for (const [index, input] of partDocs.entries()) {
    try {
      validateLibraryEntry(input)
      validParts += 1
    } catch (error) {
      problems.push(partProblem(input, index, error))
    }
  }
  const app = isRecord(json.app) ? json.app : {}
  return {
    kind: 'backup',
    appVersion: text(app.version, 40),
    exportedAt: text(json.exportedAt, 40),
    plans,
    parts: { valid: validParts, invalid: partDocs.length - validParts },
    settings: partState(json.settings, (value) => SettingsSchema.safeParse(value).success),
    inventory: partState(json.inventory, (value) => InventorySchema.safeParse(value).success),
    problems,
  }
}

/** Plans the file can add (read-only ones included: merge and replace keep them as they are). */
export function importablePlans(preview: ImportPreview): PreviewPlan[] {
  return preview.plans.filter((plan) => plan.status !== 'invalid')
}

/**
 * Replace refuses a file with any entry it cannot read (so a damaged file never wipes data);
 * invalid settings or inventory are only skipped.
 */
export function canReplace(preview: ImportPreview): boolean {
  return preview.parts.invalid === 0 && preview.plans.every((plan) => plan.status !== 'invalid')
}
