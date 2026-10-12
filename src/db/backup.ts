/**
 * JSON backups: plans (as stored, plus any of your own parts they use but do not carry yet), the
 * custom parts library and, optionally, settings and
 * inventory. Model files are never included (import-only policy): re-dropping the same files
 * relinks them by SHA-256.
 *
 * Import validates everything first (each plan through `migratePlan`, each part through the
 * library rules), then writes in one transaction, so a failed import changes nothing.
 * - merge: upsert by id; a stored plan is replaced only by a newer `updatedAt`.
 * - replace: clears plans and library (settings/inventory only when the file has them), then
 *   inserts. Refused when any entry is invalid, so a damaged file never wipes data.
 * - copy: new ids for every plan and everything in it, Have/owned reset (like duplicatePlan with
 *   resetHave); plans that shared a rack in the file still share one. Parts merge.
 * Overwritten plans get a higher revision than before, so an editor that has one open sees a
 * conflict instead of silently saving over the import.
 */
import { z } from 'zod'
import { canonicalJson } from '@/catalog/revision'
import { embedUsedCustomEntries } from '@/domain/customParts'
import { ID_PREFIX, newId } from '@/domain/ids'
import {
  CURRENT_PLAN_SCHEMA,
  migratePlan,
  parseNewerPlanReadOnly,
  PlanInvalidError,
  PlanTooNewError,
  type PlanDocument,
} from '@/domain/migrate'
import { CatalogEntrySchema, type CatalogEntry } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import {
  InventorySchema,
  SettingsSchema,
  type Inventory,
  type Settings,
} from '@/domain/schema/settings'
import { localDateStamp } from '@/lib/date'
import { publishCrossTab, type CrossTabOutgoing } from './crossTab'
import type { LibraryRow, MrpDb, PlanRow } from './db'
import { BackupFormatError, errorMessage, LibraryEntryError } from './errors'
import { inventoryFromRows, inventoryRows } from './inventoryRepo'
import { libraryRow, readLibraryRows, validateLibraryEntry } from './libraryRepo'
import { clonePlanWithNewIds, copyName } from './planCopy'
import { nowIso, planRow, utcIso } from './plansRepo'
import { withRetry } from './retry'
import { parseSettings, SETTINGS_KEY } from './settingsRepo'

export const BACKUP_FORMAT = 'mini-rack-planner-backup'
export const BACKUP_VERSION = 1
/** Files above this are refused before they are read or parsed. */
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024

export const BackupFileSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_VERSION),
  app: z.object({ version: z.string(), sha: z.string() }),
  exportedAt: z.iso.datetime({ offset: true }),
  /** Plan documents as stored; each one is validated with `migratePlan` on import. */
  plans: z.array(z.unknown()),
  library: z.array(CatalogEntrySchema),
  settings: SettingsSchema.optional(),
  inventory: InventorySchema.optional(),
})
export type BackupFile = z.infer<typeof BackupFileSchema>

export type ImportMode = 'merge' | 'replace' | 'copy'

export interface ImportCounts {
  added: number
  updated: number
  skipped: number
}

/** Counts are plans; the same counts for custom parts are in `library`. */
export interface ImportResult extends ImportCounts {
  mode: ImportMode
  /** Local plans deleted because the file replaced everything (replace mode). */
  removed: number
  /** Ids of the plans written, in file order (the new ids in copy mode). */
  planIds: string[]
  /** Original id -> new id of every copied plan (copy mode). */
  renamedIds: Record<string, string>
  library: ImportCounts
  settingsImported: boolean
  inventoryImported: boolean
  /** Entries that were not imported, and why. */
  errors: string[]
  warnings: string[]
}

// ---------------------------------------------------------------------------------------------
// Export

export interface ExportOptions {
  /** Only these plans (default: all of them). */
  planIds?: readonly string[]
  /** The global settings and the inventory. */
  includeSettings: boolean
  /** The custom parts library (default: when exporting all plans). */
  includeLibrary?: boolean
}

function appInfo(): BackupFile['app'] {
  return {
    version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
    sha: typeof __GIT_SHA__ === 'string' ? __GIT_SHA__ : 'dev',
  }
}

/**
 * The plan with the parts of your own it uses but does not carry yet (made before M3b copied them
 * in on every edit), so a single exported plan opens complete elsewhere. Plans that need nothing,
 * and plans this version cannot read, are exported as stored.
 */
