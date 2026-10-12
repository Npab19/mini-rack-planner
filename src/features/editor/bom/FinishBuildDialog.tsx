/**
 * "Finish build" confirmation: lists everything still To get (sections, top and bottom, mounts,
 * devices, equipment, extras) before it is all marked In my rack. The list is in the To get tone
 * and the confirm button in the In my rack one: that is the change it makes.
 */
import { PackageCheck, TriangleAlert } from 'lucide-react'
import { useId } from 'react'
import { NeedIcon } from '@/components/common/HaveNeed'
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
import { FINISH_BUILD_CLASSES, pendingCount, type PendingGroup } from './bomView'

export function FinishBuildDialog({
  open,
  onOpenChange,
  groups,
  unticked,
  busy,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: readonly PendingGroup[]
  /** Shopping lines not ticked as Got it. */
  unticked: number
  busy: boolean
  onConfirm: () => void
}) {
  const listId = useId()
  const count = pendingCount(groups)
  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md" data-testid="bom-finish-dialog">
        <DialogHeader>
          <DialogTitle>Finish build?</DialogTitle>
          <DialogDescription>
            {count === 0
              ? 'Everything in this plan is already in your rack.'
              : 'Finish build marks these as In my rack and uses up the parts on hand they need, such as those you ticked as Got it. You can undo it right after.'}
          </DialogDescription>
        </DialogHeader>
        {count === 0 ? null : (
          <div
            id={listId}
            role="region"
            aria-label={`Changes: ${count}`}
            tabIndex={0}
            className="grid max-h-[45vh] gap-3 overflow-y-auto rounded-lg border border-dashed border-need-border bg-need-soft p-3 dark:bg-need-soft/50 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {groups.map((group) => (
              <div key={group.id} className="grid gap-1">
                <p className="text-xs font-medium">
                  {group.title}{' '}
                  <span className="font-normal text-muted-foreground">({group.items.length})</span>
                </p>
                <ul className="grid gap-0.5 text-sm">
                  {group.items.map((item, index) => (
                    <li key={`${item.label}-${index}`} className="flex items-start gap-1.5">
                      <NeedIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-need" />
                      <span className="min-w-0 break-words">
                        {item.label}
                        {item.rebuilt ? (
                          <span className="text-muted-foreground"> (rebuilt as planned)</span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        {count > 0 && unticked > 0 ? (
          <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              {unticked === 1
                ? '1 line on the shopping list is not ticked as Got it.'
                : `${unticked} lines on the shopping list are not ticked as Got it.`}{' '}
              Finishing counts those parts as built anyway.
            </span>
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>
            {count === 0 ? 'Close' : 'Cancel'}
          </DialogClose>
          {count === 0 ? null : (
            <Button
              data-testid="bom-finish-confirm"
              className={FINISH_BUILD_CLASSES}
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={onConfirm}
            >
              <PackageCheck aria-hidden />
              {busy ? 'Finishing…' : 'Finish build'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
