/**
 * Plan schema migrations. Every external plan (Dexie row, JSON import, share link) goes through
 * `migratePlan`: an ordered chain of pure upgrade steps, then zod validation.
 */
import type { z } from 'zod'
import { PLAN_SCHEMA_VERSION, PlanSchema, type Plan } from './schema/plan'

export const CURRENT_PLAN_SCHEMA = PLAN_SCHEMA_VERSION

/** A plan as raw JSON, before migration and validation. */
export type PlanDocument = Record<string, unknown>

export interface PlanMigration {
  /** Upgrades a document from schema `from` to `from + 1`. Must not mutate its input. */
  from: number
  up: (doc: PlanDocument, warnings: string[]) => PlanDocument
}

/** Ordered upgrade steps. v1 is the first schema, so there is nothing to upgrade yet. */
export const PLAN_MIGRATIONS: readonly PlanMigration[] = []

export interface PlanIssue {
  path: string
  message: string
}

/** Base class for every reason a plan cannot be loaded. */
export class PlanLoadError extends Error {
  override name = 'PlanLoadError'
}

/** Made by a newer version of the app: callers open it read-only (see `parseNewerPlanReadOnly`). */
export class PlanTooNewError extends PlanLoadError {
  override name = 'PlanTooNewError'
  readonly found: number
  readonly supported: number

  constructor(found: number, supported: number) {
    super(`This plan uses schema ${found}; this version of the app supports up to ${supported}.`)
    this.found = found
    this.supported = supported
  }
}

/** Not a plan, or a plan that fails validation after migration. */
export class PlanInvalidError extends PlanLoadError {
  override name = 'PlanInvalidError'
  readonly issues: readonly PlanIssue[]

  constructor(message: string, issues: readonly PlanIssue[] = []) {
    super(message)
    this.issues = issues
  }
}

function isRecord(value: unknown): value is PlanDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** zod issues as `{ path: "frame.sections.0.typeId", message }` for error reports. */
export function toPlanIssues(error: z.ZodError): PlanIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }))
}

function schemaVersionOf(doc: PlanDocument, warnings: string[]): number {
  const version = doc.schema
  if (version === undefined) {
    warnings.push(`The plan had no schema version; read it as schema ${CURRENT_PLAN_SCHEMA}.`)
    return CURRENT_PLAN_SCHEMA
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new PlanInvalidError(`Unknown plan schema version: ${JSON.stringify(version)}`)
  }
  return version
}

/** Applies the upgrade steps from `from` up to `to`, in order. */
export function runMigrations(
  doc: PlanDocument,
  from: number,
  to: number,
  migrations: readonly PlanMigration[],
  warnings: string[],
): PlanDocument {
  let current = doc
  for (let version = from; version < to; version++) {
    const step = migrations.find((migration) => migration.from === version)
    if (step === undefined) throw new PlanInvalidError(`No migration from plan schema ${version}`)
    current = { ...step.up(current, warnings), schema: version + 1 }
  }
  return current
}

/**
 * Upgrades and validates any external plan.
 * @throws PlanTooNewError when the plan comes from a newer app version.
 * @throws PlanInvalidError when it is not a valid plan.
 */
export function migratePlan(input: unknown): { plan: Plan; warnings: string[] } {
  if (!isRecord(input)) throw new PlanInvalidError('A plan must be a JSON object.')
  const warnings: string[] = []
  const version = schemaVersionOf(input, warnings)
  if (version > CURRENT_PLAN_SCHEMA) throw new PlanTooNewError(version, CURRENT_PLAN_SCHEMA)
  const upgraded = runMigrations(
    { ...input, schema: version },
    version,
    CURRENT_PLAN_SCHEMA,
    PLAN_MIGRATIONS,
    warnings,
  )
  const result = PlanSchema.safeParse(upgraded)
  if (!result.success) {
    throw new PlanInvalidError('The plan is not valid.', toPlanIssues(result.error))
  }
  return { plan: result.data, warnings }
}

/**
 * Best-effort read of a plan from a newer app version, for read-only display: parsed as if it
 * were the current schema. Undefined when that fails (the newer format changed too much).
 */
export function parseNewerPlanReadOnly(input: unknown): Plan | undefined {
  if (!isRecord(input)) return undefined
  const result = PlanSchema.safeParse({ ...input, schema: CURRENT_PLAN_SCHEMA })
  return result.success ? result.data : undefined
}
