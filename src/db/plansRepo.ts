/**
 * Saved plans. Every read goes through `migratePlan`; a plan from a newer app version opens
 * read-only and is never overwritten. Writes use a revision compare-and-swap so two tabs (or an
 * import) never silently overwrite each other, and tell other tabs about the change.
 */
import { ID_PREFIX, newId } from '@/domain/ids'
import {
  CURRENT_PLAN_SCHEMA,
  migratePlan,
  parseNewerPlanReadOnly,
  PlanInvalidError,
  PlanTooNewError,
  toPlanIssues,
} from '@/domain/migrate'
import type { CatalogLookup } from '@/domain/schema/catalog'
import { PlanSchema, type Plan } from '@/domain/schema/plan'
import { requestPersistOnce } from '@/lib/storage'
import { publishCrossTab } from './crossTab'
import type { PlanRow } from './db'
import { PlanConflictError, PlanNotFoundError, PlanReadOnlyError } from './errors'
import { clonePlanWithNewIds, copyName } from './planCopy'
import { withRetry } from './retry'

export const MAX_PLAN_NAME_LENGTH = 200

/** What the Plans page shows per plan, read without validating the whole plan. */
export interface PlanSummary {
  id: string
  rackId: string
  name: string
  frameId: string
  /** The frame's name: the plan's own custom frame, else the catalog's; unknown frames have none. */
  frameName?: string
  heightU: number
  /** Section heights, bottom to top (0 where unknown). */
  sectionHeightsU: number[]
  sectionCount: number
  haveSectionCount: number
  placementCount: number
  /** Things marked Have / still to get, counted like `planStats` (src/state/derived.ts). */
  haveCount: number
  needCount: number
  updatedAt: string
  /** Made by a newer app version: opens read-only. */
  readOnly: boolean
}

export interface LoadedPlan {
  plan: Plan
  /** Stored revision, the `expectedRev` of the next `savePlan`. */
  rev: number
  readOnly: boolean
  /** Migration notes and the read-only reason, for display. */
  warnings: string[]
}

export interface DuplicateOptions {
  /** Default: "<name> (copy)". */
  name?: string
  /** Start the copy from nothing owned (clears Have, drops retired parts). */
  resetHave: boolean
  /** Keep the rackId (another idea for the same physical rack) or start a new rack. */
  sameRack: boolean
}

export function nowIso(): string {
  return new Date().toISOString()
}

/** UTC form of an ISO date-time, so string order is time order in the `updatedAt` index. */
export function utcIso(value: string): string {
  const time = Date.parse(value)
  return Number.isNaN(time) ? value : new Date(time).toISOString()
}

/** A plan that passed `PlanSchema` (defaults applied), or a typed error naming the bad fields. */
export function validatePlan(input: Plan): Plan {
  const result = PlanSchema.safeParse(input)
  if (!result.success) {
    throw new PlanInvalidError('The plan is not valid.', toPlanIssues(result.error))
  }
  return result.data
}

/** A trimmed plan name of 1–200 characters. */
export function validPlanName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > MAX_PLAN_NAME_LENGTH) {
    throw new PlanInvalidError(`A plan name needs 1 to ${MAX_PLAN_NAME_LENGTH} characters.`)
  }
  return trimmed
}

export function planRow(plan: Plan): PlanRow {
  return {
    id: plan.id,
    rackId: plan.rackId,
    name: plan.name,
    updatedAt: utcIso(plan.updatedAt),
    rev: plan.rev,
    schema: plan.schema,
    plan,
  }
}

/** Reads a stored row: migrated and validated, or read-only when a newer app wrote it. */
export function readPlanRow(row: PlanRow): LoadedPlan {
  try {
    const { plan, warnings } = migratePlan(row.plan)
    return { plan, rev: row.rev, readOnly: false, warnings }
  } catch (error) {
    if (!(error instanceof PlanTooNewError)) throw error
    const plan = parseNewerPlanReadOnly(row.plan)
    if (plan === undefined) throw error
    return { plan, rev: row.rev, readOnly: true, warnings: [error.message] }
  }
}