function withOwnParts(document: PlanDocument, library: readonly CatalogEntry[]): PlanDocument {
  if (library.length === 0) return document
  try {
    const { plan } = migratePlan(document)
    const embedded = embedUsedCustomEntries(plan, library)
    return embedded === plan ? document : embedded
  } catch {
    return document
  }
}

/** A consistent snapshot (one read transaction) as a backup document. */
export async function exportBackup(options: ExportOptions): Promise<BackupFile> {
  const includeLibrary = options.includeLibrary ?? options.planIds === undefined
  const wanted = options.planIds === undefined ? undefined : new Set(options.planIds)
  const snapshot = await withRetry((db) =>
    db.transaction('r', [db.plans, db.library, db.settings, db.inventory], async () => ({
      plans: await db.plans.orderBy('updatedAt').toArray(),
      // Also read when not exported: plans take along the parts they use (`withOwnParts`).
      library: await db.library.orderBy('updatedAt').toArray(),
      settings: options.includeSettings ? await db.settings.get(SETTINGS_KEY) : undefined,
      inventory: options.includeSettings ? await db.inventory.toArray() : [],
    })),
  )
  const library = readLibraryRows(snapshot.library.toReversed()).entries
  // Newest first, like the Plans page.
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: appInfo(),
    exportedAt: nowIso(),
    plans: snapshot.plans
      .toReversed()
      .filter((row) => wanted?.has(row.id) ?? true)
      .map((row) => withOwnParts(row.plan, library)),
    library: includeLibrary ? library : [],
  }
  if (options.includeSettings) {
    file.settings = parseSettings(snapshot.settings?.value)
    file.inventory = inventoryFromRows(snapshot.inventory)
  }
  return file
}

/** Pretty-printed JSON with a trailing newline. */
export function serializeBackup(file: BackupFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

/** "mini-rack-planner-backup-2026-10-11.json", dated in local time like the user's calendar. */
export function backupFileName(date: Date = new Date()): string {
  return `mini-rack-planner-backup-${localDateStamp(date)}.json`
}

// ---------------------------------------------------------------------------------------------
// Reading files

const NOT_A_BACKUP = 'This file is not a Mini Rack Planner backup or plan.'
const TOO_LARGE = `This file is larger than ${MAX_BACKUP_BYTES / 1024 / 1024} MB, so it cannot be a Mini Rack Planner backup.`

/** Parses backup text, refusing oversized input before parsing. */
export function parseBackupText(text: string): unknown {
  // A string of n UTF-16 units is at least n bytes as UTF-8, so this never lets a bigger file by.
  if (text.length > MAX_BACKUP_BYTES) throw new BackupFormatError(TOO_LARGE)
  try {
    return JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new BackupFormatError('This file is not valid JSON, so it cannot be imported.')
  }
}

/** Reads a dropped or picked file, checking its size before reading it. */
export async function readBackupFile(file: Blob): Promise<unknown> {
  if (file.size > MAX_BACKUP_BYTES) throw new BackupFormatError(TOO_LARGE)
  return parseBackupText(await file.text())
}

// ---------------------------------------------------------------------------------------------
// Import: validation

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Lenient outer shape: plans, parts, settings and inventory are each checked on their own. */
const EnvelopeSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_VERSION),
  plans: z.array(z.unknown()).default(() => []),
  library: z.array(z.unknown()).default(() => []),
  settings: z.unknown().optional(),
  inventory: z.unknown().optional(),
})
type Envelope = z.infer<typeof EnvelopeSchema>

function looksLikePlan(json: JsonRecord): boolean {
  return isRecord(json.frame) && typeof json.id === 'string'
}

