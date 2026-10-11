/** Rename and delete confirmations for the Plans page. Both name the plan they act on. */
import { CircleAlert, Trash2 } from 'lucide-react'
import { useId, useRef, useState, type FormEvent, type RefObject } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { errorMessage } from '@/db/errors'
import { deletePlan, renamePlan, type PlanSummary } from '@/db/plansRepo'
import { useUiStore } from '@/state/uiStore'
import { MAX_PLAN_NAME_LENGTH } from './wizardModel'

function quoted(name: string): string {
  return `“${name.trim() === '' ? 'Untitled plan' : name}”`
}

/** The plan to show: the current one, or the last one while the dialog animates closed. */
function useShownPlan(plan: PlanSummary | null): PlanSummary | null {
  const [last, setLast] = useState(plan)
  if (plan !== null && plan !== last) setLast(plan)
  return plan ?? last
}

function RenameForm({ plan, onDone }: { plan: PlanSummary; onDone: () => void }) {
  const [name, setName] = useState(plan.name)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputId = useId()
  const errorId = useId()

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed === '') {
      setError('Give the plan a name.')
      return
    }
    if (trimmed === plan.name) {
      onDone()
      return
    }
    setBusy(true)
    try {
      await renamePlan(plan.id, trimmed)
      toast.success(`Renamed to ${quoted(trimmed)}.`)
      onDone()
    } catch (caught) {
      setError(`Not renamed: ${errorMessage(caught)}`)
      setBusy(false)
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor={inputId}>Plan name</Label>
        <Input
          id={inputId}
          value={name}
          maxLength={MAX_PLAN_NAME_LENGTH}
          autoComplete="off"
          onChange={(event) => {
            setName(event.target.value)
            setError(null)
          }}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === null ? undefined : errorId}
        />
        {error === null ? null : (
          <p
            id={errorId}
            role="alert"
            className="flex items-start gap-1.5 text-sm text-destructive"
          >
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save name'}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** Renames a stored plan (an editor open on it in another tab then reports the change). */
export function RenamePlanDialog({
  plan,
  onClose,
}: {
  plan: PlanSummary | null
  onClose: () => void
}) {
  const shown = useShownPlan(plan)
  return (
    <Dialog open={plan !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {shown === null ? null : (
          <>
            <DialogHeader>
              <DialogTitle>Rename {quoted(shown.name)}</DialogTitle>
              <DialogDescription>Plan names can be up to 200 characters.</DialogDescription>
            </DialogHeader>
            <RenameForm key={shown.id} plan={shown} onDone={onClose} />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Asks before deleting; the plan is gone from this browser afterwards (no undo). */
export function DeletePlanDialog({
  plan,
  onClose,
  onDeleted,
  afterDelete,
}: {
  plan: PlanSummary | null
  onClose: () => void
  onDeleted: (plan: PlanSummary) => void
  /** Where focus goes after a delete: the menu that opened the dialog left with the card. */
  afterDelete: RefObject<HTMLElement | null>
}) {
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const deleted = useRef(false)
  const shown = useShownPlan(plan)

  async function confirm(target: PlanSummary): Promise<void> {
    setBusy(true)
    try {
      await deletePlan(target.id)
      deleted.current = true
      useUiStore.getState().setRecordingMode(target.id, false)
      toast.success(`Deleted ${quoted(target.name)}.`)
      onDeleted(target)
    } catch (error) {
      toast.error(`Could not delete ${quoted(target.name)}: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={plan !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Cancel first: the safe choice gets focus. */}
      <DialogContent
        initialFocus={cancelRef}
        finalFocus={() => {
          if (!deleted.current) return true
          deleted.current = false
          return afterDelete.current ?? true
        }}
      >
        {shown === null ? null : (
          <>
            <DialogHeader>
              <DialogTitle>Delete {quoted(shown.name)}?</DialogTitle>
              <DialogDescription>
                The plan is removed from this browser and cannot be brought back. Export it first if
                you might want it again.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose
                render={<Button ref={cancelRef} type="button" variant="outline" disabled={busy} />}
              >
                Cancel
              </DialogClose>
              <Button
                type="button"
                variant="destructive"
                disabled={busy || plan === null}
                onClick={() => {
                  if (plan !== null) void confirm(plan)
                }}
              >
                <Trash2 aria-hidden />
                {busy ? 'Deleting…' : 'Delete plan'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
