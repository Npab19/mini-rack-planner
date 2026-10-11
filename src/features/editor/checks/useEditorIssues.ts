/**
 * Every issue the Checks panel lists: the plan's checks and the stack's own validation, each once.
 * The toolbar's Checks summary reads the same list, so its badge and the panel never disagree, and
 * both share one computation per edit (the last result is kept for the same inputs).
 */
import { useMemo } from 'react'
import type { Issue } from '@/domain/api'
import { validateStack } from '@/domain/frame'
import type { CatalogLookup } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import { useChecks, usePlanLookup } from '@/state/derived'
import { usePlanStore } from '@/state/planStore'
import { mergeIssues } from './checksView'

interface Computed {
  checks: readonly Issue[]
  plan: Plan | null
  lookup: CatalogLookup
  issues: readonly Issue[]
}

let last: Computed | undefined

/** The checks plus the stack's validation for this plan (the checks alone without its frame). */
export function editorIssues(
  checks: readonly Issue[],
  plan: Plan | null,
  lookup: CatalogLookup,
): readonly Issue[] {
  if (
    last !== undefined &&
    last.checks === checks &&
    last.plan === plan &&
    last.lookup === lookup
  ) {
    return last.issues
  }
  const frame = plan === null ? undefined : lookup.frame(plan.frame.frameId)
  const issues =
    plan === null || frame === undefined ? checks : mergeIssues(checks, validateStack(plan, frame))
  last = { checks, plan, lookup, issues }
  return issues
}

export function useEditorIssues(): readonly Issue[] {
  const checks = useChecks()
  const plan = usePlanStore((state) => state.plan)
  const lookup = usePlanLookup()
  return useMemo(() => editorIssues(checks, plan, lookup), [checks, plan, lookup])
}