function readEnvelope(json: unknown): Envelope {
  if (!isRecord(json)) throw new BackupFormatError(NOT_A_BACKUP)
  // A single plan file (a bare Plan object) imports like a backup holding just that plan.
  if (json.format === undefined && looksLikePlan(json)) {
    return { format: BACKUP_FORMAT, version: BACKUP_VERSION, plans: [json], library: [] }
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
  const envelope = EnvelopeSchema.safeParse(json)
  if (!envelope.success) {
    throw new BackupFormatError(
      'This backup file is damaged or incomplete, so nothing was imported.',
    )
  }
  return envelope.data
}

interface IncomingPlan {
  /** Validated plan; for a newer-schema document, the best-effort read-only parse. */
  plan: Plan
  /** The original document, stored untouched, when a newer app version made it. */
  newerDoc?: PlanDocument
}

function planLabel(index: number, doc: unknown): string {
  const name = isRecord(doc) && typeof doc.name === 'string' ? doc.name.slice(0, 80) : ''
  return name === '' ? `Plan ${index + 1}` : `Plan ${index + 1} ("${name}")`
}

function describeLoadError(error: unknown): string {
  if (error instanceof PlanInvalidError) {
    const issues = error.issues.slice(0, 2).map((issue) => `${issue.path}: ${issue.message}`)
    return [error.message, ...issues].join(' ')
  }
  return errorMessage(error)
}

function preparePlans(
  docs: readonly unknown[],
  errors: string[],
  warnings: string[],
): IncomingPlan[] {
  const prepared: IncomingPlan[] = []
  for (const [index, doc] of docs.entries()) {
    try {
      const { plan, warnings: notes } = migratePlan(doc)
      prepared.push({ plan })
      for (const note of notes) warnings.push(`${planLabel(index, doc)}: ${note}`)
    } catch (error) {
      const newer = error instanceof PlanTooNewError ? parseNewerPlanReadOnly(doc) : undefined
      if (newer !== undefined && isRecord(doc)) {
        prepared.push({ plan: newer, newerDoc: doc })
        warnings.push(
          `${planLabel(index, doc)} was made by a newer version of Mini Rack Planner; it opens read-only here.`,
        )
        continue
      }
      errors.push(`${planLabel(index, doc)} was not imported. ${describeLoadError(error)}`)
    }
  }
  return prepared
}

function prepareLibrary(entries: readonly unknown[], errors: string[]): CatalogEntry[] {
  const valid = new Map<string, CatalogEntry>()
  for (const [index, input] of entries.entries()) {
    try {
      const entry = validateLibraryEntry(input)
      if (!valid.has(entry.id)) valid.set(entry.id, entry)
    } catch (error) {
      const id =
        isRecord(input) && typeof input.id === 'string' ? ` (${input.id.slice(0, 100)})` : ''
      const why =
        error instanceof LibraryEntryError
          ? [error.message, ...error.problems.slice(0, 2)].join(' ')
          : errorMessage(error)
      errors.push(`Part ${index + 1}${id} was not imported. ${why}`)
    }
  }
  return [...valid.values()]
}

/** Keeps the newest copy of each plan id (by `updatedAt`). */
function newestById(plans: readonly IncomingPlan[], warnings: string[]): IncomingPlan[] {
  const byId = new Map<string, IncomingPlan>()
  for (const item of plans) {
    const seen = byId.get(item.plan.id)
    if (seen === undefined) {
      byId.set(item.plan.id, item)
      continue
    }
    warnings.push(`The file holds "${item.plan.name}" more than once; the newest copy was used.`)
    if (isNewer(item.plan.updatedAt, seen.plan.updatedAt)) byId.set(item.plan.id, item)
  }
  return [...byId.values()]
}

function isNewer(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b)
}

function rowFor(item: IncomingPlan, rev: number): PlanRow {
  if (item.newerDoc === undefined) return planRow({ ...item.plan, rev })
  const { plan, newerDoc } = item
  return {
    id: plan.id,
    rackId: plan.rackId,
    name: plan.name,
    updatedAt: utcIso(plan.updatedAt),
    rev,
    schema: typeof newerDoc.schema === 'number' ? newerDoc.schema : CURRENT_PLAN_SCHEMA + 1,
    plan: newerDoc,
  }
}

// ---------------------------------------------------------------------------------------------
// Import: writing (inside one transaction; may run twice through withRetry, so it only returns
// what it did and never mutates outer state).
//
// Every `await` inside the transaction is a Dexie promise. Awaiting a native promise (such as an
// async helper's) can lose Dexie's transaction zone: the next write then runs outside the
// transaction, which commits early (PrematureCommitError) after writing only part of the file.
// So the helpers below only plan (rows from what was read); `writeImport` does the reads and
// writes itself.

interface Prepared {
  plans: IncomingPlan[]
  library: CatalogEntry[]
  settings?: Settings
  inventory?: Inventory
}

interface WriteOutcome {
  counts: ImportCounts
  library: ImportCounts
  removed: number
  planIds: string[]
  renamedIds: Record<string, string>
  settingsImported: boolean
  inventoryImported: boolean
  errors: string[]
  warnings: string[]
  messages: CrossTabOutgoing[]
}

