/**
 * What the saved plans still need, for the On hand page: every readable plan (a live query over
 * the plans table, so it follows edits in other tabs) and each one's bill of materials against
 * the current catalog, settings and what is on hand. A BOM takes well under a millisecond, so
 * they are simply recomputed when one of those changes; reading the plans happens only when the
 * plans change.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo } from 'react'
import { listPlans } from '@/db/plansRepo'
import { computeBom } from '@/domain/bom'
import type { CatalogLookup } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import type { Inventory, Settings } from '@/domain/schema/settings'
import { lookupForPlan } from '@/state/catalogStore'
import { NO_PLAN_NEEDS, planNeedsFrom, type PlanNeeds } from './inventoryModel'

const NO_PLANS: Plan[] = []

async function readPlans(): Promise<Plan[]> {
  try {
    return (await listPlans()).map((loaded) => loaded.plan)
  } catch {
    // Storage unavailable: the page still works, without the plans' needs.
    return NO_PLANS
  }
}

/** Saved plans, most recently changed first; undefined while loading. */
export function useSavedPlans(): Plan[] | undefined {
  return useLiveQuery(readPlans, [], undefined)
}

export function planName(plan: Plan): string {
  return plan.name.trim() === '' ? 'Untitled plan' : plan.name
}

export function usePlanNeeds(
  plans: readonly Plan[] | undefined,
  lookup: CatalogLookup,
  settings: Settings,
  inventory: Inventory,
): PlanNeeds {
  return useMemo(() => {
    if (plans === undefined || plans.length === 0) return NO_PLAN_NEEDS
    return planNeedsFrom(
      plans.map((plan) => ({
        planId: plan.id,
        planName: planName(plan),
        bom: computeBom(plan, lookupForPlan(lookup, plan), settings, inventory),
      })),
    )
  }, [plans, lookup, settings, inventory])
}
