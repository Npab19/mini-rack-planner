/**
 * The Plans page list: plan summaries as a live query, so creating, renaming, deleting or
 * importing plans (in this tab or another one) updates it without a reload.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { errorMessage } from '@/db/errors'
import { listPlanSummaries, type PlanSummary } from '@/db/plansRepo'
import { useCatalog } from './catalogStore'

export interface PlanListView {
  /** Most recently changed first; undefined while loading. */
  plans: PlanSummary[] | undefined
  /** Why the plans could not be read (storage unavailable or blocked), else null. */
  error: string | null
}

const LOADING: PlanListView = { plans: undefined, error: null }

export function usePlanSummaries(): PlanListView {
  const { lookup } = useCatalog()
  return useLiveQuery(
    async (): Promise<PlanListView> => {
      try {
        return { plans: await listPlanSummaries(lookup), error: null }
      } catch (error) {
        // Shown on the page instead of crashing it through the error boundary.
        return { plans: [], error: errorMessage(error) }
      }
    },
    [lookup],
    LOADING,
  )
}
