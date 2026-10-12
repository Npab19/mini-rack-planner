/**
 * Accessories (M3b): catalog entries of `kind: 'extra'` that take no rack space (cable clips, LED
 * guides, feet), listed in `plan.extras` with how many the plan uses (`qty`) and how many of those
 * the user already owns (`haveQty`, "In my rack"). The BOM counts qty × the accessory's recipe as
 * planned and haveQty × it as built.
 *
 * - One line per accessory: `addExtra` adds to it (or starts it), `setExtraQty` and
 *   `setExtraHaveQty` change its counts, `removeExtra` takes it out.
 * - Owned accessories never silently disappear: planning fewer than you own, or removing a line
 *   you own some of, keeps the owned ones under "Removed but owned" (a retired extra, see
 *   retired.ts), so the BOM still counts them as yours.
 * - Pure: inputs are never mutated. Refused edits return the input plan with a user-facing `error`
 *   (the `StackOpResult` contract); edits that change nothing return the same plan.
 */
import type { StackOpResult } from './api'
import { ID_PREFIX, KEBAB_PATTERN, newId } from './ids'
import type { CatalogLookup, Item } from './schema/catalog'
import { CUSTOM_ID_PREFIX } from './schema/common'
import type { Plan, PlanExtra, RetiredEntry } from './schema/plan'

/** Most of one accessory a plan lists: a guard against typing 4000 for 4. */
export const MAX_EXTRA_QTY = 999

// Same rule as `IdSchema` (schema/common.ts), without building a zod schema here.
const ID_PATTERN = new RegExp(`^(?:${CUSTOM_ID_PREFIX})?${KEBAB_PATTERN}$`)
const MAX_ID_LENGTH = 100

/** An accessory edit: the `StackOpResult` contract plus the ids it touched. */
export interface ExtraOpResult extends StackOpResult {
  /** The accessory line added or changed. */
  extraId?: string
  /** The "Removed but owned" entry that now holds owned accessories taken out of the plan. */
  retiredId?: string
}

export interface AddExtraOptions {
  /** How many of the added ones are already owned (Recording mode: all of them). Default 0. */
  haveQty?: number
}

export interface RemoveExtraOptions {
  /** When owned accessories left the plan (the "Removed but owned" entry's time); default now. */
  at?: string
}

function failed(plan: Plan, error: string): ExtraOpResult {
  return { plan, conflicts: [], error }
}

function missing(plan: Plan, extraId: string): ExtraOpResult {
  return failed(plan, `There is no accessory "${extraId}" in this plan.`)
}

/** Rounded down to a whole number; undefined for NaN and infinities. */
function wholeNumber(value: number): number | undefined {
  return Number.isFinite(value) ? Math.floor(value) : undefined
}

const TOO_MANY = `A plan can list up to ${MAX_EXTRA_QTY} of one accessory.`

