import { Download, TriangleAlert, Upload } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Button, buttonVariants } from '@/components/ui/button'
import { errorMessage } from '@/db/errors'
import { useBackupMeta } from '@/state/backupMeta'
import { describeExport, exportEverything } from './exportEverything'
import { formatDate, formatDaysAgo } from './format'
import { SettingsSection } from './SettingsSection'

type ExportMessage = { kind: 'none' } | { kind: 'done' | 'error'; text: string }

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
      setMessage({ kind: 'done', text: describeExport(await exportEverything()) })
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
      <p>
        <span className="font-medium">Last backup:</span>{' '}
        <LastBackup at={meta.lastBackupAt} loaded={loaded} />
      </p>
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
        {message.kind === 'none' ? '' : message.text}
      </p>
      <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
        <li>
          The file holds every plan, your custom parts, these settings and your spare-parts
          inventory.
        </li>
        <li>
          Model files (STL, 3MF) are never included: they are import-only. After restoring, drop the
          same files again and they relink to their parts automatically.
        </li>
      </ul>
    </SettingsSection>
  )
}
