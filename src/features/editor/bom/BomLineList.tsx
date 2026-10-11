/**
 * The BOM drawer's lines: one list per group (prints, hardware, equipment) with columns adapted
 * to the group and the tab, a "Got it" checkbox on shopping lines and a "Why" popover with the sum
 * and where every unit comes from.
 */
import { CircleHelp, Cpu, Printer, Wrench, type LucideIcon } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { HAVE_TEXT, HaveIcon, NEED_TEXT } from '@/components/common/HaveNeed'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { BomLine, BomLineKind } from '@/domain/api'
import type { PackCount } from '@/domain/bom'
import { cn } from '@/lib/utils'
import {
  buyText,
  formatDuration,
  formatGrams,
  GROUP_TITLES,
  isGotIt,
  neededText,
  provenanceView,
  quantityText,
  type BomTab,
  type LineGroup,
} from './bomView'

const KIND_ICONS: Record<BomLineKind, LucideIcon> = {
  print: Printer,
  hardware: Wrench,
  device: Cpu,
}

export interface LineContext {
  /** Packs each hardware line's Buy is rounded to, by line key. */
  packs: ReadonlyMap<string, readonly PackCount[]>
  /** Designer plate names of print lines (when they differ from the label), by line key. */
  plates: ReadonlyMap<string, string>
  /** Device ids whose power brick ships in the box. */
  includedBricks: ReadonlySet<string>
  /** Line keys with a Got it change in flight (clicks are ignored meanwhile). */
  busy: ReadonlySet<string>
  onGotIt: (line: BomLine, checked: boolean) => void
}

// ---------------------------------------------------------------------------------------------
// Why

