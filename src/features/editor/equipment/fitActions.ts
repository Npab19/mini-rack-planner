/**
 * "Fit it for me" against the open plan: one `applyOp` (one undo step) running `fitItForMe`. In
 * Recording mode, what it builds is marked In my rack in the same step, like every other way of
 * adding things there: the new sections (and both caps when none was recorded yet, as
 * `markSectionContents` does) and the new mounts; the devices keep their own In my rack / To get.
 * Loose spares it installs come out of the inventory, as for any build.
 */
import { markCap, markPlacement } from '@/domain/build'
import { fitItForMe, type FitItForMeResult } from '@/domain/fit'
import { markSection, type StackEnd } from '@/domain/frame'
import type { CatalogLookup, Frame } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import { usePlanStore } from '@/state/planStore'
import { isRecording } from '@/state/uiStore'
import { applyPlanOp, nowIso, sparesText, type SpareContext } from '../inspector/planOps'
import { fitReport, type FitReport } from './equipmentView'

export interface FitOutcome {
  /** The plan changed (one undo step). */
  applied: boolean
  /** What it did, for the tray and the live region. */
  report: FitReport
  /** The new placements, in tray order (to select them). */
  placementIds: string[]
  /** The open plan right after the fit (the tray shows the report while it is unchanged). */
  plan: Plan | null
  /** Why it could not run at all. */
  error?: string
}

/** Marks what the fit built as In my rack: new sections (caps too if none were), new mounts. */
export function markFitBuilt(
  before: Plan,
  result: FitItForMeResult,
  frame: Frame,
  at: string,
  catalog: CatalogLookup,
): Plan {
  const existing = new Set(before.frame.sections.map((section) => section.id))
  let next = result.plan
  let sectionsMarked = false
  for (const section of result.plan.frame.sections) {
    if (existing.has(section.id)) continue
    const marked = markSection(next, section.id, true, at, frame)
    if (marked.error !== undefined) continue
    next = marked.plan
    sectionsMarked = true
  }
  const { top, bottom } = next.frame.caps
  if (sectionsMarked && top.have === undefined && bottom.have === undefined) {
    next = markCap(markCap(next, frame, 'top', true, at), frame, 'bottom', true, at)
  }
  for (const { placementId } of result.placed) {
    next = markPlacement(next, placementId, true, at, catalog)
  }
  return next
}

function failed(error: string): FitOutcome {
  return {
    applied: false,
    report: { placed: 0, headline: error, leftOver: [], announcement: error },
    placementIds: [],
    plan: usePlanStore.getState().plan,
    error,
  }
}

/** Runs "Fit it for me" on the open plan, new sections going at `at`. */
export function runFitItForMe(
  catalog: CatalogLookup,
  at: StackEnd,
  spares?: SpareContext,
): FitOutcome {
  const state = usePlanStore.getState()
  const before = state.plan
  if (before === null) return failed('No plan is open.')
  if (state.readOnly) return failed('This plan is read-only: it was made with a newer version.')
  const frame = catalog.frame(before.frame.frameId)
  if (frame === undefined) {
    return failed(`The frame "${before.frame.frameId}" is not in the catalog.`)
  }
  const recording = isRecording(state.planId)
  const stamp = nowIso()
  const ran: { fit?: FitItForMeResult } = {}
  const op = (current: Plan): FitItForMeResult => {
    const fitted = fitItForMe(current, catalog, frame, at, stamp)
    ran.fit = fitted
    if (!recording || fitted.plan === current) return fitted
    return { ...fitted, plan: markFitBuilt(current, fitted, frame, stamp, catalog) }
  }
  const result =
    spares === undefined ? { ...state.applyOp(op), sparesUsed: 0 } : applyPlanOp(op, spares)
  const fit = ran.fit
  if (fit === undefined || !result.applied) {
    return failed(result.error ?? 'Nothing changed.')
  }
  const report = fitReport(fit, before, catalog, at, recording)
  const spareText = sparesText(result.sparesUsed)
  const after = usePlanStore.getState().plan
  return {
    applied: after !== before,
    report: {
      ...report,
      headline: `${report.headline}${spareText}`,
      announcement: `${report.announcement}${spareText}`,
    },
    placementIds: fit.placed.map((entry) => entry.placementId),
    plan: after,
  }
}
