/**
 * Runs stack operations for the inspector and the rack's + handles: apply through the plan store
 * (one undo step), announce a success, and when the domain reports conflicts, show
 * `StackConflictDialog` and re-run with the policy the user picks. Render `dialog` once in the
 * panel. An error is returned to the caller, which shows it next to the control (`role="alert"`,
 * so it is not announced twice) or announces it.
 */
import { useRef, useState, type ReactNode } from 'react'
import { usePlanStore } from '@/state/planStore'
import { applyPlanOp, sparesText, type SpareContext } from './planOps'
import { isResolvable, type OpPolicy, type StackOpRequest } from './sectionOps'
import { StackConflictDialog, type PendingStackOp } from './StackConflictDialog'

export type StackOpOutcome =
  { status: 'applied' } | { status: 'conflicts' } | { status: 'error'; message: string }

export interface StackOps {
  run: (request: StackOpRequest) => StackOpOutcome
  dialog: ReactNode
}

export function useStackOps(announce: (text: string) => void, spares: SpareContext): StackOps {
  const [pending, setPending] = useState<PendingStackOp | null>(null)
  const nextId = useRef(0)

  function execute(request: StackOpRequest, policy: OpPolicy, fromDialog: boolean): StackOpOutcome {
    const before = usePlanStore.getState().plan
    const outcome = applyPlanOp((plan) => request.run(plan, policy), spares)
    if (outcome.applied) {
      setPending(null)
      const plan = usePlanStore.getState().plan
      if (plan !== null) {
        announce(`${request.done(plan)}${sparesText(outcome.sparesUsed)}`)
        if (before !== null) request.applied?.(before, plan)
      }
      return { status: 'applied' }
    }
    const { conflicts } = outcome
    const resolvable = conflicts.some(isResolvable)
    if (resolvable || (conflicts.length > 0 && request.inlineErrors !== true)) {
      nextId.current += 1
      setPending({ id: nextId.current, request, conflicts, policy })
      return { status: 'conflicts' }
    }
    const message = outcome.error ?? 'Nothing changed.'
    if (fromDialog) {
      setPending((current) => (current === null ? null : { ...current, error: message }))
    }
    return { status: 'error', message }
  }

  function apply(policy: OpPolicy): void {
    if (pending !== null) execute(pending.request, policy, true)
  }

  function cancel(): void {
    setPending(null)
    announce('Cancelled: nothing changed.')
  }

  return {
    run: (request) => execute(request, {}, false),
    dialog: <StackConflictDialog pending={pending} onApply={apply} onCancel={cancel} />,
  }
}
