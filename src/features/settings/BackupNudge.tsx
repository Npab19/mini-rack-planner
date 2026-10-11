import { DatabaseBackup, Download } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { dismissBackupNudge } from '@/db/backupMetaRepo'
import { errorMessage } from '@/db/errors'
import { cn } from '@/lib/utils'
import { useBackupMeta } from '@/state/backupMeta'
import { shouldShowBackupNudge } from './backupNudgeRule'
import { describeExport, exportEverything } from './exportEverything'
import { formatDaysAgo } from './format'

export interface BackupNudgeProps {
  /**
   * The saved plans, e.g. `usePlanSummaries().plans` (undefined while loading). Only `updatedAt`
   * is read: the nudge needs at least one plan and stays away while the last backup is current.
   */
  plans: readonly { updatedAt: string }[] | undefined
  className?: string
}

/**
 * A notice moves away with focus in it: hand focus to the page's main region instead of letting
 * it fall back to <body> (the same rule as the status banners).
 */
function focusMain(): void {
  const main = document.querySelector('main')
  if (!(main instanceof HTMLElement)) return
  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1')
  main.focus({ preventScroll: true })
}

/**
 * "Plans live only in this browser. Export a backup now?" for the Plans page: shown while there
 * is at least one plan and no backup from the last 14 days (or ever) that holds the latest plan
 * changes, unless put off with Later within the last 14 days. See `shouldShowBackupNudge`.
 *
 *   const { plans } = usePlanSummaries()
 *   <BackupNudge plans={plans} />
 */
export function BackupNudge({ plans, className }: BackupNudgeProps) {
  const { meta, loaded } = useBackupMeta()
  // Read once per mount: the rule works in days, a page left open does not need a clock.
  const [now] = useState(() => Date.now())
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)

  if (hidden || !loaded || plans === undefined) return null
  if (!shouldShowBackupNudge({ plans, meta, now })) return null

  async function exportNow(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const result = await exportEverything()
      if (result.outcome === 'cancelled') return
      toast.success(describeExport(result))
      setHidden(true)
      focusMain()
    } catch (error) {
      toast.error(`Could not export a backup: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  function later(): void {
    setHidden(true)
    focusMain()
    // Remembered across reloads; if storage refuses, it is at least gone for this visit.
    void dismissBackupNudge().catch(() => undefined)
  }

  const ago = meta.lastBackupAt === undefined ? undefined : formatDaysAgo(meta.lastBackupAt)
  return (
    <section
      aria-label="Backup reminder"
      className={cn(
        'flex flex-col gap-3 rounded-xl bg-card p-3 text-sm text-card-foreground ring-1 ring-foreground/10 sm:flex-row sm:items-center',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <DatabaseBackup
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="font-medium">Plans live only in this browser. Export a backup now?</p>
          <p className="text-muted-foreground">
            {ago === undefined
              ? 'There is no backup from this browser yet.'
              : `The last backup was ${ago}, and plans have changed since.`}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2 pl-6.5 sm:pl-0">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          focusableWhenDisabled
          aria-busy={busy || undefined}
          onClick={() => void exportNow()}
        >
          <Download aria-hidden="true" />
          {busy ? 'Exporting…' : 'Export'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={later}>
          Later
        </Button>
      </div>
    </section>
  )
}
