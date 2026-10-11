/**
 * The Rack tab's stack editor: the sections top -> bottom as on the rack, each with In my rack /
 * To get, move up / down, split, merge, and remove (planned) or retire (owned), plus "Add 3U / 6U"
 * on top or at the bottom. Every change is one undo step; conflicts open the conflict dialog.
 * Focus stays on the row a button belonged to after the list re-renders.
 */
import { Archive, ArrowDown, ArrowUp, Merge, Plus, Scissors, X } from 'lucide-react'
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { HAVE_TEXT, NEED_TEXT } from '@/components/common/HaveNeed'
import { HaveNeedToggle } from '@/components/common/HaveNeedToggle'
import { Button } from '@/components/ui/button'
import { markSection } from '@/domain/frame'
import { formatU, uToSixths } from '@/domain/geometry'
import type { Frame, SectionType } from '@/domain/schema/catalog'
import { cn } from '@/lib/utils'
import { sectionSummaryText } from '@/state/derived'
import { applyPlanOp, nowIso, sparesText, type SpareContext } from './planOps'
import {
  insertSectionRequest,
  mergeSectionsRequest,
  moveSectionRequest,
  removeSectionRequest,
  retireSectionRequest,
  splitSectionRequest,
  type StackOpRequest,
} from './sectionOps'
import { mergeChoices, splitChoice, stackHeightU, stackRows, type StackRow } from './stackModel'
import type { OpenPlan } from './useOpenPlan'
import type { StackOps } from './useStackOps'

export interface StackEditorProps {
  open: OpenPlan & { frame: Frame }
  ops: StackOps
  spares: SpareContext
  announce: (text: string) => void
  /** Selects a section (its row's title). */
  onPick: (ids: readonly string[]) => void
}

function typeHeightU(type: SectionType): number {
  return typeof type.heightU === 'number' ? type.heightU : type.heightU.min
}

function addLabel(type: SectionType): string {
  return typeof type.heightU === 'number' ? formatU(uToSixths(type.heightU)) : type.label
}

