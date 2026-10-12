import { CircleCheck, Clock, Download, TriangleAlert, Upload } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Button, buttonVariants } from '@/components/ui/button'
import { errorMessage } from '@/db/errors'
import { useBackupMeta } from '@/state/backupMeta'
import { describeExport, exportEverything } from './exportEverything'
import { BACKUP_NUDGE_AFTER_DAYS } from './backupNudgeRule'
import { daysSince, formatDate, formatDaysAgo } from './format'
import { SettingsSection } from './SettingsSection'

type ExportMessage = { kind: 'none' } | { kind: 'done' | 'cancelled' | 'error'; text: string }

function LastBackup({ at, loaded }: { at: string | undefined; loaded: boolean }) {
  if (!loaded) return <>Checking…</>
  if (at === undefined) return <>Never from this browser.</>
  const ago = formatDaysAgo(at)
  return (
    <>
      <time dateTime={at}>{formatDate(at)}</time>
      {ago === undefined ? null : ` (${ago})`}
    </>
  )
}

/**
 * The icon before "Last backup": a green check while it is recent, an amber clock once it is as
 * old as the Plans page reminder, an amber warning when there is none. The words say the same.
 */
function LastBackupIcon({ at, loaded }: { at: string | undefined; loaded: boolean }) {
  if (!loaded) return null
  const className = 'mt-0.5 size-4 shrink-0'
  if (at === undefined) {
    return <TriangleAlert aria-hidden="true" className={`${className} text-warning`} />
  }
  const days = daysSince(at)
  if (days !== undefined && days >= BACKUP_NUDGE_AFTER_DAYS) {
    return <Clock aria-hidden="true" className={`${className} text-warning`} />
  }
  return <CircleCheck aria-hidden="true" className={`${className} text-have`} />
}

/** Export everything to one JSON file, the way to import one, and when the last backup was. */
export function BackupSection() {
  const { meta, loaded } = useBackupMeta()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<ExportMessage>({ kind: 'none' })

  async function exportNow(): Promise<void> {
    if (busy) return
    setBusy(true)
    setMessage({ kind: 'none' })
    try {
      const result = await exportEverything()
      const kind = result.outcome === 'cancelled' ? 'cancelled' : 'done'
      setMessage({ kind, text: describeExport(result) })
    } catch (error) {
      setMessage({ kind: 'error', text: `Could not export a backup: ${errorMessage(error)}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      id="backup"
      title="Backup"
      description="Plans live only in this browser. A backup file keeps them safe and moves them to another browser or address."
    >
      <div className="flex items-start gap-1.5">
        <LastBackupIcon at={meta.lastBackupAt} loaded={loaded} />
        <p>
          <span className="font-medium">Last backup:</span>{' '}
          <LastBackup at={meta.lastBackupAt} loaded={loaded} />
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {/* Stays focusable while busy, so keyboard users keep their place. */}
        <Button
          type="button"
          disabled={busy}
          focusableWhenDisabled
          aria-busy={busy || undefined}
          onClick={() => void exportNow()}
        >
          <Download aria-hidden="true" />
          {busy ? 'Exporting…' : 'Export everything'}
        </Button>
        {/* Navigation stays a real link (Base UI's Button would give it role="button"). */}
        <Link to="/import" className={buttonVariants({ variant: 'outline' })}>
          <Upload aria-hidden="true" />
          Import a backup
        </Link>
      </div>
      {/* The result is announced from here only (no toast), so it is read once. While empty, the
          negative margin cancels its extra gap (display:none would silence the live region). */}
      <p role="status" className="flex items-start gap-1.5 text-sm empty:-mt-4">
        {message.kind === 'error' ? (
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
        ) : null}
        {message.kind === 'done' ? (
          <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-have" />
        ) : null}
        {message.kind === 'none' ? '' : message.text}
      </p>
      <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
        <li>
          The file holds every plan, your custom parts, these settings and what you have on hand.
        </li>
        <li>
          Model files (STL, 3MF) are never included: they are import-only. After restoring, drop the
          same files again and they relink to their parts automatically.
        </li>
      </ul>
    </SettingsSection>
  )
}
