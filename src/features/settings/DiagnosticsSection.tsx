import { Check, ClipboardCopy, Eraser, ExternalLink } from 'lucide-react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button, buttonVariants } from '@/components/ui/button'
import { copyText } from '@/lib/clipboard'
import * as diagnostics from '@/lib/diagnostics'
import { formatDateTime, plural } from './format'
import { ManualCopyDialog } from './ManualCopyDialog'
import { SettingsSection } from './SettingsSection'

const VERSION = `${__APP_VERSION__} (${__GIT_SHA__})`
/** How long the button says "Copied" before offering to copy again. */
const COPIED_RESET_MS = 4000

type CopyState = 'idle' | 'working' | 'copied'

/** The recorded problems; re-renders when one is recorded or they are cleared. */
function useDiagnosticEntries(): readonly diagnostics.DiagnosticEntry[] {
  return useSyncExternalStore(diagnostics.subscribe, diagnostics.getEntries, diagnostics.getEntries)
}

interface PreparedReport {
  /** The report for exactly these entries; undefined while it is being rebuilt. */
  current: string | undefined
  /** The newest report there is, possibly a moment behind the entries. */
  latest: string | undefined
}

/**
 * The redacted report, prepared ahead of the click: the clipboard write and the issue link then
 * happen inside the click itself (Safari refuses clipboard writes after an await), and the link is
 * a plain link that works with middle-click and without pop-up permissions.
 */
function useReport(entries: readonly diagnostics.DiagnosticEntry[]): PreparedReport {
  const [built, setBuilt] = useState<{
    entries: readonly diagnostics.DiagnosticEntry[]
    text: string
  }>()
  useEffect(() => {
    let active = true
    void diagnostics.collectReport({ entries }).then((text) => {
      if (active) setBuilt({ entries, text })
    })
    return () => {
      active = false
    }
  }, [entries])
  return { current: built?.entries === entries ? built.text : undefined, latest: built?.text }
}

/** Recorded problems, Copy diagnostics, Report a problem (prefilled GitHub issue) and Clear. */
export function DiagnosticsSection() {
  const entries = useDiagnosticEntries()
  const report = useReport(entries)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [manualText, setManualText] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const latest = entries.at(-1)
  const issueUrl = useMemo(
    () => diagnostics.reportIssueUrl(report.latest ?? '', { version: VERSION }),
    [report.latest],
  )

  useEffect(() => {
    if (copyState !== 'copied') return
    const timer = setTimeout(() => setCopyState('idle'), COPIED_RESET_MS)
    return () => clearTimeout(timer)
  }, [copyState])

  async function copyDiagnostics(): Promise<void> {
    if (copyState === 'working') return
    setCopyState('working')
    setAnnouncement('')
    const text = report.current ?? (await diagnostics.collectReport({ entries }))
    if (await copyText(text)) {
      setCopyState('copied')
      setAnnouncement('Diagnostics copied to the clipboard.')
    } else {
      setCopyState('idle')
      setManualText(text)
    }
  }

  async function clearProblems(): Promise<void> {
    await diagnostics.clear()
    setAnnouncement('Recorded problems cleared.')
  }

  return (
    <SettingsSection
      id="diagnostics"
      title="Diagnostics"
      description="Recent errors in this browser, to help fix problems you report. They never include plan contents, names, notes or file names."
    >
      <p>
        {latest === undefined
          ? 'No problems recorded.'
          : `${plural(entries.length, 'problem')} recorded, the latest on ${formatDateTime(latest.at)}.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          aria-busy={copyState === 'working' || undefined}
          onClick={() => void copyDiagnostics()}
        >
          {copyState === 'copied' ? (
            <Check aria-hidden="true" />
          ) : (
            <ClipboardCopy aria-hidden="true" />
          )}
          {copyState === 'copied' ? 'Copied' : 'Copy diagnostics'}
        </Button>
        <a
          href={issueUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: 'outline' })}
        >
          <ExternalLink aria-hidden="true" />
          Report a problem <span className="sr-only">(opens GitHub in a new tab)</span>
        </a>
        {/* Stays focusable when disabled, so clearing does not drop keyboard focus. */}
        <Button
          type="button"
          variant="ghost"
          disabled={entries.length === 0}
          focusableWhenDisabled
          onClick={() => void clearProblems()}
        >
          <Eraser aria-hidden="true" />
          Clear
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Report a problem opens a new GitHub issue with the diagnostics filled in. Nothing is sent
        until you submit it there, and you can edit it first.
      </p>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <ManualCopyDialog
        text={manualText}
        title="Copy the diagnostics"
        label="Diagnostics report"
        onClose={() => setManualText(null)}
      />
    </SettingsSection>
  )
}
