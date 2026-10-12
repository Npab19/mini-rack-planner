/**
 * The Plans page ("Your racks"): the three ways to start while there are no plans, then a grid of
 * plan cards that follows the database live (this tab and others). Card actions run against the
 * stored plans directly; results are announced with toasts.
 */
import { FileUp, Plus, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { exportBackup, serializeBackup } from '@/db/backup'
import { errorMessage } from '@/db/errors'
import { createPlan, duplicatePlan, nowIso, type PlanSummary } from '@/db/plansRepo'
import { BackupNudge } from '@/features/settings/BackupNudge'
import { downloadBlob } from '@/lib/download'
import { getCatalog } from '@/state/catalogStore'
import { usePlanSummaries } from '@/state/planList'
import { planFileName } from './format'
import { NewPlanWizard } from './NewPlanWizard'
import { PlanCard, type PlanCardAction } from './PlanCard'
import { DeletePlanDialog, RenamePlanDialog } from './PlanDialogs'
import { buildSamplePlan } from './sample'
import { StartOptions, type StartChoice } from './StartOptions'
import type { WizardMode } from './wizardModel'

/** "Updated 5 minutes ago" stays true while the page is open. */
const CLOCK_TICK_MS = 60_000

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function quoted(name: string): string {
  return `“${name.trim() === '' ? 'Untitled plan' : name}”`
}

interface WizardLaunch {
  /** Bumped on every opening, so the wizard starts from scratch. */
  key: number
  mode?: WizardMode
}

function LoadingPlans() {
  return (
    <div role="status" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <span className="sr-only">Loading your plans…</span>
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-44 rounded-xl" />
      ))}
    </div>
  )
}

