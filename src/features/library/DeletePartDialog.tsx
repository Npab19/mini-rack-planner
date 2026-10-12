/**
 * Asks before deleting one of your parts, and says which plans use it: those that carry their
 * own copy keep working, the others will show it as an unknown part.
 */
import { Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
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
import { deleteLibraryEntry } from '@/db/libraryRepo'
import { errorMessage } from '@/db/errors'
import type { CatalogEntry } from '@/domain/schema/catalog'
import { partName } from './libraryModel'
import { plansUsingPart, type PlanUse } from './planUsage'

type Usage = { partId: string; uses: PlanUse[] } | { partId: string; failed: true }

function UsageText({ usage, partId }: { usage: Usage | null; partId: string }) {
  if (usage === null || usage.partId !== partId) return <p>Checking your plans…</p>
  if ('failed' in usage) {
    return (
      <p>Your plans could not be checked. A plan that uses it may show it as an unknown part.</p>
    )
  }
  const { uses } = usage
  if (uses.length === 0) return <p>No saved plan uses it.</p>
  const without = uses.filter((use) => !use.ownCopy)
  return (
    <div className="grid gap-1.5">
      <p>{uses.length === 1 ? 'One plan uses it:' : `${uses.length} plans use it:`}</p>
      <ul className="list-disc pl-5">
        {uses.map((use) => (
          <li key={use.planId}>
            {use.name}
            <span className="text-muted-foreground">
              {use.ownCopy ? ' (keeps its own copy)' : ' (will show it as an unknown part)'}
            </span>
          </li>
        ))}
      </ul>
      {without.length === 0 ? <p>Those plans keep working with their own copy.</p> : null}
    </div>
  )
}

export function DeletePartDialog({
  part,
  onClose,
  afterDelete,
}: {
  part: CatalogEntry | null
  onClose: () => void
  /** Where focus goes after a delete: the card that had the menu is gone. */
  afterDelete: RefObject<HTMLElement | null>
}) {
  const [shown, setShown] = useState(part)
  if (part !== null && part !== shown) setShown(part)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const deleted = useRef(false)
  const partId = part?.id

  useEffect(() => {
    if (partId === undefined) return
    let cancelled = false
    plansUsingPart(partId).then(
      (uses) => {
        if (!cancelled) setUsage({ partId, uses })
      },
      () => {
        if (!cancelled) setUsage({ partId, failed: true })
      },
    )
    return () => {
      cancelled = true
    }
  }, [partId])

  async function confirm(target: CatalogEntry): Promise<void> {
    setBusy(true)
    try {
      await deleteLibraryEntry(target.id)
      deleted.current = true
      toast.success(`Deleted “${partName(target)}” from My parts.`)
      onClose()
    } catch (error) {
      toast.error(`Could not delete “${partName(target)}”: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={part !== null} onOpenChange={(open) => !open && onClose()}>
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
              <DialogTitle>Delete “{partName(shown)}”?</DialogTitle>
              <DialogDescription>
                It is removed from My parts in this browser and cannot be brought back. Export it
                first if you might want it again.
              </DialogDescription>
            </DialogHeader>
            <div role="status" aria-live="polite" className="text-sm">
              <UsageText usage={usage} partId={shown.id} />
            </div>
            <DialogFooter>
              <DialogClose
                render={<Button ref={cancelRef} type="button" variant="outline" disabled={busy} />}
              >
                Cancel
              </DialogClose>
              <Button
                type="button"
                variant="destructive"
                disabled={busy || part === null}
                onClick={() => {
                  if (part !== null) void confirm(part)
                }}
              >
                <Trash2 aria-hidden />
                {busy ? 'Deleting…' : 'Delete part'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
