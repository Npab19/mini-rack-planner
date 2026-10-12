/**
 * The Checks panel (M3a): problems with the plan grouped Errors / Warnings / Info, each with an
 * icon and words (never colour alone), and the power summary. A check that points at a part is a
 * button: it selects that part and switches the inspector to it. Announcements go to the shell's
 * live region (on small screens the shell closes this sheet once a check is chosen). Inside a
 * sheet, the sheet's title stands in for the panel heading.
 */
import {
  ChevronRight,
  CircleCheck,
  CircleX,
  Info,
  OctagonX,
  PlugZap,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { useId, useMemo } from 'react'
import type { Issue, IssueSeverity } from '@/domain/api'
import { powerSummary } from '@/domain/power'
import { cn } from '@/lib/utils'
import { usePlanLookup } from '@/state/derived'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { announce } from '../layout/announcer'
import { selectInEditor } from '../selection'
import { useEditorIssues } from './useEditorIssues'
import {
  countsText,
  groupIssues,
  powerRows,
  SEVERITY_WORDS,
  targetName,
  type IssueGroup,
  type PowerRow,
  type PowerStatus,
} from './checksView'

/** Icon and words carry the severity; the colour repeats it (also on the group heading). */
const SEVERITY_ICONS: Record<IssueSeverity, { icon: LucideIcon; className: string }> = {
  error: { icon: OctagonX, className: 'text-destructive' },
  warning: { icon: TriangleAlert, className: 'text-warning' },
  info: { icon: Info, className: 'text-info' },
}

const STATUS_ICONS: Record<PowerStatus, { icon: LucideIcon; className: string }> = {
  ok: { icon: CircleCheck, className: 'text-have' },
  short: { icon: CircleX, className: 'font-medium text-destructive' },
  note: { icon: Info, className: 'text-muted-foreground' },
}

/** "Error: " for screen readers, where the group heading is not read along. */
const SEVERITY_PREFIX: Record<IssueSeverity, string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Note',
}

function IssueRow({
  issue,
  selected,
  onSelect,
}: {
  issue: Issue
  selected: boolean
  onSelect: (issue: Issue) => void
}) {
  const { icon: Icon, className } = SEVERITY_ICONS[issue.severity]
  const content = (
    <>
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', className)} />
      <span className="min-w-0 flex-1 break-words">
        <span className="sr-only">{SEVERITY_PREFIX[issue.severity]}:</span> {issue.message}
      </span>
    </>
  )
  if (issue.targetId === undefined) {
    return (
      <li
        data-testid={`checks-item-${issue.code}`}
        data-severity={issue.severity}
        className="flex items-start gap-2 px-2 py-2"
      >
        {content}
      </li>
    )
  }
  return (
    <li>
      <button
        type="button"
        data-testid={`checks-item-${issue.code}`}
        data-severity={issue.severity}
        aria-current={selected || undefined}
        onClick={() => onSelect(issue)}
        className={cn(
          'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
          selected && 'bg-accent ring-1 ring-primary/40 hover:bg-accent',
        )}
      >
        {content}{' '}
        {/* On the selected row's tint, muted text would fall below 4.5:1: full contrast there. */}
        <span
          className={cn(
            'flex shrink-0 items-center gap-0.5 text-xs',
            selected ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
        >
          {selected ? 'Selected' : 'Show'}
          <ChevronRight aria-hidden className="size-3.5" />
        </span>
      </button>
    </li>
  )
}

function IssueGroupSection({
  group,
  selection,
  onSelect,
}: {
  group: IssueGroup
  selection: readonly string[]
  onSelect: (issue: Issue) => void
}) {
  const headingId = useId()
  const { icon: Icon, className } = SEVERITY_ICONS[group.severity]
  return (
    <section aria-labelledby={headingId} className="grid gap-1">
      <h3 id={headingId} className={cn('flex items-center gap-2 text-sm font-medium', className)}>
        <Icon aria-hidden className="size-4 shrink-0" />
        {SEVERITY_WORDS[group.severity].title}
        <span className="font-normal text-muted-foreground">({group.issues.length})</span>
      </h3>
      <ul className="grid gap-0.5">
        {group.issues.map((issue, index) => (
          <IssueRow
            key={`${issue.code}-${issue.targetId ?? ''}-${index}`}
            issue={issue}
            selected={issue.targetId !== undefined && selection.includes(issue.targetId)}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </section>
  )
}

function PowerSection({ rows }: { rows: readonly PowerRow[] }) {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      data-testid="checks-power"
      className="grid gap-2 rounded-lg border p-3"
    >
      <h3 id={headingId} className="flex items-center gap-2 text-sm font-medium">
        <PlugZap aria-hidden className="size-4 shrink-0 text-role-power" />
        Power
      </h3>
      <dl className="grid gap-2">
        {rows.map((row) => {
          const { icon: StatusIcon, className } = STATUS_ICONS[row.status]
          return (
            <div key={row.id} data-testid={`checks-power-${row.id}`} className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-medium tabular-nums">{row.value}</span>
                <span className={cn('inline-flex items-center gap-1 text-xs', className)}>
                  <StatusIcon aria-hidden className="size-3.5" />
                  {row.statusText}
                </span>
              </dd>
              {row.detail === undefined ? null : (
                <dd className="text-xs text-muted-foreground">{row.detail}</dd>
              )}
            </div>
          )
        })}
      </dl>
    </section>
  )
}

export function ChecksPanel() {
  const headingId = useId()
  const plan = usePlanStore((state) => state.plan)
  const issues = useEditorIssues()
  const lookup = usePlanLookup()
  const selection = useUiStore((state) => state.selection)

  const frame = plan === null ? undefined : lookup.frame(plan.frame.frameId)
  const groups = useMemo(() => groupIssues(issues), [issues])
  const power = useMemo(
    () => (plan === null ? undefined : powerRows(powerSummary(plan, lookup))),
    [plan, lookup],
  )

  function select(issue: Issue): void {
    const targetId = issue.targetId
    if (targetId === undefined) return
    // The rack turns to its face and scrolls it into view; the inspector shows it.
    selectInEditor([targetId])
    const name = plan === null ? undefined : targetName(plan, lookup, frame, targetId)
    announce(name === undefined ? 'Selected.' : `Selected ${name}.`)
  }

  return (
    <section
      aria-labelledby={headingId}
      data-testid="checks-panel"
      className="flex min-w-0 flex-col gap-3 p-3 text-sm"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-base font-semibold in-[[data-editor-sheet]]:hidden">
          Checks
        </h2>
        {plan === null ? null : (
          <p data-testid="checks-summary" className="text-xs text-muted-foreground">
            {countsText(groups)}
          </p>
        )}
      </header>
      {plan === null ? (
        <p className="text-muted-foreground">Open a plan to check it.</p>
      ) : (
        <>
          {groups.length === 0 ? (
            <p
              data-testid="checks-empty"
              className="flex items-center gap-2 rounded-lg border border-have-border bg-have-soft p-3"
            >
              <CircleCheck aria-hidden className="size-4 shrink-0 text-have" />
              No problems found
            </p>
          ) : (
            groups.map((group) => (
              <IssueGroupSection
                key={group.severity}
                group={group}
                selection={selection}
                onSelect={select}
              />
            ))
          )}
          {power === undefined ? null : <PowerSection rows={power} />}
        </>
      )}
    </section>
  )
}