export function PlansPage() {
  const { plans, error } = usePlanSummaries()
  const navigate = useNavigate()
  const now = useNow(CLOCK_TICK_MS)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const startHeadingId = useId()
  const listHeadingId = useId()
  const [wizardOpen, setWizardOpen] = useState(false)
  const [launch, setLaunch] = useState<WizardLaunch>({ key: 0 })
  const [renaming, setRenaming] = useState<PlanSummary | null>(null)
  const [deleting, setDeleting] = useState<PlanSummary | null>(null)
  const [sampleBusy, setSampleBusy] = useState(false)

  function openWizard(mode?: WizardMode): void {
    setLaunch((current) => ({ key: current.key + 1, mode }))
    setWizardOpen(true)
  }

  async function openSample(): Promise<void> {
    if (sampleBusy) return
    setSampleBusy(true)
    try {
      const { lookup, catalogRev } = getCatalog()
      const { plan } = buildSamplePlan(lookup, nowIso())
      const created = await createPlan({ ...plan, catalogRev })
      await navigate(`/plan/${encodeURIComponent(created.id)}`)
    } catch (caught) {
      toast.error(`Could not open the sample: ${errorMessage(caught)}`)
      setSampleBusy(false)
    }
  }

  function choose(choice: StartChoice): void {
    if (choice === 'sample') void openSample()
    else openWizard(choice)
  }

  async function duplicate(summary: PlanSummary, fromScratch: boolean): Promise<void> {
    try {
      const copy = await duplicatePlan(summary.id, {
        resetHave: fromScratch,
        sameRack: !fromScratch,
      })
      toast.success(
        fromScratch
          ? `Started ${quoted(copy.name)} from scratch: everything is to get.`
          : `Saved ${quoted(copy.name)} as a new idea for the same rack.`,
        {
          action: {
            label: 'Open',
            onClick: () => void navigate(`/plan/${encodeURIComponent(copy.id)}`),
          },
        },
      )
    } catch (caught) {
      toast.error(`Could not duplicate ${quoted(summary.name)}: ${errorMessage(caught)}`)
    }
  }

  async function exportPlan(summary: PlanSummary): Promise<void> {
    try {
      // A backup file holding just this plan: Import reads it like any backup.
      const file = await exportBackup({ planIds: [summary.id], includeSettings: false })
      const fileName = planFileName(summary.name, new Date())
      const blob = new Blob([serializeBackup(file)], { type: 'application/json' })
      const outcome = await downloadBlob(fileName, blob)
      if (outcome === 'cancelled') return
      toast.success(
        outcome === 'saved'
          ? `Saved ${quoted(summary.name)} as ${fileName}.`
          : `Exported ${quoted(summary.name)} as ${fileName}.`,
      )
    } catch (caught) {
      toast.error(`Could not export ${quoted(summary.name)}: ${errorMessage(caught)}`)
    }
  }

  function act(action: PlanCardAction, summary: PlanSummary): void {
    switch (action) {
      case 'rename':
        setRenaming(summary)
        break
      case 'delete':
        setDeleting(summary)
        break
      case 'duplicate-idea':
        void duplicate(summary, false)
        break
      case 'duplicate-scratch':
        void duplicate(summary, true)
        break
      case 'export':
        void exportPlan(summary)
        break
    }
  }

  const hasPlans = plans !== undefined && plans.length > 0

  let content
  if (plans === undefined) {
    content = <LoadingPlans />
  } else if (error !== null) {
    content = (
      <Alert variant="destructive">
        <TriangleAlert aria-hidden />
        <AlertTitle>Your plans could not be read</AlertTitle>
        <AlertDescription>
          <p>{error}</p>
          <p>
            Plans are kept in this browser’s storage. A private window or blocked site data can make
            it unavailable.
          </p>
        </AlertDescription>
      </Alert>
    )
  } else if (!hasPlans) {
    content = (
      <section aria-labelledby={startHeadingId} className="grid gap-3">
        <h2 id={startHeadingId} className="text-lg font-medium">
          Start your first plan
        </h2>
        <StartOptions onChoose={choose} busyChoice={sampleBusy ? 'sample' : null} />
        <p className="text-sm text-muted-foreground">
          Moving from another browser or device?{' '}
          <Link to="/import" className="font-medium text-primary underline underline-offset-4">
            Import a backup
          </Link>
          .
        </p>
      </section>
    )
  } else {
    content = (
      <section aria-labelledby={listHeadingId}>
        <h2 id={listHeadingId} className="sr-only">
          Saved plans
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((summary) => (
            <li key={summary.id}>
              <PlanCard summary={summary} now={now} onAction={act} />
            </li>
          ))}
        </ul>
      </section>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-screen-lg flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight outline-none"
          >
            Your racks
          </h1>
          <p className="text-sm text-muted-foreground">
            Plans are saved in this browser. Nothing is uploaded.
          </p>
        </div>
        {hasPlans ? (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => openWizard()}>
              <Plus aria-hidden />
              New plan
            </Button>
            {/* Navigation stays a real link (Base UI's Button would make it role="button"). */}
            <Link to="/import" className={buttonVariants({ variant: 'outline' })}>
              <FileUp aria-hidden />
              Import
            </Link>
          </div>
        ) : null}
      </header>

      {/* Plans live only in this browser: suggest a backup while there is something to lose. */}
      {hasPlans ? <BackupNudge plans={plans} /> : null}

      {content}

      <NewPlanWizard
        open={wizardOpen}
        launchKey={launch.key}
        mode={launch.mode}
        onOpenChange={setWizardOpen}
        onOpenSample={() => {
          setWizardOpen(false)
          void openSample()
        }}
        onCreated={(plan) => {
          setWizardOpen(false)
          void navigate(`/plan/${encodeURIComponent(plan.id)}`)
        }}
      />
      <RenamePlanDialog plan={renaming} onClose={() => setRenaming(null)} />
      <DeletePlanDialog
        plan={deleting}
        onClose={() => setDeleting(null)}
        afterDelete={headingRef}
        onDeleted={() => setDeleting(null)}
      />
    </div>
  )
}
