/**
 * Values derived from the open plan, memoized per (plan, catalog, settings, inventory). Nothing
 * here is stored: the BOM and checks are recomputed from the plan whenever an input changes
 * (the plan's immer structural sharing keeps that cheap to detect).
 */
import { useMemo } from 'react'
import type { BomResult, Issue } from '@/domain/api'
import { computeBom } from '@/domain/bom'
import { runChecks } from '@/domain/checks'
import { placementHeightSixths } from '@/domain/frame'
import { formatU, sixthsToU, uToSixths } from '@/domain/geometry'
import { sectionHeightU } from '@/domain/recipe'
import { withCustomEntries, type CatalogLookup } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import type { Inventory, Settings } from '@/domain/schema/settings'
import { lookupForPlan, useCatalog } from './catalogStore'
import { useInventory } from './inventoryStore'
import { usePlanStore } from './planStore'
import { useSettings } from './settingsStore'

export interface PlanStats {
  /** Stack height (sum of the sections). */
  heightU: number
  /** Rack units taken by placements (any face or bay), within the stack. */
  usedU: number
  freeU: number
  /** The same in sixths (exact; format with `formatU`). */
  usedSixths: number
  freeSixths: number
  /** "3U + 6U · 9U": sections bottom -> top, then the total; "No sections" for an empty stack. */
  sectionSummary: string
  /**
   * Things marked Have / still to get: sections, placements, placed devices, unplaced equipment
   * and extras (an extra is Have once all of its quantity is owned).
   */
  haveCount: number
  needCount: number
}

/** Merged length of [start, end) intervals, clipped to [0, top). */
function coveredLength(intervals: Array<[number, number]>, top: number): number {
  const clipped = intervals
    .map(([start, end]): [number, number] => [Math.max(0, start), Math.min(top, end)])
    .filter(([start, end]) => end > start)
    .toSorted((a, b) => a[0] - b[0])
  let total = 0
  let runStart = 0
  let runEnd = -1
  for (const [start, end] of clipped) {
    if (start > runEnd) {
      if (runEnd > runStart) total += runEnd - runStart
      runStart = start
      runEnd = end
    } else {
      runEnd = Math.max(runEnd, end)
    }
  }
  if (runEnd > runStart) total += runEnd - runStart
  return total
}

/** "3U + 6U · 9U" from section heights bottom -> top; one section is just "6U". */
export function sectionSummaryText(heightsU: readonly number[]): string {
  const parts = heightsU.map((height) => formatU(uToSixths(height)))
  if (parts.length === 0) return 'No sections'
  if (parts.length === 1) return parts[0] ?? ''
  const totalU = heightsU.reduce((total, height) => total + height, 0)
  return `${parts.join(' + ')} · ${formatU(uToSixths(totalU))}`
}

export function planStats(plan: Plan, lookup: CatalogLookup): PlanStats {
  const catalog = withCustomEntries(lookup, plan.custom)
  const frame = catalog.frame(plan.frame.frameId)
  const heights = plan.frame.sections.map((section) => {
    const height = sectionHeightU(frame, section.typeId, section.heightU)
    // Unknown frame or type: what was built, when the section is in the user's rack.
    return height > 0 ? height : (section.have?.heightU ?? 0)
  })
  const heightU = heights.reduce((total, height) => total + height, 0)
  const topSixths = uToSixths(heightU)
  const usedSixths = coveredLength(
    plan.placements.map((placement) => [
      placement.y,
      placement.y + placementHeightSixths(placement, catalog),
    ]),
    topSixths,
  )
  const freeSixths = topSixths - usedSixths

  let haveCount = 0
  let needCount = 0
  const count = (owned: boolean): void => {
    if (owned) haveCount += 1
    else needCount += 1
  }
  for (const section of plan.frame.sections) count(section.have !== undefined)
  for (const placement of plan.placements) {
    count(placement.have !== undefined)
    for (const device of placement.devices) count(device.have)
  }
  for (const entry of plan.equipment) count(entry.have)
  for (const extra of plan.extras) if (extra.qty > 0) count(extra.haveQty >= extra.qty)

  return {
    heightU,
    usedU: sixthsToU(usedSixths),
    freeU: sixthsToU(freeSixths),
    usedSixths,
    freeSixths,
    sectionSummary: sectionSummaryText(heights),
    haveCount,
    needCount,
  }
}

/** The catalog lookup for the open plan (its own entries included); the base lookup without one. */
export function usePlanLookup(): CatalogLookup {
  const plan = usePlanStore((state) => state.plan)
  const { lookup } = useCatalog()
  return plan === null ? lookup : lookupForPlan(lookup, plan)
}

/**
 * The last result of `compute`, reused while its key stays the same (each part compared with
 * `Object.is`). Every component that shows the open plan's BOM or checks (the toolbar's summary
 * and its panel) asks separately, so an edit is computed once for all of them, not once each.
 */
function lastResult<A extends readonly unknown[], R>(
  keyOf: (...args: A) => readonly unknown[],
  compute: (...args: A) => R,
): (...args: A) => R {
  let last: { key: readonly unknown[]; result: R } | undefined
  return (...args: A): R => {
    const key = keyOf(...args)
    if (
      last !== undefined &&
      last.key.length === key.length &&
      last.key.every((part, index) => Object.is(part, key[index]))
    ) {
      return last.result
    }
    const result = compute(...args)
    last = { key, result }
    return result
  }
}

/**
 * Settings and the inventory by content: each component reads them through its own live query,
 * so equal values arrive as different objects. Both are small.
 */
function contentKey(value: Settings | Inventory): string {
  return JSON.stringify(value)
}

const sharedBom = lastResult(
  (plan: Plan, lookup: CatalogLookup, settings: Settings, inventory: Inventory) => [
    plan,
    lookup,
    contentKey(settings),
    contentKey(inventory),
  ],
  (plan, lookup, settings, inventory) =>
    computeBom(plan, lookupForPlan(lookup, plan), settings, inventory),
)

const sharedChecks = lastResult(
  (plan: Plan, lookup: CatalogLookup, settings: Settings) => [plan, lookup, contentKey(settings)],
  (plan, lookup, settings) => runChecks(plan, lookupForPlan(lookup, plan), settings),
)

/** BOM of the open plan against the global settings and inventory; undefined without a plan. */
export function useBom(): BomResult | undefined {
  const plan = usePlanStore((state) => state.plan)
  const { lookup } = useCatalog()
  const settings = useSettings()
  const inventory = useInventory()
  return useMemo(
    () => (plan === null ? undefined : sharedBom(plan, lookup, settings, inventory)),
    [plan, lookup, settings, inventory],
  )
}

const NO_ISSUES: Issue[] = []

/** Checks (errors, warnings, info) of the open plan; empty without a plan. */
export function useChecks(): Issue[] {
  const plan = usePlanStore((state) => state.plan)
  const { lookup } = useCatalog()
  const settings = useSettings()
  return useMemo(
    () => (plan === null ? NO_ISSUES : sharedChecks(plan, lookup, settings)),
    [plan, lookup, settings],
  )
}

export function usePlanStats(): PlanStats | undefined {
  const plan = usePlanStore((state) => state.plan)
  const { lookup } = useCatalog()
  return useMemo(() => (plan === null ? undefined : planStats(plan, lookup)), [plan, lookup])
}
