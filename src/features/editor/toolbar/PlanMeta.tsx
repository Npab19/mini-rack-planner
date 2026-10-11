import { usePlanLookup, usePlanStats } from '@/state/derived'
import { usePlanStore } from '@/state/planStore'

/** "KWS Rack v2 · 3U + 6U + 3U · 12U" under the plan name. */
export function PlanMeta() {
  const lookup = usePlanLookup()
  const stats = usePlanStats()
  const frameId = usePlanStore((state) => state.plan?.frame.frameId)
  if (frameId === undefined) return null
  const frameName = lookup.frame(frameId)?.name ?? frameId
  return (
    <p className="truncate text-xs text-muted-foreground">
      {frameName}
      {stats === undefined ? null : ` · ${stats.sectionSummary}`}
    </p>
  )
}
