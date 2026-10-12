/**
 * Which saved plans use a part of yours, before it is deleted. A plan that carries its own copy
 * (`plan.custom`, embedded when it was added from the editor or exported) keeps working; others
 * then show it as an unknown part. Reads every stored plan once; unreadable plans are skipped.
 */
import { getPlan, listPlanSummaries } from '@/db/plansRepo'
import { customIdsUsed } from '@/domain/customParts'
import type { Plan } from '@/domain/schema/plan'

export interface PlanUse {
  planId: string
  name: string
  /** The plan carries its own copy of the part. */
  ownCopy: boolean
}

function carries(plan: Plan, partId: string): boolean {
  const { frames, items, devices, hardware } = plan.custom
  return [...frames, ...items, ...devices, ...hardware].some((entry) => entry.id === partId)
}

export async function plansUsingPart(partId: string): Promise<PlanUse[]> {
  const uses: PlanUse[] = []
  for (const summary of await listPlanSummaries()) {
    let plan: Plan
    try {
      plan = (await getPlan(summary.id)).plan
    } catch {
      continue
    }
    if (!customIdsUsed(plan).has(partId)) continue
    const name = summary.name.trim() === '' ? 'Untitled plan' : summary.name
    uses.push({ planId: summary.id, name, ownCopy: carries(plan, partId) })
  }
  return uses
}
