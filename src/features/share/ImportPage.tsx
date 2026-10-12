/**
 * Import (/import): pick or drop a backup or a single plan file, see what it holds, choose how to
 * bring it in (merge, copy or replace) and import it. Files are read in this browser; nothing is
 * uploaded. Share links (#p=…) belong to the read-only viewer, which comes in v0.2.
 */
import { CircleAlert, CircleCheck, FileUp, Info, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useRef, useState, type DragEvent } from 'react'
import { Link, useLocation } from 'react-router'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { importBackup, readBackupFile, type ImportMode, type ImportResult } from '@/db/backup'
import { BackupFormatError, errorMessage } from '@/db/errors'
import { listPlanSummaries } from '@/db/plansRepo'
import { formatDateTime, plural } from '@/features/plans/format'
import { cn } from '@/lib/utils'
import {
  canReplace,
  importablePlans,
  previewImport,
  type ImportPreview,
  type PreviewPlan,
} from './import/importPreview'

/** What the user types to confirm Replace. */
const REPLACE_WORD = 'REPLACE'
/** Plans listed in the preview before "and N more". */
const PREVIEW_LIMIT = 8

interface PickedFile {
  name: string
  json: unknown
  preview: ImportPreview
  /** Ids of the plans already in this browser. */
  existing: ReadonlySet<string>
}

interface Problem {
  message: string
  details: readonly string[]
}

interface Imported {
  fileName: string
  result: ImportResult
  /** Plan id -> name, read after the import. */
  names: ReadonlyMap<string, string>
}

const MODE_TEXT: Record<ImportMode, { title: string; description: string }> = {
  merge: {
    title: 'Merge (recommended)',
    description:
      'Adds the plans that are new here and updates those the file has a newer copy of. Your other plans stay. Settings and inventory in the file are applied.',
  },
  copy: {
    title: 'Copy',
    description:
      'Adds every plan as a new plan with “In my rack” cleared, so nothing here is overwritten. Settings and inventory are not imported.',
  },
  replace: {
    title: 'Replace everything',
    description:
      'Deletes every plan and part in this browser, then imports the file. This cannot be undone.',
  },
}

function problemOf(error: unknown): Problem {
  return {
    message: errorMessage(error),
    details: error instanceof BackupFormatError ? error.details : [],
  }
}