function emptyOutcome(): WriteOutcome {
  return {
    counts: { added: 0, updated: 0, skipped: 0 },
    library: { added: 0, updated: 0, skipped: 0 },
    removed: 0,
    planIds: [],
    renamedIds: {},
    settingsImported: false,
    inventoryImported: false,
    errors: [],
    warnings: [],
    messages: [],
  }
}

/** Merge: rows to add or replace, given the stored row for each incoming plan (same order). */
function mergePlanRows(
  incoming: readonly IncomingPlan[],
  stored: readonly (PlanRow | undefined)[],
  out: WriteOutcome,
): PlanRow[] {
  const rows: PlanRow[] = []
  for (const [index, item] of incoming.entries()) {
    const { plan } = item
    const existing = stored[index]
    if (existing === undefined) {
      rows.push(rowFor(item, 1))
      out.counts.added += 1
      out.planIds.push(plan.id)
      out.messages.push({ type: 'plan-saved', id: plan.id, rev: 1 })
    } else if (existing.schema > CURRENT_PLAN_SCHEMA) {
      out.counts.skipped += 1
      out.warnings.push(
        `Kept your copy of "${existing.name}": it was saved by a newer version of the app.`,
      )
    } else if (isNewer(plan.updatedAt, existing.updatedAt)) {
      const rev = existing.rev + 1
      rows.push(rowFor(item, rev))
      out.counts.updated += 1
      out.planIds.push(plan.id)
      out.messages.push({ type: 'plan-saved', id: plan.id, rev })
    } else {
      out.counts.skipped += 1
    }
  }
  return rows
}

/** Replace: every incoming plan, a revision above the one it replaces (`oldRevs`: all stored). */
function replacePlanRows(
  incoming: readonly IncomingPlan[],
  oldRevs: ReadonlyMap<string, number>,
  out: WriteOutcome,
): PlanRow[] {
  const rows = incoming.map((item) => {
    const { id } = item.plan
    const oldRev = oldRevs.get(id)
    const rev = (oldRev ?? 0) + 1
    if (oldRev === undefined) out.counts.added += 1
    else out.counts.updated += 1
    out.planIds.push(id)
    out.messages.push({ type: 'plan-saved', id, rev })
    return rowFor(item, rev)
  })
  const kept = new Set(incoming.map((item) => item.plan.id))
  for (const id of oldRevs.keys()) {
    if (kept.has(id)) continue
    out.removed += 1
    out.messages.push({ type: 'plan-deleted', id })
  }
  return rows
}

/** Copy: new plans with new ids; `names` (the stored names) gains every name used. */
function copyPlanRows(
  plans: readonly IncomingPlan[],
  names: Set<string>,
  now: string,
  out: WriteOutcome,
): PlanRow[] {
  const racks = new Map<string, string>()
  const rows: PlanRow[] = []
  for (const item of plans) {
    if (item.newerDoc !== undefined) {
      out.errors.push(
        `"${item.plan.name}" was made by a newer version of Mini Rack Planner, so it cannot be copied. Import it with "merge" to open it read-only.`,
      )
      continue
    }
    const original = item.plan
    const rackId = racks.get(original.rackId) ?? newId(ID_PREFIX.rack)
    racks.set(original.rackId, rackId)
    const name = names.has(original.name) ? copyName(original.name) : original.name
    const copy = clonePlanWithNewIds(original, { name, rackId, resetHave: true, now })
    rows.push(planRow({ ...copy, rev: 1 }))
    names.add(name)
    out.counts.added += 1
    out.planIds.push(copy.id)
    out.renamedIds[original.id] = copy.id
    out.messages.push({ type: 'plan-saved', id: copy.id, rev: 1 })
  }
  return rows
}

/** Parts to add, given the stored row for each incoming part (same order); clashes keep ours. */
function mergeLibraryRows(
  entries: readonly CatalogEntry[],
  stored: readonly (LibraryRow | undefined)[],
  now: string,
  out: WriteOutcome,
): LibraryRow[] {
  const rows: LibraryRow[] = []
  for (const [index, entry] of entries.entries()) {
    const existing = stored[index]
    if (existing === undefined) {
      rows.push(libraryRow(entry, now))
      out.library.added += 1
    } else {
      out.library.skipped += 1
      if (canonicalJson(existing.entry) !== canonicalJson(entry)) {
        // No timestamps travel with parts, so the local version is the safe choice.
        out.warnings.push(
          `Kept your version of the part "${entry.id}"; the file has a different one.`,
        )
      }
    }
  }
  return rows
}