export function StackEditor({ open, ops, spares, announce, onPick }: StackEditorProps) {
  const { plan, frame, lookup, readOnly, recording } = open
  const headingId = useId()
  const rows = useMemo(() => stackRows(plan, frame), [plan, frame])
  const topDown = useMemo(() => rows.toReversed(), [rows])
  const totalU = stackHeightU(rows)
  const [error, setError] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const controls = useRef(new Map<string, HTMLElement>())
  /** Controls to try focusing after the next render (a moved or removed row's button went away). */
  const focusNext = useRef<string[] | null>(null)
  const context = { frame, lookup }

  useLayoutEffect(() => {
    const wanted = focusNext.current
    if (wanted === null) return
    focusNext.current = null
    for (const key of wanted) {
      const element = controls.current.get(key)
      if (element !== undefined && !element.hasAttribute('disabled')) {
        element.focus()
        return
      }
    }
    headingRef.current?.focus()
  })

  function register(key: string) {
    return (element: HTMLElement | null) => {
      if (element === null) controls.current.delete(key)
      else controls.current.set(key, element)
    }
  }

  function run(request: StackOpRequest, focusKeys: string[]): void {
    setError(null)
    const outcome = ops.run(request)
    if (outcome.status === 'applied') focusNext.current = focusKeys
    else if (outcome.status === 'error') setError(outcome.message)
  }

  function mark(row: StackRow, have: boolean): void {
    setError(null)
    const outcome = applyPlanOp(
      (current) => markSection(current, row.sectionId, have, nowIso(), frame),
      spares,
    )
    if (outcome.applied) {
      announce(`${row.name}: ${have ? HAVE_TEXT : NEED_TEXT}.${sparesText(outcome.sparesUsed)}`)
    } else {
      setError(outcome.error ?? `${row.name} could not be marked.`)
    }
  }

  function neighbourKeys(row: StackRow): string[] {
    const index = topDown.findIndex((candidate) => candidate.sectionId === row.sectionId)
    const neighbour = topDown[index + 1] ?? topDown[index - 1]
    return neighbour === undefined ? ['add:top:0'] : [`${neighbour.sectionId}:title`]
  }

  function addButtons(at: 'top' | 'bottom') {
    return (
      <div
        role="group"
        aria-label={at === 'top' ? 'Add a section on top' : 'Add a section at the bottom'}
        className="flex flex-wrap gap-1.5"
      >
        {frame.sectionTypes.map((type, index) => (
          <Button
            key={type.id}
            ref={register(`add:${at}:${index}`)}
            type="button"
            variant="outline"
            size="sm"
            disabled={readOnly || totalU + typeHeightU(type) > frame.stack.maxU}
            onClick={() =>
              run(insertSectionRequest(context, type, at, recording), [`add:${at}:${index}`])
            }
          >
            <Plus aria-hidden />
            {addLabel(type)} {at === 'top' ? 'on top' : 'at the bottom'}
          </Button>
        ))}
      </div>
    )
  }

  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="rounded-sm text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Sections <span className="font-normal text-muted-foreground">(top to bottom)</span>
        </h3>
        <p className="text-sm text-muted-foreground" data-testid="stack-summary">
          {sectionSummaryText(rows.map((row) => row.heightU))}
        </p>
      </div>

      {addButtons('top')}
      {topDown.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-center text-sm text-muted-foreground">
          No sections yet. Add one to start the rack.
        </p>
      ) : (
        <ol aria-label="Sections, top to bottom" className="grid gap-1.5">
          {topDown.map((row, position) => {
            const isTop = position === 0
            const isBottom = position === topDown.length - 1
            const split = splitChoice(frame, row)
            const merges = mergeChoices(frame, rows, row)
            return (
              <li
                key={row.sectionId}
                data-testid={`stack-row-${row.sectionId}`}
                data-have={row.have}
                className={cn(
                  'grid gap-2 rounded-lg border bg-card p-2',
                  !row.have && 'border-dashed border-foreground/30',
                )}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <button
                    ref={register(`${row.sectionId}:title`)}
                    type="button"
                    className="min-w-28 flex-1 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    aria-label={`Select ${row.name}`}
                    onClick={() => onPick([row.sectionId])}
                  >
                    <span className="block text-sm font-medium">{row.typeLabel}</span>
                    <span className="block text-xs text-muted-foreground">
                      {row.range}
                      {isTop && topDown.length > 1 ? ' · top' : ''}
                      {isBottom && topDown.length > 1 ? ' · bottom' : ''}
                    </span>
                  </button>
                  <HaveNeedToggle
                    have={row.have}
                    label={`${row.name}: in my rack or to get`}
                    onChange={(have) => mark(row, have)}
                    disabled={readOnly}
                    size="sm"
                  />
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    ref={register(`${row.sectionId}:up`)}
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${row.name} up`}
                    title="Move up"
                    disabled={readOnly || isTop}
                    onClick={() =>
                      run(moveSectionRequest(context, row, 'up'), [
                        `${row.sectionId}:up`,
                        `${row.sectionId}:down`,
                      ])
                    }
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    ref={register(`${row.sectionId}:down`)}
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${row.name} down`}
                    title="Move down"
                    disabled={readOnly || isBottom}
                    onClick={() =>
                      run(moveSectionRequest(context, row, 'down'), [
                        `${row.sectionId}:down`,
                        `${row.sectionId}:up`,
                      ])
                    }
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                  {split === undefined ? null : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Split ${row.name} into ${split.text}`}
                      title={`Split into ${split.text}`}
                      disabled={readOnly}
                      onClick={() => run(splitSectionRequest(context, row, split), [])}
                    >
                      <Scissors aria-hidden />
                    </Button>
                  )}
                  {merges.map((choice) => (
                    <Button
                      key={choice.direction}
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Merge ${row.name} with the section ${choice.direction}`}
                      title={`Merge with the section ${choice.direction} into ${choice.intoLabel}`}
                      disabled={readOnly}
                      onClick={() => run(mergeSectionsRequest(context, row, choice), [])}
                    >
                      <Merge aria-hidden />
                    </Button>
                  ))}
                  {row.have ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Retire ${row.name}`}
                      title="Retire (keep it as a part you own, out of the rack)"
                      disabled={readOnly}
                      onClick={() => run(retireSectionRequest(context, row), neighbourKeys(row))}
                    >
                      <Archive aria-hidden />
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${row.name}`}
                      title="Remove"
                      disabled={readOnly}
                      onClick={() => run(removeSectionRequest(context, row), neighbourKeys(row))}
                    >
                      <X aria-hidden />
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {addButtons('bottom')}

      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {frame.name} stacks are {frame.stack.minU}U to {frame.stack.maxU}U.
        {recording ? ' Recording: new sections are marked In my rack.' : ''}
      </p>
    </section>
  )
}
