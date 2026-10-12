/**
 * The inspector for one section: type and U range, In my rack / To get (with "Mark everything in
 * this section as In my rack"), what is mounted on it, its own options, and the stack actions:
 * move up / down, split, merge with a neighbour, remove (planned) or retire (owned). Conflicts
 * open the conflict dialog.
 */
import { Archive, ArrowDown, ArrowUp, CircleCheck, Merge, Scissors, X } from 'lucide-react'
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  HAVE_NEED_TEXT_CLASSES,
  HAVE_TEXT,
  HaveIcon,
  haveNeedKey,
  NEED_TEXT,
  NeedIcon,
} from '@/components/common/HaveNeed'
import { HaveNeedToggle } from '@/components/common/HaveNeedToggle'
import { RoleDot } from '@/components/common/PartRole'
import { Button } from '@/components/ui/button'
import { markSectionContents, placementsAnchoredIn } from '@/domain/build'
import { markSection, placementHeightSixths, placementName } from '@/domain/frame'
import { placementRole } from '@/domain/partRole'
import { resolveOptionValues } from '@/domain/recipe'
import type { Frame, Option } from '@/domain/schema/catalog'
import type { OptionValue } from '@/domain/schema/common'
import type { PlanSection } from '@/domain/schema/plan'
import { usePlanStore } from '@/state/planStore'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/state/uiStore'
import { optionChangeText } from './FrameOptionsPanel'
import { OptionField } from './OptionField'
import { applyPlanOp, nowIso, sparesText, type SpareContext } from './planOps'
import {
  mergeSectionsRequest,
  moveSectionRequest,
  removeSectionRequest,
  retireSectionRequest,
  splitSectionRequest,
  type StackOpRequest,
} from './sectionOps'
import { mergeChoices, placementWhere, splitChoice, stackRows } from './stackModel'
import type { OpenPlan } from './useOpenPlan'
import type { StackOps } from './useStackOps'

export interface SectionInspectorProps {
  section: PlanSection
  open: OpenPlan & { frame: Frame }
  ops: StackOps
  spares: SpareContext
  announce: (text: string) => void
  /** The section is gone (removed, retired, split, merged): focus somewhere that stays. */
  onGone: () => void
  /** Selects what is mounted here (focus follows). */
  onPick: (ids: readonly string[]) => void
}