/** The catalog's accessories (`kind: 'extra'`) by name; the plan's lookup includes its own. */
export function catalogExtras(catalog: CatalogLookup): Item[] {
  return catalog
    .allItems()
    .filter((item) => item.kind === 'extra')
    .toSorted(
      (a, b) =>
        a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
}

/**
 * Adds `qty` of an accessory (whole, at least 1): to its existing line, else on a new one.
 * `options.haveQty` of them are already owned (clamped to 0..qty). The id is not looked up: the
 * BOM reports accessories the catalog does not know.
 */
export function addExtra(
  plan: Plan,
  itemId: string,
  qty: number,
  options: AddExtraOptions = {},
): ExtraOpResult {
  if (itemId.length > MAX_ID_LENGTH || !ID_PATTERN.test(itemId)) {
    return failed(plan, `"${itemId}" is not an accessory id.`)
  }
  const count = wholeNumber(qty)
  if (count === undefined || count < 1) return failed(plan, 'Add at least one.')
  const owned = Math.min(count, Math.max(0, wholeNumber(options.haveQty ?? 0) ?? 0))
  const index = plan.extras.findIndex((extra) => extra.itemId === itemId)
  const existing = plan.extras[index]
  if ((existing?.qty ?? 0) + count > MAX_EXTRA_QTY) return failed(plan, TOO_MANY)
  if (existing !== undefined) {
    const updated = { ...existing, qty: existing.qty + count, haveQty: existing.haveQty + owned }
    return {
      plan: { ...plan, extras: plan.extras.with(index, updated) },
      conflicts: [],
      extraId: existing.id,
    }
  }
  const extra: PlanExtra = { id: newId(ID_PREFIX.extra), itemId, qty: count, haveQty: owned }
  return { plan: { ...plan, extras: [...plan.extras, extra] }, conflicts: [], extraId: extra.id }
}

/**
 * How many of an accessory the plan uses (whole, 1..`MAX_EXTRA_QTY`; remove the line to go to
 * none). Planning fewer than you own keeps the owned ones beyond the new quantity under "Removed
 * but owned" (`retiredId`), so what you own stays counted.
 */
export function setExtraQty(
  plan: Plan,
  extraId: string,
  qty: number,
  options: RemoveExtraOptions = {},
): ExtraOpResult {
  const index = plan.extras.findIndex((extra) => extra.id === extraId)
  const extra = plan.extras[index]
  if (extra === undefined) return missing(plan, extraId)
  const count = wholeNumber(qty)
  if (count === undefined) return failed(plan, 'Enter a whole number.')
  if (count < 1) return failed(plan, 'Keep at least one, or remove the accessory instead.')
  if (count > MAX_EXTRA_QTY) return failed(plan, TOO_MANY)
  if (count === extra.qty) return { plan, conflicts: [], extraId }
  const excess = Math.max(0, extra.haveQty - count)
  const updated = { ...extra, qty: count, haveQty: extra.haveQty - excess }
  const next: Plan = { ...plan, extras: plan.extras.with(index, updated) }
  if (excess === 0) return { plan: next, conflicts: [], extraId }
  const kept = withRetiredExtras(next, extra, excess, options.at)
  return { plan: kept.plan, conflicts: [], extraId, retiredId: kept.retiredId }
}

/**
 * How many of the planned ones you own ("In my rack"), rounded down and clamped to 0..qty (a part
 * is owned only when it is complete). Lowering it means you do not have them: nothing is kept.
 */
export function setExtraHaveQty(plan: Plan, extraId: string, haveQty: number): ExtraOpResult {
  const index = plan.extras.findIndex((extra) => extra.id === extraId)
  const extra = plan.extras[index]
  if (extra === undefined) return missing(plan, extraId)
  const count = wholeNumber(haveQty)
  if (count === undefined) return failed(plan, 'Enter a whole number.')
  const owned = Math.min(extra.qty, Math.max(0, count))
  if (owned === extra.haveQty) return { plan, conflicts: [], extraId }
  return {
    plan: { ...plan, extras: plan.extras.with(index, { ...extra, haveQty: owned }) },
    conflicts: [],
    extraId,
  }
}

/**
 * Takes an accessory line out of the plan. The ones you own are kept under "Removed but owned"
 * (`retiredId`).
 */
export function removeExtra(
  plan: Plan,
  extraId: string,
  options: RemoveExtraOptions = {},
): ExtraOpResult {
  const extra = plan.extras.find((candidate) => candidate.id === extraId)
  if (extra === undefined) return missing(plan, extraId)
  const next: Plan = {
    ...plan,
    extras: plan.extras.filter((candidate) => candidate.id !== extraId),
  }
  if (extra.haveQty <= 0) return { plan: next, conflicts: [] }
  const kept = withRetiredExtras(next, extra, extra.haveQty, options.at)
  return { plan: kept.plan, conflicts: [], retiredId: kept.retiredId }
}

/**
 * Keeps `qty` owned accessories of `extra`'s kind under "Removed but owned": added to the entry
 * already holding that accessory (stamped with the latest time), else a new entry.
 */
function withRetiredExtras(
  plan: Plan,
  extra: PlanExtra,
  qty: number,
  at: string | undefined,
): { plan: Plan; retiredId: string } {
  const time = at ?? new Date().toISOString()
  const index = plan.retired.findIndex(
    (entry) =>
      entry.kind === 'extra' &&
      entry.snapshot.itemId === extra.itemId &&
      Object.keys(entry.snapshot.options).length === 0,
  )
  const existing = plan.retired[index]
  if (existing !== undefined) {
    const merged: RetiredEntry = {
      ...existing,
      qty: (existing.qty ?? 0) + qty,
      snapshot: { ...existing.snapshot, at: time },
    }
    return { plan: { ...plan, retired: plan.retired.with(index, merged) }, retiredId: existing.id }
  }
  const entry: RetiredEntry = {
    id: newId(ID_PREFIX.retired),
    kind: 'extra',
    snapshot: { at: time, itemId: extra.itemId, options: {} },
    sourceId: extra.id,
    qty,
  }
  return { plan: { ...plan, retired: [...plan.retired, entry] }, retiredId: entry.id }
}