async function writeImport(db: MrpDb, mode: ImportMode, data: Prepared): Promise<WriteOutcome> {
  const out = emptyOutcome()
  const now = nowIso()
  // Empty lists skip their read and write entirely (nothing to wait for).
  if (mode === 'replace') {
    const incoming = newestById(data.plans, out.warnings)
    const oldRevs = new Map((await db.plans.toArray()).map((row) => [row.id, row.rev]))
    const rows = replacePlanRows(incoming, oldRevs, out)
    await db.plans.clear()
    if (rows.length > 0) await db.plans.bulkAdd(rows)
    await db.library.clear()
    if (data.library.length > 0) {
      await db.library.bulkAdd(data.library.map((entry) => libraryRow(entry, now)))
    }
    out.library.added = data.library.length
  } else {
    let rows: PlanRow[] = []
    if (mode === 'merge') {
      const incoming = newestById(data.plans, out.warnings)
      const ids = incoming.map((item) => item.plan.id)
      if (ids.length > 0) rows = mergePlanRows(incoming, await db.plans.bulkGet(ids), out)
    } else if (data.plans.length > 0) {
      const names = new Set((await db.plans.orderBy('name').keys()).map(String))
      rows = copyPlanRows(data.plans, names, now, out)
    }
    if (rows.length > 0) await db.plans.bulkPut(rows)
    if (data.library.length > 0) {
      const ids = data.library.map((entry) => entry.id)
      const parts = mergeLibraryRows(data.library, await db.library.bulkGet(ids), now, out)
      if (parts.length > 0) await db.library.bulkAdd(parts)
    }
  }
  if (mode === 'copy') {
    if (data.settings !== undefined || data.inventory !== undefined) {
      out.warnings.push('Settings and parts on hand in the file were not imported (copy mode).')
    }
    return out
  }
  if (data.settings !== undefined) {
    await db.settings.put({ key: SETTINGS_KEY, value: data.settings })
    out.settingsImported = true
  }
  if (data.inventory !== undefined) {
    if (mode === 'replace') await db.inventory.clear()
    const rows = inventoryRows(data.inventory)
    if (rows.length > 0) await db.inventory.bulkPut(rows)
    out.inventoryImported = true
  }
  return out
}

/**
 * Imports a backup (or a single plan file) that is already parsed: see `parseBackupText` /
 * `readBackupFile` for size-checked parsing.
 * @throws BackupFormatError when the file cannot be imported at all (nothing is written)
 */
export async function importBackup(json: unknown, mode: ImportMode): Promise<ImportResult> {
  const envelope = readEnvelope(json)
  const errors: string[] = []
  const warnings: string[] = []
  const data: Prepared = {
    plans: preparePlans(envelope.plans, errors, warnings),
    library: prepareLibrary(envelope.library, errors),
  }
  if (envelope.settings !== undefined) {
    const settings = SettingsSchema.safeParse(envelope.settings)
    if (settings.success) data.settings = settings.data
    else warnings.push('The settings in this file are not valid; your settings were kept.')
  }
  if (envelope.inventory !== undefined) {
    const inventory = InventorySchema.safeParse(envelope.inventory)
    if (inventory.success) data.inventory = inventory.data
    else warnings.push('The parts on hand in this file are not valid; yours were kept.')
  }
  if (mode === 'replace' && errors.length > 0) {
    throw new BackupFormatError(
      `Nothing was replaced: ${errors.length} ${errors.length === 1 ? 'entry' : 'entries'} in this file could not be read.`,
      errors,
    )
  }

  const out = await withRetry((db) =>
    db.transaction('rw', [db.plans, db.library, db.settings, db.inventory], () =>
      writeImport(db, mode, data),
    ),
  )
  for (const message of out.messages) publishCrossTab(message)
  return {
    mode,
    ...out.counts,
    removed: out.removed,
    planIds: out.planIds,
    renamedIds: out.renamedIds,
    library: out.library,
    settingsImported: out.settingsImported,
    inventoryImported: out.inventoryImported,
    errors: [...errors, ...out.errors],
    warnings: [...warnings, ...out.warnings],
  }
}
