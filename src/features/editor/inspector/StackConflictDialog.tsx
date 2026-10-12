/**
 * Explains why a stack operation was blocked and offers the domain's policies for it:
 * - straddle (a part across a joint that changes): move it with the lower or the upper section;
 * - section not empty: delete those parts or keep them where they are (Remove and Retire can only
 *   take them along);
 * - anything else (sections you have, height limits): the explanation, and Close.
 * Apply re-runs the operation with the chosen policy; Cancel changes nothing.
 */
import { TriangleAlert } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { StackConflict } from '@/domain/api'
import { isResolvable, type OpPolicy, type StackOpRequest } from './sectionOps'

export interface PendingStackOp {
  /** Changes on every blocked run, so the dialog starts from the policy it carries. */
  id: number
  request: StackOpRequest
  conflicts: StackConflict[]
  /** The policy the blocked run used (earlier choices stay chosen). */
  policy: OpPolicy
  /** A re-run from the dialog failed for a reason no policy resolves. */
  error?: string
}

export interface StackConflictDialogProps {
  pending: PendingStackOp | null
  onApply: (policy: OpPolicy) => void
  onCancel: () => void
}

type StraddleChoice = 'lower' | 'upper'
type OrphanChoice = 'keep' | 'delete'

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

function Choice({ value, label, hint }: { value: string; label: string; hint: string }) {
  const labelId = useId()
  const hintId = useId()
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 hover:bg-muted/50 has-data-checked:border-primary has-data-checked:bg-accent">
      <RadioGroupItem
        value={value}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        className="mt-0.5"
      />
      <span className="grid gap-0.5">
        <span id={labelId} className="text-sm font-medium">
          {label}
        </span>
        <span id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </span>
      </span>
    </label>
  )
}

function ConflictBody({
  pending,
  onApply,
  onCancel,
}: StackConflictDialogProps & { pending: PendingStackOp }) {
  const straddleId = useId()
  const orphanId = useId()
  const kinds = new Set(pending.conflicts.map((conflict) => conflict.kind))
  const straddle = kinds.has('straddle')
  const notEmpty = kinds.has('section-not-empty')
  const canKeep = pending.request.notEmpty === 'remap'
  const resolvable = pending.conflicts.some(isResolvable)
  const [straddleChoice, setStraddleChoice] = useState<StraddleChoice>(
    pending.policy.straddle ?? 'lower',
  )
  const [orphanChoice, setOrphanChoice] = useState<OrphanChoice>(
    pending.policy.orphans ?? (canKeep ? 'keep' : 'delete'),
  )
  const title = lowerFirst(pending.request.title)

  function apply(): void {
    const policy: OpPolicy = { ...pending.policy }
    if (straddle) policy.straddle = straddleChoice
    if (notEmpty) {
      if (canKeep) policy.orphans = orphanChoice
      else policy.removePlacements = true
    }
    onApply(policy)
  }

  return (
    <DialogContent className="sm:max-w-md" data-testid="stack-conflict-dialog">
      <DialogHeader>
        <DialogTitle>{resolvable ? `Before you ${title}` : `You can’t ${title}`}</DialogTitle>
        <DialogDescription>
          {resolvable
            ? 'Some parts on the rack are in the way. Choose what happens to them, or cancel to leave the rack as it is.'
            : 'Nothing was changed.'}
        </DialogDescription>
      </DialogHeader>

      <ul className="grid gap-1.5">
        {pending.conflicts.map((conflict, index) => (
          <li key={`${conflict.kind}-${index}`} className="flex items-start gap-2 text-sm">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>{conflict.message}</span>
          </li>
        ))}
      </ul>

      {straddle ? (
        <div className="grid gap-2">
          <p id={straddleId} className="text-sm font-medium">
            Parts across a joint that moves
          </p>
          <RadioGroup
            value={straddleChoice}
            onValueChange={(value) => setStraddleChoice(value === 'upper' ? 'upper' : 'lower')}
            aria-labelledby={straddleId}
          >
            <Choice
              value="lower"
              label="Move them with the lower section"
              hint="They stay on the section their bottom edge is screwed to."
            />
            <Choice
              value="upper"
              label="Move them with the upper section"
              hint="They follow the section their top edge is screwed to."
            />
          </RadioGroup>
        </div>
      ) : null}

      {notEmpty ? (
        canKeep ? (
          <div className="grid gap-2">
            <p id={orphanId} className="text-sm font-medium">
              Parts on a section that goes away
            </p>
            <RadioGroup
              value={orphanChoice}
              onValueChange={(value) => setOrphanChoice(value === 'delete' ? 'delete' : 'keep')}
              aria-labelledby={orphanId}
            >
              <Choice
                value="keep"
                label="Keep them where they are"
                hint="The checks point out anything that ends up outside the rack."
              />
              <Choice
                value="delete"
                label="Delete those parts"
                hint="Parts you own are kept as retired; planned devices go back to Equipment to fit."
              />
            </RadioGroup>
          </div>
        ) : (
          <p className="text-sm">
            What is mounted on it goes too: parts you own are kept as retired, and planned devices
            go back to Equipment to fit.
          </p>
        )
      ) : null}

      {pending.error === undefined ? null : (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {pending.error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {resolvable ? 'Cancel' : 'Close'}
        </Button>
        {resolvable ? (
          <Button type="button" onClick={apply}>
            {notEmpty && !canKeep ? 'Remove them too' : 'Apply'}
          </Button>
        ) : null}
      </DialogFooter>
    </DialogContent>
  )
}

export function StackConflictDialog({ pending, onApply, onCancel }: StackConflictDialogProps) {
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      {pending === null ? null : (
        <ConflictBody key={pending.id} pending={pending} onApply={onApply} onCancel={onCancel} />
      )}
    </Dialog>
  )
}
