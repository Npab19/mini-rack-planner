/**
 * Asks before a removed part leaves the plan for good:
 * - Keep as spare lists the parts that go into the spares (the inventory every plan shares);
 * - Discard says it stops counting as yours (sold, given away, broken).
 * The host runs the action; after it, focus goes to `focusAfter` (the part's row is gone).
 */
import { PackagePlus, Trash2 } from 'lucide-react'
import { useId } from 'react'
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
import type { RetiredSpare, RetiredView } from '@/domain/retired'
import { spareText } from './retiredText'

export interface RetiredConfirmRequest {
  action: 'keep' | 'discard'
  view: RetiredView
  /** Keep as spare: what goes into the spares. */
  spares: readonly RetiredSpare[]
}

export interface RetiredConfirmDialogProps {
  request: RetiredConfirmRequest | null
  onConfirm: (request: RetiredConfirmRequest) => void
  onCancel: () => void
  /** Where focus goes when the dialog closes after the action ran; null keeps the default. */
  focusAfter: () => HTMLElement | null
}

export function RetiredConfirmDialog({
  request,
  onConfirm,
  onCancel,
  focusAfter,
}: RetiredConfirmDialogProps) {
  const listId = useId()
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      {request === null ? null : (
        <DialogContent
          className="sm:max-w-md"
          data-testid={`retired-${request.action}-dialog`}
          finalFocus={() => focusAfter() ?? true}
        >
          <DialogHeader>
            <DialogTitle>
              {request.action === 'keep'
                ? `Keep ${request.view.name} as spare?`
                : `Discard ${request.view.name}?`}
            </DialogTitle>
            <DialogDescription>
              {request.action === 'keep'
                ? 'It leaves this plan, and its parts go into your spares, which every plan can use before anything is bought.'
                : 'Use this when you no longer have it: sold, given away or broken. It leaves this plan, and the bill of materials stops counting it as yours. Undo brings it back.'}
            </DialogDescription>
          </DialogHeader>
          {request.action !== 'keep' ? null : request.spares.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing in it counts as a spare part (for example, it is not in your catalog any
              more).
            </p>
          ) : (
            <div className="grid gap-1">
              <p id={listId} className="text-xs font-medium">
                Goes into your spares
              </p>
              <ul
                aria-labelledby={listId}
                className="grid max-h-[40vh] gap-0.5 overflow-y-auto rounded-lg border p-2 text-sm"
              >
                {request.spares.map((spare) => (
                  <li key={spare.key} className="break-words">
                    {spareText(spare)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            {request.action === 'keep' ? (
              <Button data-testid="retired-keep-confirm" onClick={() => onConfirm(request)}>
                <PackagePlus aria-hidden />
                Keep as spare
              </Button>
            ) : (
              <Button
                variant="destructive"
                data-testid="retired-discard-confirm"
                onClick={() => onConfirm(request)}
              >
                <Trash2 aria-hidden />
                Discard
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