function afterWrite(id: string, rev: number): void {
  publishCrossTab({ type: 'plan-saved', id, rev })
  void requestPersistOnce()
}

// ---------------------------------------------------------------------------------------------
// Summaries (cheap: no zod, tolerant of newer or damaged documents)

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function stringField(record: JsonRecord, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Fixed height of a section type (range types: their minimum, like `sectionHeightU`). */
function typeHeightU(frame: unknown, typeId: unknown): number | undefined {
  if (!isRecord(frame)) return undefined
  const type = records(frame.sectionTypes).find((candidate) => candidate.id === typeId)
  if (type === undefined) return undefined
  const height = type.heightU
  return isRecord(height) ? positiveNumber(height.min) : positiveNumber(height)
}

function sectionHeightU(section: JsonRecord, frames: readonly unknown[]): number {
  const own = positiveNumber(section.heightU)
  if (own !== undefined) return own
  for (const frame of frames) {
    const height = typeHeightU(frame, section.typeId)
    if (height !== undefined) return height
  }
  // Unknown frame or type: what was built, if it is in the user's rack.
  return isRecord(section.have) ? (positiveNumber(section.have.heightU) ?? 0) : 0
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Have / to get, like `planStats`: sections, placements, placed devices, equipment, extras. */
function haveNeedCounts(doc: JsonRecord, sections: readonly JsonRecord[]) {
  const counts = { haveCount: 0, needCount: 0 }
  const count = (owned: boolean): void => {
    if (owned) counts.haveCount += 1
    else counts.needCount += 1
  }
  for (const section of sections) count(isRecord(section.have))
  for (const placement of records(doc.placements)) {
    count(isRecord(placement.have))
    for (const device of records(placement.devices)) count(device.have === true)
  }
  for (const entry of records(doc.equipment)) count(entry.have === true)
  for (const extra of records(doc.extras)) {
    const qty = finiteNumber(extra.qty)
    // An extra is Have once all of its quantity is owned.
    if (qty > 0) count(finiteNumber(extra.haveQty) >= qty)
  }
  return counts
}

export function summarizePlanRow(row: PlanRow, lookup?: CatalogLookup): PlanSummary {
  const doc: JsonRecord = isRecord(row.plan) ? row.plan : {}
  const frame = isRecord(doc.frame) ? doc.frame : {}
  const frameId = stringField(frame, 'frameId')
  const sections = records(frame.sections)
  const custom = isRecord(doc.custom) ? doc.custom : {}
  // The plan's own custom frame wins, like withCustomEntries.
  const ownFrame = records(custom.frames).find((entry) => entry.id === frameId)
  const catalogFrame = lookup?.frame(frameId)
  const frames = [ownFrame, catalogFrame]
  const sectionHeightsU = sections.map((section) => sectionHeightU(section, frames))
  const ownName = ownFrame === undefined ? '' : stringField(ownFrame, 'name')
  const frameName = ownName === '' ? catalogFrame?.name : ownName
  return {
    id: row.id,
    rackId: row.rackId,
    name: row.name,
    frameId,
    ...(frameName === undefined ? {} : { frameName }),
    heightU: sectionHeightsU.reduce((total, height) => total + height, 0),
    sectionHeightsU,
    sectionCount: sections.length,
    haveSectionCount: sections.filter((section) => isRecord(section.have)).length,
    placementCount: records(doc.placements).length,
    ...haveNeedCounts(doc, sections),
    updatedAt: row.updatedAt,
    readOnly: row.schema > CURRENT_PLAN_SCHEMA,
  }
}

/**
 * Every plan, most recently changed first. Pass the catalog lookup to resolve section heights;
 * without it, only heights stored on the sections themselves count.
 */
export async function listPlanSummaries(lookup?: CatalogLookup): Promise<PlanSummary[]> {
  const rows = await withRetry((db) => db.plans.orderBy('updatedAt').toArray())
  return rows.toReversed().map((row) => summarizePlanRow(row, lookup))
}

/**
 * Every readable plan, migrated and validated, most recently changed first. Plans that cannot be
 * read (damaged, or too new to parse) are left out. For views over all plans, such as what they
 * still need from the parts on hand.
 */
export async function listPlans(): Promise<LoadedPlan[]> {
  const rows = await withRetry((db) => db.plans.orderBy('updatedAt').toArray())
  const plans: LoadedPlan[] = []
  for (const row of rows.toReversed()) {
    try {
      plans.push(readPlanRow(row))
    } catch {
      // Unreadable: the Plans page shows it with its own message.
    }
  }
  return plans
}

// ---------------------------------------------------------------------------------------------
// CRUD

/** @throws PlanNotFoundError, PlanInvalidError, PlanTooNewError (newer and unreadable) */
export async function getPlan(id: string): Promise<LoadedPlan> {
  const row = await withRetry((db) => db.plans.get(id))
  if (row === undefined) throw new PlanNotFoundError(id)
  return readPlanRow(row)
}

/** Stores a new plan at rev 1, stamped created/updated now. Returns the stored plan. */
export async function createPlan(input: Plan): Promise<Plan> {
  const now = nowIso()
  const plan = validatePlan({ ...input, rev: 1, createdAt: now, updatedAt: now })
  await withRetry((db) => db.plans.add(planRow(plan)))
  afterWrite(plan.id, plan.rev)
  return plan
}

/**
 * Saves a plan if the stored revision is still `expectedRev` (one read-write transaction), and
 * returns the new revision.
 * @throws PlanConflictError when the stored revision differs or the plan was deleted
 * @throws PlanReadOnlyError when a newer app version wrote the stored plan
 */
export async function savePlan(input: Plan, expectedRev: number): Promise<number> {
  const plan = validatePlan(input)
  const rev = await withRetry((db) =>
    db.transaction('rw', db.plans, async () => {
      const row = await db.plans.get(plan.id)
      if (row === undefined) throw new PlanConflictError(plan.id, null)
      // Revision first: a newer app version saving the plan is, to this tab, a conflict.
      if (row.rev !== expectedRev) throw new PlanConflictError(plan.id, row.rev)
      if (row.schema > CURRENT_PLAN_SCHEMA) throw new PlanReadOnlyError(plan.id)
      const next = row.rev + 1
      await db.plans.put(planRow({ ...plan, rev: next, updatedAt: nowIso() }))
      return next
    }),
  )
  afterWrite(plan.id, rev)
  return rev
}

export async function deletePlan(id: string): Promise<void> {
  await withRetry((db) => db.plans.delete(id))
  publishCrossTab({ type: 'plan-deleted', id })
}

/**
 * Renames a stored plan (Plans page). Bumps the revision, so an editor with the plan open sees a
 * conflict instead of overwriting the name; pass `expectedRev` to fail when it changed.
 * Returns the new revision.
 */
export async function renamePlan(id: string, name: string, expectedRev?: number): Promise<number> {
  const trimmed = validPlanName(name)
  const rev = await withRetry((db) =>
    db.transaction('rw', db.plans, async () => {
      const row = await db.plans.get(id)
      if (row === undefined) throw new PlanNotFoundError(id)
      if (expectedRev !== undefined && row.rev !== expectedRev) {
        throw new PlanConflictError(id, row.rev)
      }
      if (row.schema > CURRENT_PLAN_SCHEMA) throw new PlanReadOnlyError(id)
      const { plan } = migratePlan(row.plan)
      const next = row.rev + 1
      await db.plans.put(planRow({ ...plan, name: trimmed, rev: next, updatedAt: nowIso() }))
      return next
    }),
  )
  afterWrite(id, rev)
  return rev
}

/**
 * Stores a copy with new ids for the plan and everything in it. A read-only (newer) plan can be
 * copied too: the copy holds what this version can read.
 */
export async function duplicatePlan(id: string, options: DuplicateOptions): Promise<Plan> {
  const { plan } = await getPlan(id)
  const copy = clonePlanWithNewIds(plan, {
    name: options.name === undefined ? copyName(plan.name) : validPlanName(options.name),
    rackId: options.sameRack ? plan.rackId : newId(ID_PREFIX.rack),
    resetHave: options.resetHave,
    now: nowIso(),
  })
  return createPlan(copy)
}
