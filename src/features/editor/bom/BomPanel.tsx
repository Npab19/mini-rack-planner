/**
 * The BOM drawer (M3a): Shopping list (default) / Full BOM / Leftovers, grouped into prints,
 * hardware and equipment. "Got it" ticks a shopping line off by adding it to the spares
 * (inventory), "Finish build" turns everything To get into In my rack and uses up those spares,
 * and "Export CSV" saves the current list for a spreadsheet.
 *
 * Reads the open plan, its BOM (`useBom`), settings and inventory from the stores. The editor shell
 * titles it (the drawer header, or the sheet title on small screens), so it has no heading of its
 * own; it fits a 360 px sheet and spreads its groups into columns in a wide drawer. Announcements
 * go to the shell's live region, which outlives the panel.
 */
import { CircleCheck, Download, Info, PackageCheck, ShoppingCart, Undo2, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { HAVE_TEXT } from '@/components/common/HaveNeed'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { errorMessage } from '@/db/errors'
import { duplicatePlan, nowIso } from '@/db/plansRepo'
import type { BomLine, BomResult } from '@/domain/api'
import { computeBom, consumeInventory, designerTableNote } from '@/domain/bom'
import { finishBuild } from '@/domain/build'
import type { Plan } from '@/domain/schema/plan'
import type { Inventory } from '@/domain/schema/settings'
import { bomToCsvRows, toCsv, type BomCsvMode } from '@/lib/csv'
import { downloadBlob } from '@/lib/download'
import { useBom, usePlanLookup } from '@/state/derived'
import { adjustInventory, replaceInventory, useInventory } from '@/state/inventoryStore'
import { usePlanStore } from '@/state/planStore'
import { useSettings } from '@/state/settingsStore'
import { announce } from '../layout/announcer'
import { BomLineGroups, type LineContext } from './BomLineList'
import { FinishBuildDialog } from './FinishBuildDialog'
import {
  bomCsvFileName,
  bomSummary,
  gotItAddQty,
  gotItRemoveQty,
  groupByKind,
  isBomTab,
  isGotIt,
  linePacks,
  linesForTab,
  printPlate,
  finishBuildChanges,
  shoppingRows,
  summaryText,
  type BomTab,
  type LineGroup,
} from './bomView'

const TAB_LABELS: Record<BomTab, string> = {
  shopping: 'Shopping list',
  full: 'Full BOM',
  leftovers: 'Leftovers',
}

const EMPTY_TEXT: Record<BomTab, string> = {
  shopping: 'Nothing to get: everything this plan uses is in your rack or in your spares.',
  full: 'This plan has no parts yet. Add sections and mounts to see what it takes.',
  leftovers: 'No leftovers: everything you own is still used by this plan.',
}

/** What the last Finish build did, so it can be undone together with the spares it used. */
interface FinishedBuild {
  planId: string
  /** The plan right after finishing; Undo is offered while it is still the open plan. */
  plan: Plan
  changed: number
  /** Spares used up per line key. */
  consumed: Inventory
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

/** Spares used up: before minus after, per key. */
function consumedSpares(before: Inventory, after: Inventory): Inventory {
  const used: Inventory = {}
  for (const [key, qty] of Object.entries(before)) {
    const diff = qty - (after[key] ?? 0)
    if (diff > 0) used[key] = diff
  }
  return used
}

function addSpares(inventory: Inventory, extra: Inventory): Inventory {
  const merged: Inventory = { ...inventory }
  for (const [key, qty] of Object.entries(extra)) merged[key] = (merged[key] ?? 0) + qty
  return merged
}

/** One tab's lines, or what it means that there are none. */
function TabBody({
  tab,
  groups,
  context,
}: {
  tab: BomTab
  groups: readonly LineGroup[]
  context: LineContext
}) {
  if (groups.length === 0) {
    return (
      <p className="flex items-start gap-1.5 rounded-lg border border-dashed p-3 text-muted-foreground">
        <CircleCheck aria-hidden className="mt-px size-4 shrink-0" />
        {EMPTY_TEXT[tab]}
      </p>
    )
  }
  return (
    <>
      {tab === 'leftovers' ? (
        <p className="mb-2 text-xs text-muted-foreground">
          Parts you own that this plan no longer uses: keep them as spares or reuse them.
        </p>
      ) : null}
      <BomLineGroups tab={tab} groups={groups} context={context} />
    </>
  )
}

const PANEL_LABEL = 'Bill of materials'

export function BomPanel() {
  const plan = usePlanStore((state) => state.plan)
  const bom = useBom()
  if (plan === null || bom === undefined) {
    return (
      <section aria-label={PANEL_LABEL} className="p-3 text-sm text-muted-foreground">
        Open a plan to see what to print and buy.
      </section>
    )
  }
  return <BomContent plan={plan} bom={bom} />
}

function BomContent({ plan, bom }: { plan: Plan; bom: BomResult }) {
  const planId = usePlanStore((state) => state.planId)
  const readOnly = usePlanStore((state) => state.readOnly)
  const lookup = usePlanLookup()
  const settings = useSettings()
  const inventory = useInventory()
  const navigate = useNavigate()
  const [tab, setTab] = useState<BomTab>('shopping')
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set())
  // Writes in flight, checked synchronously so a double click never adds twice.
  const inFlight = useRef(new Set<string>())
  const startingRef = useRef(false)
  const [finishOpen, setFinishOpen] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [finished, setFinished] = useState<FinishedBuild | null>(null)
  const [startingIdea, setStartingIdea] = useState(false)

  const frame = lookup.frame(plan.frame.frameId)
  const summary = useMemo(() => bomSummary(bom, settings), [bom, settings])
  const note = useMemo(
    () => (frame === undefined ? undefined : designerTableNote(frame, plan)),
    [frame, plan],
  )
  const groups = useMemo(() => groupByKind(linesForTab(bom, tab)), [bom, tab])
  const packs = useMemo(
    () => new Map(bom.lines.map((line) => [line.key, linePacks(line, lookup, settings)])),
    [bom, lookup, settings],
  )
  const plates = useMemo(() => {
    const byKey = new Map<string, string>()
    for (const line of bom.lines) {
      const plate = printPlate(line, lookup)
      if (plate !== undefined) byKey.set(line.key, plate)
    }
    return byKey
  }, [bom, lookup])
  const includedBricks = useMemo(
    () => new Set(bom.lines.filter((line) => line.included === true).map((line) => line.refId)),
    [bom],
  )
  const leftovers = useMemo(() => linesForTab(bom, 'leftovers').length, [bom])
  // What Finish build would change, from a dry run (only while its dialog is open).
  const pending = useMemo(() => {
    if (!finishOpen || frame === undefined) return []
    const preview = finishBuild(plan, frame, nowIso(), lookup)
    return finishBuildChanges(plan, preview.plan, frame, lookup)
  }, [finishOpen, plan, frame, lookup])
  const unticked = useMemo(() => shoppingRows(bom).filter((line) => !isGotIt(line)).length, [bom])

  function setBusy(key: string, busy: boolean): void {
    setBusyKeys((current) => {
      const next = new Set(current)
      if (busy) next.add(key)
      else next.delete(key)
      return next
    })
  }

  async function toggleGotIt(line: BomLine, checked: boolean): Promise<void> {
    const amount = checked ? gotItAddQty(line) : gotItRemoveQty(line, inventory[line.key] ?? 0)
    if (amount <= 0 || inFlight.current.has(line.key)) return
    inFlight.current.add(line.key)
    setBusy(line.key, true)
    try {
      const left = await adjustInventory(line.key, checked ? amount : -amount)
      if (checked) {
        announce(`Got it: ${line.label}. ${amount} added to your spares.`)
      } else if (left >= line.install + line.spare) {
        announce(
          `${line.label}: ${amount} taken out of your spares; the ${left} left still cover it.`,
        )
      } else {
        announce(`${line.label} is back on the shopping list: ${amount} taken out of your spares.`)
      }
    } catch (error) {
      const text = `Could not update your spares: ${errorMessage(error)}`
      announce(text)
      toast.error(text)
    } finally {
      inFlight.current.delete(line.key)
      setBusy(line.key, false)
    }
  }

  async function startNextIdea(): Promise<void> {
    const store = usePlanStore.getState()
    const id = store.planId
    if (id === null || startingRef.current) return
    startingRef.current = true
    setStartingIdea(true)
    try {
      // The copy is made from the stored plan, so the finished build must be saved first.
      if (!(await store.flushSave())) throw new Error('this plan could not be saved first')
      const copy = await duplicatePlan(id, { sameRack: true, resetHave: false })
      toast.success(`Started “${copy.name}” from what you have built.`)
      await navigate(`/plan/${copy.id}`)
    } catch (error) {
      const text = `Could not start the next idea: ${errorMessage(error)}`
      announce(text)
      toast.error(text)
    } finally {
      startingRef.current = false
      setStartingIdea(false)
    }
  }

  async function confirmFinish(): Promise<void> {
    const store = usePlanStore.getState()
    const current = store.plan
    if (current === null || frame === undefined || finishing) return
    setFinishing(true)
    try {
      const before = computeBom(current, lookup, settings, inventory)
      const at = nowIso()
      let changed = 0
      const result = store.applyOp((draft) => {
        const built = finishBuild(draft, frame, at, lookup)
        changed = built.changed
        return { plan: built.plan }
      })
      const after = usePlanStore.getState().plan
      if (!result.applied || after === null) {
        const text = `Could not finish the build: ${result.error ?? 'nothing changed'}`
        announce(text)
        toast.error(text)
        return
      }
      setFinishOpen(false)
      if (after === current || changed === 0) {
        announce('Everything was already in your rack.')
        return
      }
      const remaining = consumeInventory(
        before,
        computeBom(after, lookup, settings, inventory),
        inventory,
      )
      try {
        await replaceInventory(remaining)
      } catch (error) {
        toast.error(
          `The build is finished, but your spares were not updated: ${errorMessage(error)}`,
        )
      }
      setFinished({
        planId: after.id,
        plan: after,
        changed,
        consumed: consumedSpares(inventory, remaining),
      })
      const text = `Build finished: ${plural(changed, 'item')} marked ${HAVE_TEXT}.`
      announce(`${text} You can now start the next idea from here.`)
      toast.success(text, {
        action: {
          label: 'Start the next idea from here',
          onClick: () => void startNextIdea(),
        },
      })
    } finally {
      setFinishing(false)
    }
  }

  async function undoFinish(): Promise<void> {
    const done = finished
    const store = usePlanStore.getState()
    if (done === null || store.plan !== done.plan) return
    store.undo()
    setFinished(null)
    try {
      await replaceInventory(addSpares(inventory, done.consumed))
      announce('Finish build undone: those parts are To get again and your spares are back.')
    } catch (error) {
      const text = `The plan is back, but your spares were not restored: ${errorMessage(error)}`
      announce(text)
      toast.error(text)
    }
  }

  async function exportCsv(): Promise<void> {
    const mode: BomCsvMode = tab === 'shopping' ? 'shopping' : 'full'
    const rows = bomToCsvRows(bom, {
      planName: plan.name,
      frameName: frame?.name ?? plan.frame.frameId,
      mode,
    })
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' })
    const what = mode === 'shopping' ? 'shopping list' : 'full BOM'
    try {
      const outcome = await downloadBlob(bomCsvFileName(plan.name, mode, new Date()), blob)
      if (outcome !== 'cancelled') announce(`Exported the ${what} as a CSV file.`)
    } catch (error) {
      const text = `Could not export the ${what}: ${errorMessage(error)}`
      announce(text)
      toast.error(text)
    }
  }

  const context: LineContext = {
    packs,
    plates,
    includedBricks,
    busy: busyKeys,
    onGotIt: (line, checked) => void toggleGotIt(line, checked),
  }
  const showFinished = finished !== null && finished.planId === planId
  const canUndoFinish = showFinished && finished.plan === plan

  return (
    <section
      aria-label={PANEL_LABEL}
      data-testid="bom-panel"
      className="@container flex min-w-0 flex-col gap-3 p-3 text-sm"
    >
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p
            data-testid="bom-summary"
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium"
          >
            {summary.lines === 0 ? (
              <CircleCheck aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <ShoppingCart aria-hidden className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0">{summaryText(summary)}</span>
          </p>
          <div className="flex flex-wrap gap-2 @xl:ml-auto">
            <Button
              size="sm"
              data-testid="bom-finish-build"
              // Without its frame in the catalog nothing can be captured as built.
              disabled={readOnly || frame === undefined}
              onClick={() => setFinishOpen(true)}
            >
              <PackageCheck aria-hidden />
              Finish build
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="bom-export-csv"
              onClick={() => void exportCsv()}
            >
              <Download aria-hidden />
              Export CSV
              <span className="sr-only">
                {tab === 'shopping' ? ' of the shopping list' : ' of the full BOM'}
              </span>
            </Button>
          </div>
        </div>
        {note === undefined ? null : (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>{note}.</span>
          </p>
        )}
      </header>

      {showFinished ? (
        <div
          data-testid="bom-finished"
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-2.5"
        >
          <p className="flex min-w-48 flex-1 items-center gap-1.5 font-medium">
            <CircleCheck aria-hidden className="size-4 shrink-0" />
            Build finished: {plural(finished.changed, 'item')} marked {HAVE_TEXT}.
          </p>
          <Button
            size="sm"
            data-testid="bom-next-idea"
            disabled={startingIdea}
            aria-busy={startingIdea || undefined}
            onClick={() => void startNextIdea()}
          >
            Start the next idea from here
          </Button>
          {canUndoFinish ? (
            <Button size="sm" variant="outline" onClick={() => void undoFinish()}>
              <Undo2 aria-hidden />
              Undo
            </Button>
          ) : null}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Dismiss"
            onClick={() => setFinished(null)}
          >
            <X aria-hidden />
          </Button>
        </div>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(value: unknown) => {
          if (isBomTab(value)) setTab(value)
        }}
      >
        <TabsList aria-label="Bill of materials views" className="w-full">
          <TabsTrigger value="shopping" data-testid="bom-tab-shopping">
            {TAB_LABELS.shopping}
            {summary.lines > 0 ? <span className="tabular-nums">({summary.lines})</span> : null}
          </TabsTrigger>
          <TabsTrigger value="full" data-testid="bom-tab-full">
            {TAB_LABELS.full}
          </TabsTrigger>
          <TabsTrigger value="leftovers" data-testid="bom-tab-leftovers">
            {TAB_LABELS.leftovers}
            {leftovers > 0 ? <span className="tabular-nums">({leftovers})</span> : null}
          </TabsTrigger>
        </TabsList>
        {(['shopping', 'full', 'leftovers'] as const).map((value) => (
          <TabsContent key={value} value={value} className="pt-1">
            {value === tab ? <TabBody tab={value} groups={groups} context={context} /> : null}
          </TabsContent>
        ))}
      </Tabs>

      {bom.warnings.length === 0 ? null : (
        <details className="rounded-lg border p-2.5 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            Not counted ({bom.warnings.length})
          </summary>
          <ul className="mt-1.5 grid list-disc gap-1 pl-4">
            {bom.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      )}

      <FinishBuildDialog
        open={finishOpen}
        onOpenChange={setFinishOpen}
        groups={pending}
        unticked={unticked}
        busy={finishing}
        onConfirm={() => void confirmFinish()}
      />
    </section>
  )
}
