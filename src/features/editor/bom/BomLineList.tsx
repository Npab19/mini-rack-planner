/**
 * The BOM drawer's lines: one list per group (prints, hardware, equipment) with columns adapted
 * to the group and the tab, a "Got it" checkbox on shopping lines and a "Why" popover with the sum
 * and where every unit comes from. Colour repeats the words: what is still to get in the `need`
 * tone, ticked lines and spares in `have`, leftovers in `info`, and a role dot next to devices.
 */
import { CircleHelp, Cpu, Printer, Wrench, type LucideIcon } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import {
  HAVE_NEED_TEXT_CLASSES,
  HAVE_TEXT,
  HaveIcon,
  NEED_TEXT,
} from '@/components/common/HaveNeed'
import { RoleDot } from '@/components/common/PartRole'
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
import type { PartRole } from '@/domain/partRole'
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

/** Group icons in fixed categorical colours, the same in every accent. */
const KIND_ICONS: Record<BomLineKind, { icon: LucideIcon; className: string }> = {
  print: { icon: Printer, className: 'text-chart-1' },
  hardware: { icon: Wrench, className: 'text-chart-2' },
  device: { icon: Cpu, className: 'text-info' },
}

/** Ticked "Got it" boxes in the In my rack colour; unticked ones keep a To get outline. */
const GOT_IT_CHECKBOX =
  'border-need-border data-checked:border-have-border data-checked:bg-have data-checked:text-have-foreground dark:data-checked:bg-have'

export interface LineContext {
  /** Packs each hardware line's Buy is rounded to, by line key. */
  packs: ReadonlyMap<string, readonly PackCount[]>
  /** Designer plate names of print lines (when they differ from the label), by line key. */
  plates: ReadonlyMap<string, string>
  /** Device ids whose power brick ships in the box. */
  includedBricks: ReadonlySet<string>
  /** Line keys with a Got it change in flight (clicks are ignored meanwhile). */
  busy: ReadonlySet<string>
  /** What each device line is for (its role dot), by line key. */
  roles: ReadonlyMap<string, PartRole>
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
      <ProvenanceSection title={HAVE_TEXT} entries={view.owned} owned />
      {view.notes.length === 0 ? null : (
        <div className="grid gap-1 border-t pt-2">
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
  owned = false,
}: {
  title: string
  entries: ReadonlyArray<{ label: string; qty: number; detail?: string }>
  /** The In my rack part: its title in the have tone with its icon. */
  owned?: boolean
}) {
  if (entries.length === 0) return null
  return (
    <div className="grid gap-1 border-t pt-2">
      <p className={cn('flex items-center gap-1 text-xs font-medium', owned && 'text-have')}>
        {owned ? <HaveIcon aria-hidden className="size-3.5" /> : null}
        {title}
      </p>
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

function Fact({
  term,
  children,
  className,
}: {
  term: string
  children: ReactNode
  /** A tone for the value (amounts still to get); foreground otherwise. */
  className?: string | undefined
}) {
  return (
    <div className="flex gap-1">
      <dt>{term}</dt>
      <dd className={cn('font-medium text-foreground tabular-nums', className)}>{children}</dd>
    </div>
  )
}

/** The line's name, with a role dot for devices (the name always says what it is). */
function LineLabel({
  line,
  context,
  className,
}: {
  line: BomLine
  context: LineContext
  className?: string
}) {
  const role = context.roles.get(line.key)
  return (
    <p className={cn('font-medium break-words', className)}>
      {role === undefined ? null : <RoleDot role={role} className="mr-1.5 mb-px align-middle" />}
      {line.label}
    </p>
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
  // Amounts still to get in the To get tone; plain once ticked.
  const tone = gotIt ? undefined : HAVE_NEED_TEXT_CLASSES.need
  return (
    <li
      {...lineData(line)}
      data-got-it={gotIt}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 py-2.5"
    >
      <label
        className={cn(
          'flex w-12 cursor-pointer flex-col items-center gap-1 pt-0.5 text-[0.7rem] leading-none',
          gotIt ? 'font-medium text-have' : 'text-muted-foreground',
        )}
      >
        <Checkbox
          className={GOT_IT_CHECKBOX}
          data-testid={`bom-got-it-${line.key}`}
          aria-label={`Got it: ${line.label}`}
          checked={gotIt}
          aria-busy={busy || undefined}
          onCheckedChange={(checked) => context.onGotIt(line, checked)}
        />
        Got it
      </label>
      <div className="min-w-0">
        <LineLabel
          line={line}
          context={context}
          className={cn(gotIt && 'text-muted-foreground line-through decoration-2')}
        />
        <Facts>
          {line.kind === 'hardware' ? (
            <>
              <Fact term={NEED_TEXT} className={tone}>
                {neededText(line)}
              </Fact>
              {line.buy > 0 ? (
                <Fact term="Buy" className={tone}>
                  {buyText(line, packs)}
                </Fact>
              ) : null}
            </>
          ) : (
            <Fact term={line.kind === 'print' ? 'Make' : 'Get'} className={tone}>
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
          <p className="mt-0.5 flex items-center gap-1 text-xs font-medium text-have">
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
        <LineLabel line={line} context={context} />
        <Facts>
          <Fact term="In plan">{line.target}</Fact>
          <Fact
            term={HAVE_TEXT}
            className={line.asBuilt > 0 ? HAVE_NEED_TEXT_CLASSES.have : undefined}
          >
            {line.asBuilt}
          </Fact>
          {line.included ? (
            <Fact term="Included">ships with the device</Fact>
          ) : (
            <>
              <Fact
                term={NEED_TEXT}
                className={line.need > 0 ? HAVE_NEED_TEXT_CLASSES.need : undefined}
              >
                {line.kind === 'hardware' ? neededText(line) : line.install}
              </Fact>
              {line.kind === 'hardware' && line.buy > 0 ? (
                <Fact term="Buy" className={HAVE_NEED_TEXT_CLASSES.need}>
                  {buyText(line, packs)}
                </Fact>
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

function LeftoverRow({ line, context }: { line: BomLine; context: LineContext }) {
  return (
    <li
      {...lineData(line)}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 py-2.5"
    >
      <div className="min-w-0">
        <LineLabel line={line} context={context} />
        <Facts>
          <Fact term="Left over" className="text-info">
            {line.surplus}
          </Fact>
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
  const { icon: Icon, className } = KIND_ICONS[group.kind]
  return (
    <section aria-labelledby={headingId} className="grid">
      <h3 id={headingId} className="flex items-center gap-2 text-sm font-medium">
        <Icon aria-hidden className={cn('size-4 shrink-0', className)} />
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
              return <LeftoverRow key={line.key} line={line} context={context} />
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