export function SectionInspector({
  section,
  open,
  ops,
  spares,
  announce,
  onGone,
  onPick,
}: SectionInspectorProps) {
  const { plan, frame, lookup, readOnly } = open
  const headingId = useId()
  const contentsId = useId()
  const rows = useMemo(() => stackRows(plan, frame), [plan, frame])
  const row = rows.find((candidate) => candidate.sectionId === section.id)
  const anchored = useMemo(
    () => placementsAnchoredIn(plan, frame, section.id),
    [plan, frame, section.id],
  )
  const [error, setError] = useState<string | null>(null)
  const upRef = useRef<HTMLButtonElement>(null)
  const downRef = useRef<HTMLButtonElement>(null)
  /** After a move, the button to keep focus on (the other one when this one is now disabled). */
  const focusAfterMove = useRef<Array<HTMLButtonElement | null> | null>(null)

  useLayoutEffect(() => {
    const wanted = focusAfterMove.current
    if (wanted === null) return
    focusAfterMove.current = null
    wanted.find((button) => button !== null && !button.disabled)?.focus()
  })

  if (row === undefined) return null
  const context = { frame, lookup }
  const isTop = row.index === rows.length - 1
  const isBottom = row.index === 0
  const split = splitChoice(frame, row)
  const merges = mergeChoices(frame, rows, row)
  const options: Option[] = frame.options.filter((option) => option.scope === 'section')
  const values = resolveOptionValues(options, plan.frame.options, section.options)
  const allOwned =
    row.have &&
    anchored.every(
      (placement) =>
        placement.have !== undefined && placement.devices.every((device) => device.have),
    )

  function mark(have: boolean): void {
    const outcome = applyPlanOp(
      (current) => markSection(current, section.id, have, nowIso(), frame),
      spares,
    )
    announce(
      outcome.applied
        ? `${row?.name}: ${have ? HAVE_TEXT : NEED_TEXT}.${sparesText(outcome.sparesUsed)}`
        : (outcome.error ?? 'The section could not be marked.'),
    )
  }

  function markEverything(): void {
    const outcome = applyPlanOp(
      (current) => ({ plan: markSectionContents(current, frame, section.id, true, nowIso()) }),
      spares,
    )
    const count = anchored.length
    const what = count === 0 ? '' : ` and ${count} ${count === 1 ? 'part' : 'parts'} on it`
    announce(
      outcome.applied
        ? `Marked ${row?.name}${what} as ${HAVE_TEXT}.${sparesText(outcome.sparesUsed)}`
        : (outcome.error ?? 'Nothing was marked.'),
    )
  }

  function setOption(option: Option, value: OptionValue): void {
    const changed = usePlanStore.getState().edit((draft) => {
      const target = draft.frame.sections.find((candidate) => candidate.id === section.id)
      if (target !== undefined) target.options = { ...target.options, [option.id]: value }
    })
    if (changed) announce(optionChangeText(option, value))
  }

  function run(request: StackOpRequest, removesSection: boolean): void {
    setError(null)
    const outcome = ops.run(request)
    if (outcome.status === 'error') setError(outcome.message)
    if (outcome.status !== 'applied' || !removesSection) return
    const ui = useUiStore.getState()
    ui.select(ui.selection.filter((id) => id !== section.id))
    onGone()
  }

  function move(direction: 'up' | 'down'): void {
    if (row === undefined) return
    setError(null)
    const outcome = ops.run(moveSectionRequest(context, row, direction))
    if (outcome.status === 'error') setError(outcome.message)
    if (outcome.status === 'applied') {
      const [same, other] = direction === 'up' ? [upRef, downRef] : [downRef, upRef]
      focusAfterMove.current = [same.current, other.current]
    }
  }

  return (
    <article aria-labelledby={headingId} className="grid gap-4" data-testid="inspector-section">
      <header className="grid gap-1">
        <h2
          id={headingId}
          tabIndex={-1}
          data-panel-focus=""
          className="text-base font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {row.typeLabel}
        </h2>
        <p className="text-sm text-muted-foreground">
          {row.sectionLabel} · {row.range}
          {isTop && rows.length > 1 ? ' · top' : ''}
          {isBottom && rows.length > 1 ? ' · bottom' : ''}
        </p>
      </header>

      <div className="grid gap-2">
        <HaveNeedToggle
          have={row.have}
          label={`${row.name}: in my rack or to get`}
          onChange={mark}
          disabled={readOnly}
          testId="inspector-have-toggle"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-auto min-h-7 w-fit py-1 text-left whitespace-normal"
          disabled={readOnly || allOwned}
          onClick={markEverything}
        >
          <CircleCheck aria-hidden className="text-have" />
          Mark everything in this section as {HAVE_TEXT}
        </Button>
      </div>

      <section aria-labelledby={contentsId} className="grid gap-1.5">
        <h3 id={contentsId} className="text-sm font-medium">
          On this section
        </h3>
        {anchored.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is mounted here yet.</p>
        ) : (
          <ul className="grid gap-1">
            {anchored.map((placement) => {
              const key = haveNeedKey(placement.have !== undefined)
              const Icon = key === 'have' ? HaveIcon : NeedIcon
              return (
                <li key={placement.id}>
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                    onClick={() => onPick([placement.id])}
                  >
                    <RoleDot
                      role={placementRole(placement, lookup)}
                      className="mr-1.5 mb-px align-middle"
                    />
                    <span className="font-medium">{placementName(placement, lookup)}</span>{' '}
                    <span className="text-muted-foreground">
                      {placementWhere(placement, placementHeightSixths(placement, lookup))} ·{' '}
                    </span>
                    <span
                      className={cn(
                        'inline-flex items-center gap-0.5 font-medium whitespace-nowrap',
                        HAVE_NEED_TEXT_CLASSES[key],
                      )}
                    >
                      <Icon aria-hidden className="size-3.5" />
                      {key === 'have' ? HAVE_TEXT : NEED_TEXT}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {options.length === 0 ? null : (
        <fieldset className="grid gap-3 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">Options for this section</legend>
          {options.map((option) => (
            <OptionField
              key={option.id}
              option={option}
              value={values[option.id]}
              onChange={(value) => setOption(option, value)}
              disabled={readOnly}
            />
          ))}
        </fieldset>
      )}

      <div role="group" aria-label="Section actions" className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          ref={upRef}
          disabled={readOnly || isTop}
          onClick={() => move('up')}
        >
          <ArrowUp aria-hidden />
          Move up
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          ref={downRef}
          disabled={readOnly || isBottom}
          onClick={() => move('down')}
        >
          <ArrowDown aria-hidden />
          Move down
        </Button>
        {split === undefined ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={readOnly}
            onClick={() => run(splitSectionRequest(context, row, split), true)}
          >
            <Scissors aria-hidden />
            Split into {split.text}
          </Button>
        )}
        {merges.map((choice) => (
          <Button
            key={choice.direction}
            type="button"
            variant="outline"
            size="sm"
            disabled={readOnly}
            onClick={() => run(mergeSectionsRequest(context, row, choice), true)}
          >
            <Merge aria-hidden />
            Merge with the section {choice.direction}
          </Button>
        ))}
        {row.have ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={readOnly}
            onClick={() => run(retireSectionRequest(context, row), true)}
          >
            <Archive aria-hidden />
            Retire
          </Button>
        ) : (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={readOnly}
            onClick={() => run(removeSectionRequest(context, row), true)}
          >
            <X aria-hidden />
            Remove
          </Button>
        )}
      </div>
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {row.have ? (
        <p className="text-xs text-muted-foreground">
          Sections in your rack are not removed: Retire keeps it as a part you own. Moving it means
          taking the rack apart.
        </p>
      ) : null}
    </article>
  )
}
