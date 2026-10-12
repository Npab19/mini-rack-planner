/**
 * The editor route: loads the plan into the plan store (and unloads it on leave), then lays out
 * the editor: the toolbar, the placing and Recording banners, and the panels around the rack
 * (columns from lg up, sheets below; see layout/EditorLayout.tsx). The shell owns the global
 * shortcuts, the keyboard help, the live region for its own announcements and the guard that asks
 * before leaving with edits another tab kept from being saved.
 *
 * M3b: the panels sit inside `RackDndProvider` (palette and tray rows drag onto the rack), the
 * mount dialogs (chooser, "Needs a mount?") are rendered here once per plan, and every plan edit
 * copies the user's own parts it starts using into the plan (`embedUsedCustomEntries`), so the
 * plan exports, imports and shares complete. The "Add a part" dialog lives in the app shell.
 */
import { ArrowLeft, CircleDot, CopyPlus, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useBlocker, useParams } from 'react-router'
import { toast } from 'sonner'
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
import { errorMessage } from '@/db/errors'
import { embedUsedCustomEntries } from '@/domain/customParts'
import { useCatalogStore } from '@/state/catalogStore'
import { hasStrandedEdits, usePlanStore } from '@/state/planStore'
import { useRecordingMode, useUiStore } from '@/state/uiStore'
import { useEditorState } from './editorState'
import { KeyboardHelp } from './KeyboardHelp'
import { announce, clearAnnouncement } from './layout/announcer'
import { EditorLayout } from './layout/EditorLayout'
import { EditorLiveRegion } from './layout/EditorLiveRegion'
import { resetEditorShell } from './layout/shellStore'
import { useIsDesktop } from './layout/useMediaQuery'
import { MountDialogs } from './mounts/MountDialogs'
import { RackDndProvider } from './rack/RackDndProvider'
import { createEditorActions, EditorActionsProvider } from './toolbar/editorActions'
import { EditorToolbar } from './toolbar/EditorToolbar'
import { PlacingBanner } from './toolbar/PlacingBanner'
import { useEditorShortcuts } from './useEditorShortcuts'

const BACK_LINK_CLASS =
  'inline-flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50'

/** Loading, not found and failed: a simple page with the way back. */
function StatusShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-screen-lg flex-col gap-5 px-4 py-6 sm:px-6">
      <Link to="/" className={BACK_LINK_CLASS}>
        <ArrowLeft aria-hidden className="size-4" />
        Your racks
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Rack editor</h1>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Banners and guards

function RecordingBanner({ onDone }: { onDone: () => void }) {
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b-2 border-dashed border-foreground/40 bg-muted/40 px-3 py-2"
    >
      <CircleDot aria-hidden className="size-4 shrink-0" />
      <div className="grid min-w-48 flex-1 basis-72 gap-0.5">
        <h2 id={titleId} className="text-sm font-medium">
          Recording what you have
        </h2>
        <p className="text-xs text-muted-foreground sm:text-sm">
          Everything you add now is marked “In my rack”. When your rack is recorded, start planning:
          new things are then marked “To get”.
        </p>
      </div>
      <Button size="sm" onClick={onDone}>
        Done, start planning
      </Button>
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

// ---------------------------------------------------------------------------------------------
// The loaded plan

/**
 * The editor for an open plan. It subscribes to almost nothing itself (the layout breakpoint and
 * Recording mode): every toolbar control and panel subscribes to what it shows, so an edit
 * re-renders only those.
 */
function ReadyEditor({ planId }: { planId: string }) {
  const desktop = useIsDesktop()
  const recording = useRecordingMode(planId)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const actions = useMemo(() => createEditorActions({ desktop }), [desktop])

  useEditorShortcuts(actions)

  // Opening a plan lands on its heading, so keyboard and screen-reader users start at the top.
  // (One mount per plan: the route keys this component by plan id.)
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [])

  // Parts from the user's library that an edit starts using are copied into the plan in the same
  // undo step: a plan carries its own parts, so it exports and shares complete.
  useEffect(() => {
    usePlanStore
      .getState()
      .setOpFinisher((plan) => embedUsedCustomEntries(plan, useCatalogStore.getState().library))
    return () => usePlanStore.getState().setOpFinisher(null)
  }, [])

  // Sheets, the keyboard help and announcements belong to this plan's session.
  useEffect(
    () => () => {
      resetEditorShell()
      clearAnnouncement()
    },
    [],
  )

  const doneRecording = useCallback(() => {
    useUiStore.getState().setRecordingMode(planId, false)
    announce('Planning: new things you add are marked To get.')
    headingRef.current?.focus()
  }, [planId])

  return (
    <EditorActionsProvider value={actions}>
      {/* Fills the window below the app header (3rem); short windows scroll the page instead. */}
      <div className="flex h-[calc(100dvh-3rem)] min-h-[30rem] flex-col">
        <EditorToolbar desktop={desktop} headingRef={headingRef} />
        <PlacingBanner />
        {recording ? <RecordingBanner onDone={doneRecording} /> : null}
        {/* Palette and tray rows drag onto the rack (lg and up). */}
        <RackDndProvider>
          <EditorLayout desktop={desktop} />
        </RackDndProvider>
      </div>
      <MountDialogs />
      <KeyboardHelp />
      <EditorLiveRegion />
      <StrandedEditsGuard />
    </EditorActionsProvider>
  )
}

// ---------------------------------------------------------------------------------------------
// The route

export function EditorPage() {
  const { planId = '' } = useParams()
  const storeId = usePlanStore((state) => state.planId)
  const status = usePlanStore((state) => state.status)
  const error = usePlanStore((state) => state.error)
  const hasPlan = usePlanStore((state) => state.plan !== null)

  useEffect(() => {
    void usePlanStore.getState().load(planId)
    return () => {
      // What was being placed, the ghost and the inspector tab belong to this editor visit.
      useEditorState.getState().reset()
      void usePlanStore.getState().unload()
    }
  }, [planId])

  // Until the store catches up with the route it still describes the previous plan.
  const current = storeId === planId ? status : 'loading'
  if (current === 'ready' && hasPlan) {
    return <ReadyEditor key={planId} planId={planId} />
  }

  return (
    <StatusShell>
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
    </StatusShell>
  )
}