/** The popover body: built only while the popover is open. */
function WhyDetails({ line }: { line: BomLine }) {
  const view = provenanceView(line)
  return (
    <>
      <PopoverHeader>
        <PopoverTitle>{line.label}</PopoverTitle>
        <PopoverDescription className="text-foreground">{line.why}</PopoverDescription>
      </PopoverHeader>
      <ProvenanceSection title="In the plan" entries={view.planned} />
      <ProvenanceSection title={HAVE_TEXT} entries={view.owned} />
      {view.notes.length === 0 ? null : (
        <div className="grid gap-1">
          <p className="text-xs font-medium">Notes</p>
          <ul className="grid gap-1 text-xs text-muted-foreground">
            {view.notes.map((note, index) => (
              <li key={`${note.label}-${index}`}>
                <span className="font-medium text-foreground">{note.label}:</span>{' '}
                {note.detail ?? ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

function WhyButton({ line }: { line: BomLine }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Why: ${line.label}`}
            data-testid={`bom-why-${line.key}`}
            className="text-muted-foreground"
          />
        }
      >
        <CircleHelp aria-hidden />
        Why
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[min(28rem,70vh)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        <WhyDetails line={line} />
      </PopoverContent>
    </Popover>
  )
}

function ProvenanceSection({
  title,
  entries,
}: {
  title: string
  entries: ReadonlyArray<{ label: string; qty: number; detail?: string }>
}) {
  if (entries.length === 0) return null
  return (
    <div className="grid gap-1">
      <p className="text-xs font-medium">{title}</p>
      <ul className="grid gap-1 text-xs">
        {entries.map((entry, index) => (
          <li
            key={`${entry.label}-${index}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2"
          >
            <span className="min-w-0 break-words">
              {entry.label}
              {entry.detail === undefined ? null : (
                <span className="block text-muted-foreground">{entry.detail}</span>
              )}
            </span>
            <span className="font-medium tabular-nums">{entry.qty}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Rows

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex gap-1">
      <dt>{term}</dt>
      <dd className="font-medium text-foreground tabular-nums">{children}</dd>
    </div>
  )
}

function Facts({ children }: { children: ReactNode }) {
  return (
    <dl className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
      {children}
    </dl>
  )
}

function lineData(line: BomLine) {
  return {
    'data-testid': `bom-line-${line.key}`,
    'data-need': line.need,
    'data-install': line.install,
    'data-spare': line.spare,
    'data-buy': line.buy,
  }
}

/** Prints and devices on the shopping list: what is still to make or get (all of it once ticked). */
function shoppingCount(line: BomLine): number {
  return isGotIt(line) ? line.install : line.need
}

function PlateFact({ line, context }: { line: BomLine; context: LineContext }) {
  const plate = context.plates.get(line.key)
  return plate === undefined ? null : <Fact term="Plate">{plate}</Fact>
}

function PrintFacts({ line, count }: { line: BomLine; count: number }) {
  return (
    <>
      {line.material === undefined ? null : <Fact term="Material">{line.material}</Fact>}
      {line.gramsEach === undefined ? null : (
        <Fact term="Filament">{formatGrams(count * line.gramsEach)}</Fact>
      )}
      {line.minutesEach === undefined ? null : (
        <Fact term="Time">{formatDuration(count * line.minutesEach)}</Fact>
      )}
    </>
  )
}

function ShoppingRow({ line, context }: { line: BomLine; context: LineContext }) {
  const gotIt = isGotIt(line)
  const busy = context.busy.has(line.key)
  const count = shoppingCount(line)
  const packs = context.packs.get(line.key) ?? []
  const covered = line.install - line.need
  return (
    <li
      {...lineData(line)}
      data-got-it={gotIt}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 py-2.5"
    >
      <label className="flex w-12 cursor-pointer flex-col items-center gap-1 pt-0.5 text-[0.7rem] leading-none text-muted-foreground">
        <Checkbox
          data-testid={`bom-got-it-${line.key}`}
          aria-label={`Got it: ${line.label}`}
          checked={gotIt}
          aria-busy={busy || undefined}
          onCheckedChange={(checked) => context.onGotIt(line, checked)}
        />
        Got it
      </label>
      <div className="min-w-0">
        <p
          className={cn(
            'font-medium break-words',
            gotIt && 'text-muted-foreground line-through decoration-2',
          )}
        >
          {line.label}
        </p>
        <Facts>
          {line.kind === 'hardware' ? (
            <>
              <Fact term={NEED_TEXT}>{neededText(line)}</Fact>
              {line.buy > 0 ? <Fact term="Buy">{buyText(line, packs)}</Fact> : null}
            </>
          ) : (
            <Fact term={line.kind === 'print' ? 'Make' : 'Get'}>
              {line.kind === 'print' ? quantityText(count, line.unit) : count}
            </Fact>
          )}
          {line.kind === 'print' ? (
            <>
              <PrintFacts line={line} count={count} />
              <PlateFact line={line} context={context} />
            </>
          ) : null}
          {line.kind === 'device' && context.includedBricks.has(line.refId) ? (
            <Fact term="Power brick">included</Fact>
          ) : null}
        </Facts>
        {gotIt ? (
          <p className="mt-0.5 flex items-center gap-1 text-xs">
            <HaveIcon aria-hidden className="size-3.5" />
            Covered by your spares
          </p>
        ) : covered > 0 && line.kind !== 'hardware' ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{covered} already in your spares</p>
        ) : null}
      </div>
      <WhyButton line={line} />
    </li>
  )
}

function FullRow({ line, context }: { line: BomLine; context: LineContext }) {
  const packs = context.packs.get(line.key) ?? []
  return (
    <li
      {...lineData(line)}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 py-2.5"
    >
      <div className="min-w-0">
        <p className="font-medium break-words">{line.label}</p>
        <Facts>
          <Fact term="In plan">{line.target}</Fact>
          <Fact term={HAVE_TEXT}>{line.asBuilt}</Fact>
          {line.included ? (
            <Fact term="Included">ships with the device</Fact>
          ) : (
            <>
              <Fact term={NEED_TEXT}>
                {line.kind === 'hardware' ? neededText(line) : line.install}
              </Fact>
              {line.kind === 'hardware' && line.buy > 0 ? (
                <Fact term="Buy">{buyText(line, packs)}</Fact>
              ) : null}
            </>
          )}
          {line.kind === 'print' ? (
            <>
              <PlateFact line={line} context={context} />
              {line.material === undefined ? null : <Fact term="Material">{line.material}</Fact>}
              {line.gramsEach === undefined && line.minutesEach === undefined ? null : (
                <Fact term="Each">
                  {[
                    line.gramsEach === undefined ? undefined : formatGrams(line.gramsEach),
                    line.minutesEach === undefined ? undefined : formatDuration(line.minutesEach),
                  ]
                    .filter((part) => part !== undefined)
                    .join(' · ')}
                </Fact>
              )}
            </>
          ) : null}
        </Facts>
      </div>
      <WhyButton line={line} />
    </li>
  )
}

function LeftoverRow({ line }: { line: BomLine }) {
  return (
    <li
      {...lineData(line)}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 py-2.5"
    >
      <div className="min-w-0">
        <p className="font-medium break-words">{line.label}</p>
        <Facts>
          <Fact term="Left over">{line.surplus}</Fact>
          <Fact term="In plan">{line.target}</Fact>
          <Fact term={HAVE_TEXT}>{line.asBuilt}</Fact>
        </Facts>
      </div>
      <WhyButton line={line} />
    </li>
  )
}

// ---------------------------------------------------------------------------------------------
// Groups

function LineGroupSection({
  tab,
  group,
  context,
}: {
  tab: BomTab
  group: LineGroup
  context: LineContext
}) {
  const headingId = useId()
  const Icon = KIND_ICONS[group.kind]
  return (
    <section aria-labelledby={headingId} className="grid">
      <h3 id={headingId} className="flex items-center gap-2 text-sm font-medium">
        <Icon aria-hidden className="size-4 shrink-0" />
        {GROUP_TITLES[tab][group.kind]}
        <span className="font-normal text-muted-foreground">({group.lines.length})</span>
      </h3>
      <ul className="divide-y">
        {group.lines.map((line) => {
          switch (tab) {
            case 'shopping':
              return <ShoppingRow key={line.key} line={line} context={context} />
            case 'full':
              return <FullRow key={line.key} line={line} context={context} />
            case 'leftovers':
              return <LeftoverRow key={line.key} line={line} />
          }
        })}
      </ul>
    </section>
  )
}

export function BomLineGroups({
  tab,
  groups,
  context,
}: {
  tab: BomTab
  groups: readonly LineGroup[]
  context: LineContext
}) {
  return (
    <div className="grid items-start gap-x-6 gap-y-4 @3xl:grid-cols-2 @6xl:grid-cols-3">
      {groups.map((group) => (
        <LineGroupSection key={group.kind} tab={tab} group={group} context={context} />
      ))}
    </div>
  )
}
