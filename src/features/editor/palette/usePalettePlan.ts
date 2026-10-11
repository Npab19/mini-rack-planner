/**
 * What the palette needs from the open plan, subscribed narrowly: its catalog (with the plan's
 * own parts), its frame, and whether it can be edited or is being recorded. Unlike the whole plan,
 * none of these change while parts are placed or moved, so the palette does not re-render then.
 */
import { useMemo } from 'react'
import type { CatalogLookup, Frame } from '@/domain/schema/catalog'
import { lookupForPlan, useCatalog } from '@/state/catalogStore'
import { usePlanStore } from '@/state/planStore'
import { useRecordingMode } from '@/state/uiStore'

export interface PalettePlan {
  /** Bundled catalog + library + the plan's own entries. */
  lookup: CatalogLookup
  frameId: string
  frame: Frame | undefined
  readOnly: boolean
  recording: boolean
}

export function usePalettePlan(): PalettePlan | null {
  const planId = usePlanStore((state) => state.planId)
  const ready = usePlanStore((state) => state.status === 'ready' && state.plan !== null)
  // Immer keeps these references while other parts of the plan change.
  const custom = usePlanStore((state) => state.plan?.custom)
  const frameId = usePlanStore((state) => state.plan?.frame.frameId)
  const readOnly = usePlanStore((state) => state.readOnly)
  const recording = useRecordingMode(planId)
  const { lookup: base } = useCatalog()
  const lookup = useMemo(
    () => (custom === undefined ? base : lookupForPlan(base, { custom })),
    [base, custom],
  )
  return useMemo(() => {
    if (!ready || frameId === undefined) return null
    return { lookup, frameId, frame: lookup.frame(frameId), readOnly, recording }
  }, [ready, lookup, frameId, readOnly, recording])
}
