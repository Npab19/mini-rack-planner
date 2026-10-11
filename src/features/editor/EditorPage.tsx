/**
 * The editor route for M2, a stub: it loads the plan into the plan store (and unloads it on leave),
 * lists the stack, and lets the name be edited, so autosave, undo/redo, Recording mode and the
 * two-tab conflict path work end to end. The full editor arrives in v0.1 (M3a).
 */
import {
  ArrowLeft,
  Check,
  CircleDot,
  CopyPlus,
  LoaderCircle,
  Lock,
  Redo2,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react'
import { Link, useBlocker, useParams } from 'react-router'
import { toast } from 'sonner'
import { HaveNeedBadge } from '@/components/common/HaveNeed'
import { LiveRegion, useAnnouncer } from '@/components/common/LiveRegion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { errorMessage } from '@/db/errors'
import { formatU, uNumberAt, uToSixths } from '@/domain/geometry'
import { sectionHeightU } from '@/domain/recipe'
import type { Frame } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import { cn } from '@/lib/utils'
import { usePlanLookup, usePlanStats } from '@/state/derived'
import {
  canRedo,
  canUndo,
  hasStrandedEdits,
  useCanRedo,
  useCanUndo,
  usePlanStore,
} from '@/state/planStore'
import { useRecordingMode, useUiStore } from '@/state/uiStore'

/** A pause in typing this long ends the name edit: one undo step, saved right away. */
const NAME_IDLE_COMMIT_MS = 500
/** Same limit as the plan schema. */
const MAX_NAME_LENGTH = 200

const BACK_LINK_CLASS =
  'inline-flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50'

function BackToPlans() {
  return (
    <Link to="/" className={BACK_LINK_CLASS}>
      <ArrowLeft aria-hidden className="size-4" />
      Your racks
    </Link>
  )
}

function EditorShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-screen-lg flex-col gap-5 px-4 py-6 sm:px-6">
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Name

/**
 * The plan name as the page heading, edited in place. Typing renames the plan in the store at
 * once, while a gesture keeps a burst of typing as one undo step. Enter, leaving the field or a
 * short pause ends the step and saves at once (rather than after the autosave delay), which keeps
 * the window for losing a name to an immediate reload small. Escape undoes the burst. A blank
 * name is never stored: the last one stays until a new one is typed.
 */
function PlanNameHeading({
  name,
  readOnly,
  headingRef,
}: {
  name: string
  readOnly: boolean
  headingRef: Ref<HTMLHeadingElement>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const editing = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const errorId = useId()
  const blank = draft !== null && draft.trim() === ''

  const commit = useCallback(() => {
    clearTimeout(idleTimer.current)
    idleTimer.current = undefined
    if (!editing.current) return
    editing.current = false
    const store = usePlanStore.getState()
    store.endGesture()
    void store.flushSave()
  }, [])

  // Leaving mid-edit still records the edit as one step and saves it.
  useEffect(() => commit, [commit])

  function change(text: string): void {
    setDraft(text)
    const store = usePlanStore.getState()
    if (!editing.current) {
      store.beginGesture()
      editing.current = true
    }
    store.renamePlan(text)
    clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(commit, NAME_IDLE_COMMIT_MS)
  }

  function finish(): void {
    commit()
    setDraft(null)
  }

  function cancel(): void {
    clearTimeout(idleTimer.current)
    if (editing.current) {
      editing.current = false
      usePlanStore.getState().cancelGesture()
    }
    setDraft(null)
  }

  return (
    <div className="grid min-w-0 gap-1">
      <h1 ref={headingRef} tabIndex={-1} className="min-w-0 outline-none">
        <Input
          data-testid="plan-name-input"
          aria-label="Plan name"
          value={draft ?? name}
          readOnly={readOnly}
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => change(event.target.value)}
          onBlur={finish}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              finish()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancel()
            }
          }}
          aria-invalid={blank || undefined}
          aria-describedby={blank ? errorId : undefined}
          className="-mx-1.5 h-10 border-transparent bg-transparent px-1.5 text-2xl font-semibold tracking-tight hover:border-input md:text-2xl dark:bg-transparent"
        />
      </h1>
      {blank ? (
        <p id={errorId} className="text-sm text-destructive">
          A plan needs a name. The current one is kept until you type a new one.
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Save state

interface SaveView {
  label: string
  detail?: string
  icon: LucideIcon
  tone: 'muted' | 'warning'
  busy?: boolean
}

function useSaveView(): SaveView {
  const saveState = usePlanStore((state) => state.saveState)
  const conflict = usePlanStore((state) => state.conflict)
  const readOnly = usePlanStore((state) => state.readOnly)
  const lastError = usePlanStore((state) => state.lastError)
  if (readOnly) {
    return { label: 'Read-only', detail: 'made with a newer version', icon: Lock, tone: 'muted' }
  }
  if (conflict !== null) {
    const detail = conflict.theirRev === null ? 'deleted in another tab' : 'changed in another tab'
    return { label: 'Not saved', detail, icon: TriangleAlert, tone: 'warning' }
  }
  if (saveState === 'error') {
    return {
      label: 'Not saved',
      detail: lastError ?? undefined,
      icon: TriangleAlert,
      tone: 'warning',
    }
  }
  if (saveState === 'saved') return { label: 'Saved', icon: Check, tone: 'muted' }
  // dirty (a save is due within moments) or saving
  return { label: 'Saving…', icon: LoaderCircle, tone: 'muted', busy: true }
}

function SaveIndicator() {
  const view = useSaveView()
  const Icon = view.icon
  return (
    <p
      role="status"
      className={cn(
        'flex min-w-0 items-center gap-1.5 text-sm',
        view.tone === 'warning' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      <Icon
        aria-hidden
        className={cn('size-4 shrink-0', view.busy && 'animate-spin motion-reduce:animate-none')}
      />
      <span data-testid="save-state" className="font-medium">
        {view.label}
      </span>
      {view.detail === undefined ? null : <span className="truncate">({view.detail})</span>}
    </p>
  )
}

// ---------------------------------------------------------------------------------------------
// Stack

interface SectionRow {
  id: string
  label: string
  fromU: number
  toU: number
  have: boolean
}

/** Sections bottom -> top with U ranges; unknown types fall back to what was built. */
function sectionRows(plan: Plan, frame: Frame | undefined): SectionRow[] {
  let start = 0
  return plan.frame.sections.map((section) => {
    const planned = sectionHeightU(frame, section.typeId, section.heightU)
    const heightU = planned > 0 ? planned : (section.have?.heightU ?? 0)
    const end = start + uToSixths(heightU)
    const type = frame?.sectionTypes.find((candidate) => candidate.id === section.typeId)
    const row: SectionRow = {
      id: section.id,
      label: type?.label ?? `${formatU(uToSixths(heightU))} section`,
      fromU: uNumberAt(start),
      toU: end > start ? uNumberAt(end - 1) : uNumberAt(start),
      have: section.have !== undefined,
    }
    start = end
    return row
  })
}

function SectionList({ plan, frame }: { plan: Plan; frame: Frame | undefined }) {
  const headingId = useId()
  const rows = sectionRows(plan, frame).toReversed()
  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <h2 id={headingId} className="text-base font-medium">
        Sections <span className="font-normal text-muted-foreground">(top to bottom)</span>
      </h2>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No sections yet.
        </p>
      ) : (
        <ol className="grid gap-1.5">
          {rows.map((row) => (
            <li
              key={row.id}
              data-testid="section-row"
              data-have={row.have}
              className={cn(
                'flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm',
                !row.have && 'border-dashed border-foreground/30',
              )}
            >
              <span>
                <span className="font-medium">{row.label}</span>{' '}
                <span className="text-muted-foreground">
                  U{row.fromU}–U{row.toU}
                </span>
              </span>
              <HaveNeedBadge have={row.have} />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------
// The loaded plan

function RecordingBanner({ onDone }: { onDone: () => void }) {
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-wrap items-center gap-3 rounded-xl border-2 border-dashed border-foreground/40 bg-muted/40 p-3 sm:p-4"
    >
      <CircleDot aria-hidden className="size-5 shrink-0" />
      <div className="grid min-w-48 flex-1 gap-0.5">
        <h2 id={titleId} className="font-medium">
          Recording what you have
        </h2>
        <p className="text-sm text-muted-foreground">
          Everything you add now is marked “In my rack”. When your rack is recorded, start planning:
          new things are then marked “To get”.
        </p>
      </div>
      <Button onClick={onDone}>Done, start planning</Button>
    </section>
  )
}

/**
 * After another tab changed or deleted this plan, edits made here cannot be saved to it. Leaving
 * the editor would drop them without a word: ask first and offer to keep them as a new plan.
 * Closing or reloading the tab gets the browser's own "Leave site?" prompt.
 */
function StrandedEditsGuard() {
  const stranded = usePlanStore(hasStrandedEdits)
  const deleted = usePlanStore((state) => state.conflict?.theirRev === null)
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      hasStrandedEdits(usePlanStore.getState()) &&
      currentLocation.pathname !== nextLocation.pathname,
  )
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!stranded) return
    function onBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [stranded])

  async function saveCopyAndLeave(): Promise<void> {
    setBusy(true)
    try {
      await usePlanStore.getState().saveAsCopy()
      toast.success('Your changes were saved as a new plan.')
      blocker.proceed?.()
    } catch (error) {
      toast.error(`Could not save a copy: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={blocker.state === 'blocked'}
      onOpenChange={(open) => {
        if (!open && !busy) blocker.reset?.()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keep your latest changes?</DialogTitle>
          <DialogDescription>
            {deleted
              ? 'This plan was deleted in another tab, so your changes here were not saved.'
              : 'This plan changed in another tab, so your latest changes here were not saved.'}{' '}
            Save them as a new plan, or leave without them.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => blocker.reset?.()}>
            Stay here
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => blocker.proceed?.()}>
            Leave without them
          </Button>
          <Button
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void saveCopyAndLeave()}
          >
            <CopyPlus aria-hidden />
            {busy ? 'Saving…' : 'Save as a copy and leave'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
}

function ReadyEditor({ plan, planId }: { plan: Plan; planId: string }) {
  const lookup = usePlanLookup()
  const stats = usePlanStats()
  const readOnly = usePlanStore((state) => state.readOnly)
  const undoable = useCanUndo()
  const redoable = useCanRedo()
  const recording = useRecordingMode(planId)
  const [message, announce] = useAnnouncer()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const frame = lookup.frame(plan.frame.frameId)

  // Opening a plan lands on its heading, so keyboard and screen-reader users start at the top.
  // (One mount per plan: the route keys this component by plan id.)
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [])

  const undo = useCallback(() => {
    if (!canUndo()) {
      announce('Nothing to undo.')
      return
    }
    usePlanStore.getState().undo()
    announce('Undone.')
  }, [announce])

  const redo = useCallback(() => {
    if (!canRedo()) {
      announce('Nothing to redo.')
      return
    }
    usePlanStore.getState().redo()
    announce('Redone.')
  }, [announce])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.altKey || !(event.ctrlKey || event.metaKey)) return
      // Text fields keep their own undo.
      if (isEditableTarget(event.target)) return
      const key = event.key.toLowerCase()
      // Ctrl+Y is the Windows redo; Cmd+Y is the browser's History on macOS, so it is left alone.
      const isRedo =
        (key === 'z' && event.shiftKey) || (key === 'y' && event.ctrlKey && !event.shiftKey)
      const isUndo = key === 'z' && !event.shiftKey
      if (!isUndo && !isRedo) return
      event.preventDefault()
      if (isRedo) redo()
      else undo()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])

  function doneRecording(): void {
    useUiStore.getState().setRecordingMode(planId, false)
    announce('Planning: new things you add are marked To get.')
    headingRef.current?.focus()
  }

  return (
    <EditorShell>
      <BackToPlans />
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="grid min-w-0 flex-1 basis-72 gap-1">
          <PlanNameHeading name={plan.name} readOnly={readOnly} headingRef={headingRef} />
          <p className="text-sm text-muted-foreground">
            {frame?.name ?? plan.frame.frameId}
            {stats === undefined ? null : ` · ${stats.sectionSummary}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SaveIndicator />
          <div role="group" aria-label="History" className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={undo}
              disabled={readOnly || !undoable}
              aria-keyshortcuts="Control+Z Meta+Z"
              title="Undo (Ctrl+Z)"
            >
              <Undo2 aria-hidden />
              Undo
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={redo}
              disabled={readOnly || !redoable}
              aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
              title="Redo (Ctrl+Shift+Z)"
            >
              <Redo2 aria-hidden />
              Redo
            </Button>
          </div>
        </div>
      </header>

      {recording ? <RecordingBanner onDone={doneRecording} /> : null}

      <SectionList plan={plan} frame={frame} />

      <p className="text-sm text-muted-foreground">
        The full editor arrives in v0.1 (M3a): the to-scale rack, mounts and equipment, the shopping
        list and checks.
      </p>
      <LiveRegion message={message} />
      <StrandedEditsGuard />
    </EditorShell>
  )
}

// ---------------------------------------------------------------------------------------------
// The route

export function EditorPage() {
  const { planId = '' } = useParams()
  const storeId = usePlanStore((state) => state.planId)
  const status = usePlanStore((state) => state.status)
  const error = usePlanStore((state) => state.error)
  const plan = usePlanStore((state) => state.plan)

  useEffect(() => {
    void usePlanStore.getState().load(planId)
    return () => {
      void usePlanStore.getState().unload()
    }
  }, [planId])

  // Until the store catches up with the route it still describes the previous plan.
  const current = storeId === planId ? status : 'loading'
  if (current === 'ready' && plan !== null) {
    return <ReadyEditor key={planId} plan={plan} planId={planId} />
  }

  return (
    <EditorShell>
      <BackToPlans />
      <h1 className="text-2xl font-semibold tracking-tight">Rack editor</h1>
      {current === 'not-found' ? (
        <Alert>
          <TriangleAlert aria-hidden />
          <AlertTitle>Plan not found</AlertTitle>
          <AlertDescription>
            <p>
              This plan is not in this browser. It may have been deleted, or saved in another
              browser or at another address: plans are stored per browser and per address.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link to="/" className={buttonVariants({ size: 'sm' })}>
                Back to your racks
              </Link>
              <Link to="/import" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                Import a plan file
              </Link>
            </div>
          </AlertDescription>
        </Alert>
      ) : current === 'error' ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden />
          <AlertTitle>This plan could not be opened</AlertTitle>
          <AlertDescription>
            <p>{error ?? 'Unknown error'}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void usePlanStore.getState().load(planId)}>
                Try again
              </Button>
              <Link to="/" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                Back to your racks
              </Link>
            </div>
          </AlertDescription>
        </Alert>
      ) : (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
          Opening the plan…
        </p>
      )}
    </EditorShell>
  )
}
