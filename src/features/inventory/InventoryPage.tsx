/**
 * On hand (/inventory): the loose hardware you own that is not in a rack, part by part, with a
 * count you can type or step. Every plan's shopping list subtracts these counts before it buys
 * anything; ticking Got it on a shopping list adds to them and Finish build uses them up. The
 * page lists every hardware part of the catalog and My parts by category (search, and "Only what
 * I have"), what each saved plan still needs of a part and buys after what is on hand, and the
 * printed parts and equipment on hand.
 *
 * The counts follow the database live (Got it in another tab shows up here). Rows changed on this
 * visit stay listed at 0 until the filter or search changes, so nothing jumps away under the
 * pointer. Saves show "Saved" in a status line that also tells screen readers what changed.
 * Colour repeats the words: a check and the In my rack colour for parts you have, the To get
 * colour (dashed icon) for what a plan still buys.
 */
import {
  Bolt,
  Boxes,
  Cable,
  Check,
  Columns2,
  Cuboid,
  Cylinder,
  Disc,
  Hexagon,
  Magnet,
  Package,
  PackageCheck,
  PackageOpen,
  Ruler,
  Search,
  Square,
  Torus,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { useDeferredValue, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { HaveIcon, NeedIcon } from '@/components/common/HaveNeed'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { errorMessage } from '@/db/errors'
import type { HardwareCategory } from '@/domain/schema/catalog'
import { useSaveStatus, type SaveState } from '@/features/settings/useSaveStatus'
import { cn } from '@/lib/utils'
import { useCatalog } from '@/state/catalogStore'
import { adjustInventory, setInventoryQty, useInventoryView } from '@/state/inventoryStore'
import { useSettings } from '@/state/settingsStore'
import {
  filterGroups,
  hardwareGroups,
  onHandTotals,
  otherRows,
  quantityWithUnit,
  rowCount,
  totalsText,
  type HardwareGroup,
  type HardwareRow,
  type OtherRow,
  type PlanNeed,
} from './inventoryModel'
import { OnHandField } from './OnHandField'
import { usePlanNeeds, useSavedPlans } from './usePlanNeeds'

/** Category icons: decoration next to the heading, in the hardware colour of the BOM. */
const GROUP_ICONS: Readonly<Record<HardwareCategory, LucideIcon>> = {
  screw: Bolt,
  nut: Hexagon,
  insert: Cylinder,
  'cage-nut': Square,
  't-nut': Cuboid,
  washer: Torus,
  magnet: Magnet,
  foot: Disc,
  standoff: Columns2,
  extrusion: Ruler,
  'cable-tie': Cable,
  other: Package,
}

/** Plans listed under a part before "and N more". */
const PLANS_SHOWN = 3

const LINK_CLASS =
  'rounded-sm font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50'

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

// ---------------------------------------------------------------------------------------------
// Saving

interface OnHandSaver {
  state: SaveState
  /** What the last save changed, read after "Saved" by screen readers. */
  detail: string
  set: (key: string, label: string, unit: OtherRow['unit'], qty: number) => Promise<boolean>
  step: (key: string, label: string, unit: OtherRow['unit'], delta: number) => void
  remove: (row: OtherRow) => Promise<boolean>
}

function useOnHandSaver(touch: (key: string) => void): OnHandSaver {
  const status = useSaveStatus('Could not save what you have on hand')
  const [detail, setDetail] = useState('')
  return {
    state: status.state,
    detail,
    set: (key, label, unit, qty) => {
      touch(key)
      setDetail(`${label}, ${quantityWithUnit(qty, unit)} on hand`)
      return status.track(() => setInventoryQty(key, qty))
    },
    step: (key, label, unit, delta) => {
      touch(key)
      void status.track(async () => {
        const next = await adjustInventory(key, delta)
        setDetail(`${label}, ${quantityWithUnit(next, unit)} on hand`)
      })
    },
    remove: (row) => {
      setDetail(`${row.label} removed from on hand`)
      return status.track(() => setInventoryQty(row.key, 0))
    },
  }
}

/**
 * "Saved" after a change, with what changed for screen readers. Always rendered, so the live
 * region exists before its text changes.
 */
function OnHandStatus({ state, detail }: { state: SaveState; detail: string }) {
  return (
    <p
      role="status"
      data-testid="on-hand-status"
      className="flex min-h-5 items-center gap-1 text-xs text-muted-foreground"
    >
      {state.kind === 'saved' ? (
        <>
          <Check aria-hidden="true" className="size-3.5 text-have" />
          Saved
          {detail === '' ? null : <span className="sr-only">: {detail}.</span>}
        </>
      ) : null}
      {state.kind === 'error' ? (
        <>
          <TriangleAlert aria-hidden="true" className="size-3.5 text-destructive" />
          <span className="text-destructive">Not saved</span>
          <span className="sr-only">: {state.message}</span>
        </>
      ) : null}
    </p>
  )
}

// ---------------------------------------------------------------------------------------------
// Rows

/** "Sample: KWS 9U → 12U needs 40, buy 25" per plan; the plan's name opens it. */
function PlanNeeds({ row }: { row: HardwareRow }) {
  const shown = row.plans.slice(0, PLANS_SHOWN)
  const more = row.plans.length - shown.length
  return (
    <ul
      aria-label={`Plans that use ${row.label}`}
      data-testid={`on-hand-plans-${row.key}`}
      className="mt-1.5 grid gap-1 text-xs"
    >
      {shown.map((need: PlanNeed) => (
        <li key={need.planId} className="flex min-w-0 items-start gap-1.5">
          {need.buy > 0 ? (
            <NeedIcon aria-hidden className="mt-px size-3.5 shrink-0 text-need" />
          ) : (
            <HaveIcon aria-hidden className="mt-px size-3.5 shrink-0 text-have" />
          )}
          <span className="min-w-0 break-words">
            <Link to={`/plan/${need.planId}`} className={LINK_CLASS}>
              {need.planName}
            </Link>{' '}
            <span className="text-muted-foreground">needs {need.toGet},</span>{' '}
            {need.buy > 0 ? (
              <span className="font-medium text-need">buy {need.buy}</span>
            ) : (
              <span className="font-medium text-have">covered</span>
            )}
          </span>
        </li>
      ))}
      {more > 0 ? (
        <li className="pl-5 text-muted-foreground">and {plural(more, 'more plan')}</li>
      ) : null}
    </ul>
  )
}

function HardwareRowItem({ row, saver }: { row: HardwareRow; saver: OnHandSaver }) {
  const have = row.qty > 0
  return (
    <li
      data-testid={`on-hand-row-${row.key}`}
      data-qty={row.qty}
      className={cn(
        'grid gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center',
        have && 'bg-have-soft/45 dark:bg-have-soft/35',
      )}
    >
      <div className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2">
        {have ? <HaveIcon aria-hidden className="mt-0.5 size-4 text-have" /> : <span aria-hidden />}
        <div className="min-w-0">
          <p className="font-medium break-words">
            {row.label}
            {row.custom ? (
              <Badge variant="outline" className="ml-2 align-middle">
                My part
              </Badge>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">{row.details}</p>
          {row.plans.length === 0 ? null : <PlanNeeds row={row} />}
        </div>
      </div>
      <OnHandField
        name={row.label}
        value={row.qty}
        unit={row.unit}
        testId={`on-hand-qty-${row.key}`}
        className="justify-self-end"
        onSet={(qty) => saver.set(row.key, row.label, row.unit, qty)}
        onStep={(delta) => saver.step(row.key, row.label, row.unit, delta)}
      />
    </li>
  )
}

function HardwareGroupSection({ group, saver }: { group: HardwareGroup; saver: OnHandSaver }) {
  const headingId = useId()
  const Icon = GROUP_ICONS[group.id]
  const have = group.rows.filter((row) => row.qty > 0).length
  return (
    <section
      aria-labelledby={headingId}
      data-testid={`on-hand-group-${group.id}`}
      className="overflow-hidden rounded-xl bg-card text-sm ring-1 ring-foreground/10"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-3">
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-chart-2"
        >
          <Icon className="size-4" />
        </span>
        <h2 id={headingId} className="text-base font-medium">
          {group.title}{' '}
          <span className="text-sm font-normal text-muted-foreground">({group.rows.length})</span>
        </h2>
        {have > 0 ? (
          <Badge variant="have" className="ml-auto">
            <HaveIcon aria-hidden />
            {plural(have, 'kind')} on hand
          </Badge>
        ) : null}
      </header>
      <ul className="divide-y">
        {group.rows.map((row) => (
          <HardwareRowItem key={row.key} row={row} saver={saver} />
        ))}
      </ul>
    </section>
  )
}

function OtherSection({
  rows,
  saver,
  onRemoved,
}: {
  rows: readonly OtherRow[]
  saver: OnHandSaver
  onRemoved: (row: OtherRow) => void
}) {
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)

  async function remove(row: OtherRow): Promise<void> {
    const before = row.qty
    if (!(await saver.remove(row))) return
    onRemoved(row)
    headingRef.current?.focus()
    toast.success(`Removed ${row.label} from on hand.`, {
      action: {
        label: 'Undo',
        onClick: () => {
          setInventoryQty(row.key, before).catch((error: unknown) => {
            toast.error(`Could not put it back: ${errorMessage(error)}`)
          })
        },
      },
    })
  }

  return (
    <section
      id="other-parts"
      aria-labelledby={headingId}
      data-testid="on-hand-other"
      className="overflow-hidden rounded-xl bg-card text-sm ring-1 ring-foreground/10"
    >
      <header className="grid gap-1 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-chart-1"
          >
            <Boxes className="size-4" />
          </span>
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="text-base font-medium outline-none"
          >
            Printed parts and equipment{' '}
            <span className="text-sm font-normal text-muted-foreground">({rows.length})</span>
          </h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Other loose parts: kept as spare when they left a plan, or ticked Got it on a shopping
          list. Shopping lists use them first, like hardware.
        </p>
      </header>
      <ul className="divide-y">
        {rows.map((row) => (
          <li
            key={row.key}
            data-testid={`on-hand-row-${row.key}`}
            data-qty={row.qty}
            className="grid gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div className="min-w-0">
              <p className="font-medium break-words">{row.label}</p>
              <p className="text-xs text-muted-foreground">{row.kindLabel}</p>
            </div>
            <div className="flex items-start gap-1 justify-self-end">
              <OnHandField
                name={row.label}
                value={row.qty}
                unit={row.unit}
                testId={`on-hand-qty-${row.key}`}
                onSet={(qty) => saver.set(row.key, row.label, row.unit, qty)}
                onStep={(delta) => saver.step(row.key, row.label, row.unit, delta)}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove from on hand: ${row.label}`}
                className="text-muted-foreground hover:text-destructive"
                disabled={row.qty <= 0}
                focusableWhenDisabled
                onClick={() => void remove(row)}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------
// Page

function StartHere() {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      data-testid="on-hand-start"
      className="grid gap-2 rounded-xl border border-dashed border-primary/50 bg-accent/30 p-4 text-sm sm:p-5"
    >
      <h2 id={headingId} className="flex items-center gap-2 text-base font-medium">
        <PackageOpen aria-hidden className="size-5 shrink-0 text-primary" />
        Count what you already have
      </h2>
      <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
        <li>
          <span className="text-foreground">Type how many</span> of each part you have in the list
          below, or use − and +.
        </li>
        <li>
          Or tick <span className="text-foreground">Got it</span> on a plan’s shopping list when
          parts arrive: they are added here.
        </li>
        <li>Every shopping list then only buys what is missing.</li>
      </ul>
    </section>
  )
}

function LoadingRows() {
  return (
    <div role="status" className="grid gap-4">
      <span className="sr-only">Loading what you have on hand…</span>
      {[0, 1].map((index) => (
        <Skeleton key={index} className="h-48 rounded-xl" />
      ))}
    </div>
  )
}

export function InventoryPage() {
  const { lookup } = useCatalog()
  const settings = useSettings()
  const { inventory, loaded } = useInventoryView()
  const plans = useSavedPlans()
  const needs = usePlanNeeds(plans, lookup, settings, inventory)
  const searchId = useId()
  const switchId = useId()

  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [keep, setKeep] = useState<ReadonlySet<string>>(() => new Set())
  // Decided once, when the counts first arrive: on when something is on hand. It must not flip
  // while counts are typed.
  const [onlyChoice, setOnlyChoice] = useState<boolean | null>(null)
  const [startedEmpty, setStartedEmpty] = useState<boolean | null>(null)

  const totals = useMemo(() => onHandTotals(inventory, lookup), [inventory, lookup])
  if (loaded && onlyChoice === null) {
    setOnlyChoice(totals.kinds > 0)
    setStartedEmpty(totals.kinds + totals.other === 0)
  }
  const onlyOnHand = onlyChoice ?? false

  const touch = (key: string): void => {
    setKeep((current) => (current.has(key) ? current : new Set([...current, key])))
  }
  const saver = useOnHandSaver(touch)

  const groups = useMemo(
    () => hardwareGroups({ hardware: lookup.allHardware(), inventory, needs }),
    [lookup, inventory, needs],
  )
  const shown = useMemo(
    () => filterGroups(groups, { query: deferredQuery, onlyOnHand, keep }),
    [groups, deferredQuery, onlyOnHand, keep],
  )
  const others = useMemo(
    () => otherRows(inventory, lookup, needs.lines, keep),
    [inventory, lookup, needs, keep],
  )

  function changeQuery(next: string): void {
    setQuery(next)
    setKeep(new Set())
  }

  function changeOnly(next: boolean): void {
    setOnlyChoice(next)
    setKeep(new Set())
  }

  function forget(row: OtherRow): void {
    setKeep((current) => new Set([...current].filter((key) => key !== row.key)))
  }

  const trimmed = deferredQuery.trim()
  const total = rowCount(groups)
  const count = rowCount(shown)
  const countText =
    trimmed === '' && !onlyOnHand
      ? plural(total, 'part')
      : `Showing ${count} of ${plural(total, 'part')}`

  let list
  if (!loaded) {
    list = <LoadingRows />
  } else if (shown.length === 0) {
    list = (
      <div className="grid justify-items-start gap-2 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
        <p>
          {trimmed === ''
            ? 'You have no hardware on hand.'
            : onlyOnHand
              ? `No hardware on hand matches “${trimmed}”.`
              : `No part matches “${trimmed}”.`}
        </p>
        {onlyOnHand ? (
          <Button variant="outline" size="sm" onClick={() => changeOnly(false)}>
            Show all hardware
          </Button>
        ) : null}
      </div>
    )
  } else {
    list = shown.map((group) => <HardwareGroupSection key={group.id} group={group} saver={saver} />)
  }

  return (
    <div className="mx-auto flex w-full max-w-screen-lg flex-col gap-5 px-4 py-6 sm:px-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Hardware on hand</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Loose hardware you own that is not installed in a rack. Every shopping list subtracts it;
          ticking Got it adds to it and Finish build uses it.
        </p>
      </header>

      {startedEmpty === true ? <StartHere /> : null}

      <div className="grid gap-3 rounded-xl bg-card p-3 text-sm ring-1 ring-foreground/10 sm:p-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p
            data-testid="on-hand-totals"
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
              totals.kinds > 0
                ? 'border-have-border bg-have-soft text-have'
                : 'border-dashed text-muted-foreground',
            )}
          >
            <PackageCheck aria-hidden className="size-3.5 shrink-0" />
            {totals.kinds > 0 ? totalsText(totals) : 'No hardware on hand yet'}
          </p>
          {totals.other > 0 ? (
            <a
              href="#other-parts"
              className="text-xs text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              + {plural(totals.other, 'printed part or device', 'printed parts and devices')}
            </a>
          ) : null}
          <div className="ml-auto">
            <OnHandStatus state={saver.state} detail={saver.detail} />
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <label htmlFor={searchId} className="sr-only">
              Search hardware
            </label>
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={searchId}
              type="search"
              value={query}
              placeholder="Search hardware, e.g. M5 insert…"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => changeQuery(event.target.value)}
              className="pl-8"
            />
          </div>
          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm font-medium select-none">
            <Switch
              checked={onlyOnHand}
              disabled={!loaded}
              aria-labelledby={switchId}
              data-testid="on-hand-only"
              onCheckedChange={(checked) => changeOnly(checked)}
            />
            <span id={switchId}>Only what I have</span>
          </label>
          <p role="status" className="text-xs text-muted-foreground sm:ml-auto">
            {loaded ? countText : ''}
          </p>
        </div>
      </div>

      {list}

      {loaded && others.length > 0 ? (
        <OtherSection rows={others} saver={saver} onRemoved={forget} />
      ) : null}
    </div>
  )
}