function ProblemList({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null
  return (
    <ul className="mt-1 list-disc space-y-1 pl-5">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  )
}

function planStatus(plan: PreviewPlan, existing: ReadonlySet<string>): string {
  if (plan.status === 'invalid') return 'Cannot be imported'
  if (plan.status === 'read-only') return 'Newer app version: read-only'
  return plan.id !== undefined && existing.has(plan.id) ? 'Already in this browser' : 'New'
}

/** The badge tone next to each plan in the preview; the badge text says the same. */
function planBadge(
  plan: PreviewPlan,
  existing: ReadonlySet<string>,
): 'destructive' | 'warning' | 'info' | 'outline' {
  if (plan.status === 'invalid') return 'destructive'
  if (plan.status === 'read-only') return 'warning'
  return plan.id !== undefined && existing.has(plan.id) ? 'outline' : 'info'
}

/** Import modes as choice cards: the checked one is tinted (Replace in the destructive tone). */
const MODE_CARD =
  'flex items-start gap-3 rounded-lg border p-3 transition-colors has-data-checked:border-primary has-data-checked:bg-accent has-data-checked:ring-1 has-data-checked:ring-primary'
const REPLACE_CARD =
  'flex items-start gap-3 rounded-lg border p-3 transition-colors has-data-checked:border-destructive has-data-checked:bg-destructive-soft has-data-checked:ring-1 has-data-checked:ring-destructive'

function contentsSummary(preview: ImportPreview, existing: ReadonlySet<string>): string {
  const plans = importablePlans(preview)
  const already = plans.filter((plan) => plan.id !== undefined && existing.has(plan.id)).length
  const parts: string[] = [
    `${plural(plans.length, 'plan')}${already > 0 ? ` (${already} already in this browser)` : ''}`,
  ]
  if (preview.kind === 'backup') {
    parts.push(plural(preview.parts.valid, 'custom part'))
    parts.push(preview.settings === 'valid' ? 'settings included' : 'no settings')
    parts.push(preview.inventory === 'valid' ? 'inventory included' : 'no inventory')
  }
  return parts.join(', ')
}

function resultSummary(result: ImportResult): string[] {
  const lines: string[] = []
  if (result.mode === 'copy') {
    lines.push(`${plural(result.added, 'plan')} added as new plans.`)
  } else {
    const counts = [`${result.added} added`, `${result.updated} updated`]
    if (result.skipped > 0) counts.push(`${result.skipped} skipped (your copy was as new or newer)`)
    lines.push(`Plans: ${counts.join(', ')}.`)
  }
  if (result.mode === 'replace' && result.removed > 0) {
    lines.push(`${plural(result.removed, 'plan')} that only this browser had were removed.`)
  }
  const { library } = result
  if (library.added + library.updated + library.skipped > 0) {
    const kept = library.skipped > 0 ? `, ${library.skipped} kept as you had them` : ''
    lines.push(`Custom parts: ${library.added} added${kept}.`)
  }
  if (result.settingsImported) lines.push('Settings imported.')
  if (result.inventoryImported) lines.push('Inventory imported.')
  return lines
}

export function ImportPage() {
  const location = useLocation()
  const shareLink = location.hash.startsWith('#p=')
  const [dragging, setDragging] = useState(false)
  const [reading, setReading] = useState<string | null>(null)
  const [picked, setPicked] = useState<PickedFile | null>(null)
  const [readProblem, setReadProblem] = useState<(Problem & { fileName: string }) | null>(null)
  const [mode, setMode] = useState<ImportMode>('merge')
  const [confirmText, setConfirmText] = useState('')
  const [confirmMissing, setConfirmMissing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProblem, setImportProblem] = useState<Problem | null>(null)
  const [imported, setImported] = useState<Imported | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)
  const previewHeadingRef = useRef<HTMLHeadingElement>(null)
  const resultHeadingRef = useRef<HTMLHeadingElement>(null)
  /** Only the latest file's reading counts (a second pick overtakes a slow first one). */
  const readToken = useRef(0)
  const chooseHeadingId = useId()
  const hintId = useId()
  const previewHeadingId = useId()
  const modeLabelId = useId()
  const confirmId = useId()
  const confirmErrorId = useId()
  const resultHeadingId = useId()

  // A file dropped next to the drop zone would otherwise make the browser leave the app to show it.
  useEffect(() => {
    function keepFiles(event: globalThis.DragEvent): void {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    }
    window.addEventListener('dragover', keepFiles)
    window.addEventListener('drop', keepFiles)
    return () => {
      window.removeEventListener('dragover', keepFiles)
      window.removeEventListener('drop', keepFiles)
    }
  }, [])

  // New content gets focus, so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (picked !== null) previewHeadingRef.current?.focus()
  }, [picked])
  useEffect(() => {
    if (imported !== null) resultHeadingRef.current?.focus()
  }, [imported])

  async function read(file: File): Promise<void> {
    const token = ++readToken.current
    setReading(file.name)
    setPicked(null)
    setReadProblem(null)
    setImported(null)
    setImportProblem(null)
    setMode('merge')
    setConfirmText('')
    setConfirmMissing(false)
    try {
      const json = await readBackupFile(file)
      const preview = previewImport(json)
      const existing = await listPlanSummaries().then(
        (plans) => new Set(plans.map((plan) => plan.id)),
        () => new Set<string>(),
      )
      if (token === readToken.current) setPicked({ name: file.name, json, preview, existing })
    } catch (error) {
      if (token === readToken.current) setReadProblem({ fileName: file.name, ...problemOf(error) })
    } finally {
      if (token === readToken.current) setReading(null)
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file !== undefined) void read(file)
  }

  async function runImport(): Promise<void> {
    if (picked === null || importing) return
    if (mode === 'replace' && confirmText.trim() !== REPLACE_WORD) {
      setConfirmMissing(true)
      confirmRef.current?.focus()
      return
    }
    setImporting(true)
    setImportProblem(null)
    try {
      const result = await importBackup(picked.json, mode)
      const names = await listPlanSummaries().then(
        (plans) => new Map(plans.map((plan) => [plan.id, plan.name])),
        () => new Map<string, string>(),
      )
      setImported({ fileName: picked.name, result, names })
      setPicked(null)
    } catch (error) {
      setImportProblem(problemOf(error))
    } finally {
      setImporting(false)
    }
  }

  const preview = picked?.preview
  const replaceAllowed = preview === undefined ? false : canReplace(preview)
  const somethingToImport =
    preview !== undefined &&
    (importablePlans(preview).length > 0 ||
      preview.parts.valid > 0 ||
      preview.settings === 'valid' ||
      preview.inventory === 'valid')
  const leftOut =
    preview === undefined
      ? []
      : [
          ...preview.problems,
          ...(preview.settings === 'invalid'
            ? ['The settings in this file are not valid; yours are kept.']
            : []),
          ...(preview.inventory === 'invalid'
            ? ['The inventory in this file is not valid; yours is kept.']
            : []),
        ]

  return (
    <div className="mx-auto flex w-full max-w-screen-md flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Import</h1>
        <p className="text-sm text-muted-foreground">
          Restore a backup or add plans from a file. The file is read in this browser; nothing is
          uploaded.
        </p>
      </header>

      {shareLink ? (
        <Alert role="status" variant="info">
          <Info aria-hidden />
          <AlertTitle>This is a share link</AlertTitle>
          <AlertDescription>
            Share links open in the read-only viewer, which arrives in v0.2. Until then, ask for the
            plan as a file (Export as file on the Plans page) and import it here.
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby={chooseHeadingId} className="grid gap-3">
        <h2 id={chooseHeadingId} className="text-base font-medium">
          Choose a file
        </h2>
        <div
          onDragEnter={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragOver={(event) => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
            setDragging(true)
          }}
          onDragLeave={(event) => {
            const next = event.relatedTarget
            if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDragging(false)
          }}
          onDrop={onDrop}
          className={cn(
            'grid place-items-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors',
            dragging ? 'border-primary bg-accent' : 'border-primary/30 bg-accent/30',
          )}
        >
          <FileUp aria-hidden className="size-8 text-primary" />
          <p className="font-medium">
            {dragging ? 'Drop the file to read it' : 'Drop a backup or plan file here'}
          </p>
          <p id={hintId} className="text-sm text-muted-foreground">
            A .json file from Mini Rack Planner: a full backup (Settings) or one plan (Export as
            file on the Plans page).
          </p>
          <Button
            type="button"
            variant="outline"
            aria-describedby={hintId}
            disabled={reading !== null || importing}
            onClick={() => inputRef.current?.click()}
          >
            Choose a file…
          </Button>
          {/* Kept out of the tab order: the button above opens it. */}
          <input
            ref={inputRef}
            type="file"
            accept=".json,application/json"
            tabIndex={-1}
            aria-hidden
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0]
              // Reset, so picking the same file again is still a change.
              event.target.value = ''
              if (file !== undefined) void read(file)
            }}
          />
        </div>
        <div aria-live="polite" className="text-sm">
          {reading === null ? null : (
            <p className="flex items-center gap-2 text-muted-foreground">
              <LoaderCircle
                aria-hidden
                className="size-4 animate-spin motion-reduce:animate-none"
              />
              Reading {reading}…
            </p>
          )}
        </div>
        {readProblem === null ? null : (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertTitle>{readProblem.fileName} cannot be imported</AlertTitle>
            <AlertDescription>
              <p>{readProblem.message}</p>
              <ProblemList items={readProblem.details} />
            </AlertDescription>
          </Alert>
        )}
      </section>

      {picked === null || preview === undefined ? null : (
        <section aria-labelledby={previewHeadingId} className="grid gap-4">
          <div className="grid gap-1">
            <h2
              ref={previewHeadingRef}
              id={previewHeadingId}
              tabIndex={-1}
              className="text-base font-medium outline-none"
            >
              In {picked.name}
            </h2>
            <p className="text-sm text-muted-foreground">
              {preview.kind === 'plan'
                ? 'A single plan.'
                : `A backup${preview.appVersion === undefined ? '' : ` from version ${preview.appVersion}`}${
                    preview.exportedAt === undefined
                      ? ''
                      : `, made ${formatDateTime(preview.exportedAt)}`
                  }.`}{' '}
              {contentsSummary(preview, picked.existing)}.
            </p>
          </div>

          {preview.plans.length === 0 ? null : (
            <ul className="grid gap-1.5" aria-label="Plans in the file">
              {preview.plans.slice(0, PREVIEW_LIMIT).map((plan) => (
                <li
                  key={plan.position}
                  className={cn(
                    'flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm',
                    plan.status === 'invalid' && 'border-dashed',
                  )}
                >
                  <span className="min-w-0 break-words">{plan.name}</span>
                  <Badge variant={planBadge(plan, picked.existing)}>
                    {plan.status === 'invalid' ? <CircleAlert aria-hidden /> : null}
                    {planStatus(plan, picked.existing)}
                  </Badge>
                </li>
              ))}
              {preview.plans.length > PREVIEW_LIMIT ? (
                <li className="px-3 text-sm text-muted-foreground">
                  and {plural(preview.plans.length - PREVIEW_LIMIT, 'more plan')}
                </li>
              ) : null}
            </ul>
          )}

          {leftOut.length === 0 ? null : (
            <Alert role="status" variant="warning">
              <TriangleAlert aria-hidden />
              <AlertTitle>Some of the file will be left out</AlertTitle>
              <AlertDescription>
                <ProblemList items={leftOut} />
              </AlertDescription>
            </Alert>
          )}

          {somethingToImport ? (
            <>
              <div className="grid gap-2">
                <span id={modeLabelId} className="text-sm font-medium">
                  How should it come in?
                </span>
                <RadioGroup
                  value={mode}
                  onValueChange={(next: unknown) => {
                    if (next === 'merge' || next === 'copy' || next === 'replace') {
                      setMode(next)
                      setConfirmMissing(false)
                    }
                  }}
                  aria-labelledby={modeLabelId}
                  className="gap-2"
                >
                  {(['merge', 'copy', 'replace'] as const).map((value) => {
                    const disabled = value === 'replace' && !replaceAllowed
                    return (
                      <label
                        key={value}
                        className={cn(
                          value === 'replace' ? REPLACE_CARD : MODE_CARD,
                          disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
                          !disabled && value !== mode && 'hover:bg-accent/40',
                        )}
                      >
                        <RadioGroupItem
                          value={value}
                          disabled={disabled}
                          aria-label={MODE_TEXT[value].title}
                          aria-describedby={`${modeLabelId}-${value}`}
                          className="mt-0.5"
                        />
                        <span className="grid gap-0.5">
                          <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                            {MODE_TEXT[value].title}
                            {value === 'replace' ? (
                              <Badge variant="destructive">
                                <TriangleAlert aria-hidden />
                                Destructive
                              </Badge>
                            ) : null}
                          </span>
                          <span
                            id={`${modeLabelId}-${value}`}
                            className="text-sm text-muted-foreground"
                          >
                            {MODE_TEXT[value].description}
                            {disabled
                              ? ' Not available: some entries in this file cannot be read, and Replace never imports half a file.'
                              : ''}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </RadioGroup>
              </div>

              {mode === 'replace' ? (
                <div className="grid gap-1.5">
                  <Label htmlFor={confirmId}>Type {REPLACE_WORD} to confirm</Label>
                  <Input
                    ref={confirmRef}
                    id={confirmId}
                    value={confirmText}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    onChange={(event) => {
                      setConfirmText(event.target.value)
                      setConfirmMissing(false)
                    }}
                    aria-invalid={confirmMissing || undefined}
                    aria-describedby={confirmMissing ? confirmErrorId : undefined}
                    className="sm:w-64"
                  />
                  {confirmMissing ? (
                    <p id={confirmErrorId} className="text-sm text-destructive">
                      Type {REPLACE_WORD} in capitals to replace everything in this browser.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {importProblem === null ? null : (
                <Alert variant="destructive">
                  <TriangleAlert aria-hidden />
                  <AlertTitle>Nothing was imported</AlertTitle>
                  <AlertDescription>
                    <p>{importProblem.message}</p>
                    <ProblemList items={importProblem.details} />
                  </AlertDescription>
                </Alert>
              )}

              <div>
                <Button
                  type="button"
                  variant={mode === 'replace' ? 'destructive' : 'default'}
                  disabled={importing}
                  aria-busy={importing || undefined}
                  onClick={() => void runImport()}
                >
                  {importing
                    ? 'Importing…'
                    : mode === 'replace'
                      ? 'Replace everything'
                      : mode === 'copy'
                        ? 'Import as copies'
                        : 'Import'}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing in this file can be imported.</p>
          )}
        </section>
      )}

      {imported === null ? null : (
        <section aria-labelledby={resultHeadingId} className="grid gap-3">
          <h2
            ref={resultHeadingRef}
            id={resultHeadingId}
            tabIndex={-1}
            className="flex items-center gap-2 text-base font-medium outline-none"
          >
            <CircleCheck aria-hidden className="size-5 shrink-0 text-have" />
            Imported {imported.fileName}
          </h2>
          <ul className="grid gap-1 text-sm">
            {resultSummary(imported.result).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {imported.result.planIds.length === 0 ? null : (
            <div className="grid gap-1.5">
              <h3 className="text-sm font-medium">Open a plan</h3>
              <ul className="grid gap-1">
                {imported.result.planIds.map((id) => (
                  <li key={id}>
                    <Link
                      to={`/plan/${encodeURIComponent(id)}`}
                      className="text-sm font-medium text-primary underline underline-offset-4"
                    >
                      {imported.names.get(id) ?? id}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {imported.result.errors.length + imported.result.warnings.length === 0 ? null : (
            <Alert role="status" variant="warning">
              <TriangleAlert aria-hidden />
              <AlertTitle>Notes</AlertTitle>
              <AlertDescription>
                <ProblemList items={[...imported.result.errors, ...imported.result.warnings]} />
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Link to="/" className={buttonVariants({ variant: 'outline' })}>
              Back to your racks
            </Link>
          </div>
        </section>
      )}
    </div>
  )
}
