/**
 * Running plan operations from the editor panels. Every change goes through the plan store's
 * `applyOp`, so it is one undo step and autosaved. When an operation builds something (Mark as
 * Have, a new owned section in Recording mode), the loose spares it installs come out of the
 * inventory in the same action, as build.ts asks of its callers (`consumeInventory`, bom.ts).
 *
 * The inventory is global (not part of the plan), so undo does not put those spares back.
 */
import { useMemo } from 'react'
import type { StackConflict } from '@/domain/api'
import { computeBom, consumeInventory } from '@/domain/bom'
import type { CatalogLookup } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import type { Inventory, Settings } from '@/domain/schema/settings'
import { lookupForPlan, useCatalog } from '@/state/catalogStore'
import { adjustInventory, useInventory } from '@/state/inventoryStore'
import { usePlanStore, type PlanOp } from '@/state/planStore'
import { useSettings } from '@/state/settingsStore'

export interface SpareContext {
  /** The shared catalog (bundled + library); each plan's own entries are layered on top. */
  lookup: CatalogLookup
  settings: Settings
  inventory: Inventory
}

export interface PlanOpOutcome {
  /** The plan was replaced (one undo step). */
  applied: boolean
  conflicts: StackConflict[]
  error?: string
  /** Loose spares taken out of the inventory, summed over lines. */
  sparesUsed: number
}

function hasSpares(inventory: Inventory): boolean {
  return Object.values(inventory).some((qty) => qty > 0)
}

/** Per inventory key: how many loose spares `after` installs that `before` did not. */
export function sparesUsedBy(
  before: Plan,
  after: Plan,
  context: SpareContext,
): Record<string, number> {
  const { inventory, settings } = context
  if (before === after || !hasSpares(inventory)) return {}
  const bomBefore = computeBom(before, lookupForPlan(context.lookup, before), settings, inventory)
  const bomAfter = computeBom(after, lookupForPlan(context.lookup, after), settings, inventory)
  const remaining = consumeInventory(bomBefore, bomAfter, inventory)
  const used: Record<string, number> = {}
  for (const [key, qty] of Object.entries(inventory)) {
    const taken = qty - (remaining[key] ?? 0)
    if (taken > 0) used[key] = taken
  }
  return used
}

/**
 * Applies `op` to the open plan. Conflicts and errors leave the plan untouched; a change also
 * consumes the inventory spares it installs.
 */
export function applyPlanOp(op: PlanOp, spares: SpareContext): PlanOpOutcome {
  const before = usePlanStore.getState().plan
  const result = usePlanStore.getState().applyOp(op)
  const after = usePlanStore.getState().plan
  if (!result.applied || before === null || after === null) return { ...result, sparesUsed: 0 }
  let sparesUsed = 0
  for (const [key, qty] of Object.entries(sparesUsedBy(before, after, spares))) {
    sparesUsed += qty
    // A failed write is reported by the inventory store (status banner).
    adjustInventory(key, -qty).catch(() => undefined)
  }
  return { ...result, sparesUsed }
}

/** What `applyPlanOp` needs to consume spares, from the live settings and inventory. */
export function useSpareContext(): SpareContext {
  const { lookup } = useCatalog()
  const settings = useSettings()
  const inventory = useInventory()
  return useMemo(() => ({ lookup, settings, inventory }), [lookup, settings, inventory])
}

/** " Used 16 loose spares from your inventory." (leading space), or "" when none were used. */
export function sparesText(count: number): string {
  if (count <= 0) return ''
  return ` Used ${count} loose ${count === 1 ? 'spare' : 'spares'} from your inventory.`
}

/** Capture time for Have snapshots and retired entries. */
export function nowIso(): string {
  return new Date().toISOString()
}
