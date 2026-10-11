/**
 * The open plan as the editor panels see it: the plan, its catalog lookup (the plan's own custom
 * entries included), its frame, and whether it can be edited or is being recorded. Null while no
 * plan is ready.
 */
import { useMemo } from 'react'
import type { CatalogLookup, Frame } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import { usePlanLookup } from '@/state/derived'
import { usePlanStore } from '@/state/planStore'
import { useRecordingMode } from '@/state/uiStore'

export interface OpenPlan {
  plan: Plan
  planId: string
  /** Bundled catalog + library + the plan's own entries. */
  lookup: CatalogLookup
  /** Undefined when the plan's frame is not in the catalog. */
  frame: Frame | undefined
  /** Made by a newer app version: shown, never edited. */
  readOnly: boolean
  /** "Recording what you have": new things are marked In my rack. */
  recording: boolean
}

export function useOpenPlan(): OpenPlan | null {
  const plan = usePlanStore((state) => state.plan)
  const planId = usePlanStore((state) => state.planId)
  const status = usePlanStore((state) => state.status)
  const readOnly = usePlanStore((state) => state.readOnly)
  const lookup = usePlanLookup()
  const recording = useRecordingMode(planId)
  return useMemo(() => {
    if (plan === null || planId === null || status !== 'ready') return null
    return {
      plan,
      planId,
      lookup,
      frame: lookup.frame(plan.frame.frameId),
      readOnly,
      recording,
    }
  }, [plan, planId, status, lookup, readOnly, recording])
}
