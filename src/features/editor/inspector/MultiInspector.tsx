/**
 * Several things selected: what they are, and "Mark all as In my rack / To get" in one undo step
 * (sections get snapshots, placements too; devices on them keep their own marks).
 */
import { useId } from 'react'
import { HAVE_TEXT, HaveIcon, NEED_TEXT, NeedIcon } from '@/components/common/HaveNeed'
import { Button } from '@/components/ui/button'
import { markPlacement } from '@/domain/build'
import { markSection, placementName } from '@/domain/frame'
import type { Frame } from '@/domain/schema/catalog'
import type { Placement, Plan, PlanSection } from '@/domain/schema/plan'
import { useUiStore } from '@/state/uiStore'
import { applyPlanOp, nowIso, sparesText, type SpareContext } from './planOps'
import { stackRows } from './stackModel'
import type { OpenPlan } from './useOpenPlan'

/** Marks every given placement and section, in one plan. */
export function markAll(
  plan: Plan,
  frame: Frame | undefined,
  placementIds: readonly string[],
  sectionIds: readonly string[],
  have: boolean,
  at: string,
): Plan {
  let next = plan
  for (const id of placementIds) next = markPlacement(next, id, have, at)
  if (frame !== undefined) {
    for (const id of sectionIds) {
      const marked = markSection(next, id, have, at, frame)
      if (marked.error === undefined) next = marked.plan
    }
  }
  return next
}

export function MultiInspector({
  placements,
  sections,
  open,
  spares,
  announce,
  onCleared,
}: {
  placements: readonly Placement[]
  sections: readonly PlanSection[]
  open: OpenPlan
  spares: SpareContext
  announce: (text: string) => void
  /** The selection was cleared: this view goes away. */
  onCleared: () => void
}) {
  const { plan, frame, lookup, readOnly } = open
  const headingId = useId()
  const rows = frame === undefined ? [] : stackRows(plan, frame)
  const names = [
    ...sections.map(
      (section) => rows.find((row) => row.sectionId === section.id)?.name ?? section.typeId,
    ),
    ...placements.map((placement) => placementName(placement, lookup)),
  ]
  const count = names.length

  function mark(have: boolean): void {
    const outcome = applyPlanOp(
      (current) => ({
        plan: markAll(
          current,
          frame,
          placements.map((placement) => placement.id),
          sections.map((section) => section.id),
          have,
          nowIso(),
        ),
      }),
      spares,
    )
    announce(
      outcome.applied
        ? `Marked ${count} selected as ${have ? HAVE_TEXT : NEED_TEXT}.${sparesText(outcome.sparesUsed)}`
        : (outcome.error ?? 'Nothing was marked.'),
    )
  }

  return (
    <article aria-labelledby={headingId} className="grid gap-4" data-testid="inspector-multi">
      <h2
        id={headingId}
        tabIndex={-1}
        data-panel-focus=""
        className="text-base font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {count} selected
      </h2>
      <ul className="grid gap-1 text-sm">
        {names.map((name, index) => (
          <li key={`${name}-${index}`}>{name}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={readOnly} onClick={() => mark(true)}>
          <HaveIcon aria-hidden />
          Mark all as {HAVE_TEXT}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="border-dashed"
          disabled={readOnly}
          onClick={() => mark(false)}
        >
          <NeedIcon aria-hidden />
          Mark all as {NEED_TEXT}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            onCleared()
            useUiStore.getState().clearSelection()
            announce('Selection cleared.')
          }}
        >
          Clear selection
        </Button>
      </div>
    </article>
  )
}
