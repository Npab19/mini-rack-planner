/**
 * Several things selected: what they are, and "Mark all as In my rack / To get" in one undo step
 * (sections get snapshots, placements too; devices on them keep their own marks). The buttons wear
 * the In my rack / To get colours; parts carry a role dot next to their names.
 */
import { useId } from 'react'
import { HAVE_TEXT, HaveIcon, NEED_TEXT, NeedIcon } from '@/components/common/HaveNeed'
import { RoleDot } from '@/components/common/PartRole'
import { Button } from '@/components/ui/button'
import { markPlacement } from '@/domain/build'
import { markSection, placementName } from '@/domain/frame'
import { placementRole, type PartRole } from '@/domain/partRole'
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
  const names: Array<{ name: string; role?: PartRole }> = [
    ...sections.map((section) => ({
      name: rows.find((row) => row.sectionId === section.id)?.name ?? section.typeId,
    })),
    ...placements.map((placement) => ({
      name: placementName(placement, lookup),
      role: placementRole(placement, lookup),
    })),
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
        {names.map(({ name, role }, index) => (
          <li key={`${name}-${index}`}>
            {role === undefined ? null : (
              <RoleDot role={role} className="mr-1.5 mb-px align-middle" />
            )}
            {name}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="bg-have text-have-foreground hover:bg-have/85"
          disabled={readOnly}
          onClick={() => mark(true)}
        >
          <HaveIcon aria-hidden />
          Mark all as {HAVE_TEXT}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="border-dashed border-need-border text-need hover:bg-need-soft hover:text-need dark:border-need-border dark:hover:bg-need-soft"
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
