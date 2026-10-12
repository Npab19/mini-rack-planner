/**
 * The Rack tab's "Removed but owned": parts you took out of the plan but still have (an owned part
 * you deleted, a retired section, accessories you own but no longer plan). The bill of materials
 * counts them as yours (they show under Leftovers) until you decide, per part:
 * - Reuse: back into the plan, In my rack. A part or a section asks where (`ReuseDialog`), then
 *   is selected; accessories go straight back on their line.
 * - Keep as spare: it leaves the plan and its parts go into the spares (the inventory every plan
 *   shares). The inventory is not part of the plan, so this section offers its own Undo, which
 *   also takes those spares out again; the toolbar's Undo only brings the part back here.
 * - Discard: it leaves the plan (sold, given away, broken); Undo brings it back.
 * Every plan change is one undo step and is announced.
 * Rows are owned parts: a solid green outline with the In my rack icon and a role dot before the
 * name; the "kept as spare" note is green too, and a part that cannot go back gets an info note.
 */
import { ArchiveRestore, CircleCheck, Info, PackagePlus, Trash2, Undo2, X } from 'lucide-react'
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { HaveIcon } from '@/components/common/HaveNeed'
import { RoleDot } from '@/components/common/PartRole'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/db/errors'
import { listNames } from '@/domain/frame'
import { catalogEntryRole, type PartRole } from '@/domain/partRole'
import {
  discardRetired,
  keepAsSpare,
  listRetired,
  retiredSpares,
  reuseRetiredExtra,
  type RetiredView,
} from '@/domain/retired'
import type { Plan } from '@/domain/schema/plan'
import type { Inventory } from '@/domain/schema/settings'
import { adjustInventory } from '@/state/inventoryStore'
import { usePlanStore } from '@/state/planStore'
import { applyPlanOp, sparesText, type SpareContext } from '../inspector/planOps'
import type { OpenPlan } from '../inspector/useOpenPlan'
import { ReuseDialog } from './ReuseDialog'
import { RetiredConfirmDialog, type RetiredConfirmRequest } from './RetiredConfirmDialog'
import { removedOnText, retiredKindText, retiredTitle } from './retiredText'

export interface RemovedButOwnedSectionProps {
  open: OpenPlan
  spares: SpareContext
  announce: (text: string) => void
  /** Selects what went back on the rack (focus follows it to the Selection tab). */
  onPick: (ids: readonly string[]) => void
}

/** The last Keep as spare, so it can be undone together with the spares it added. */
interface KeptSpare {
  planId: string
  name: string
  /** The plan right after; Undo is offered while it is still the open plan. */
  plan: Plan
  /** Spares added per inventory key. */
  added: Inventory
}

export function RemovedButOwnedSection({
  open,
  spares,
  announce,
  onPick,
}: RemovedButOwnedSectionProps) {
  const { plan, planId, lookup, readOnly } = open
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  /** Focus the heading after the next render (the row whose button was used is gone). */
  const focusHeading = useRef(false)
  /** The confirmed action ran: the dialog hands focus to the heading when it closes. */
  const acted = useRef(false)
  const views = useMemo(() => listRetired(plan, lookup), [plan, lookup])
  const [reusing, setReusing] = useState<RetiredView | null>(null)
  const [confirm, setConfirm] = useState<RetiredConfirmRequest | null>(null)
  const [kept, setKept] = useState<KeptSpare | null>(null)

  useLayoutEffect(() => {
    if (!focusHeading.current) return
    focusHeading.current = false
    headingRef.current?.focus()
  })

  function startReuse(view: RetiredView): void {
    if (view.reuse !== 'extra') {
      setReusing(view)
      return
    }
    const outcome = applyPlanOp((current) => reuseRetiredExtra(current, view.id), spares)
    if (!outcome.applied) {
      announce(outcome.error ?? `${view.name} could not go back.`)
      return
    }
    focusHeading.current = true
    announce(
      `Put ${retiredTitle(view)} back on the accessories list, In my rack.${sparesText(outcome.sparesUsed)}`,
    )
  }

  function reused(id: string, message: string): void {
    setReusing(null)
    announce(message)
    onPick([id])
  }

  function askKeep(view: RetiredView): void {
    acted.current = false
    setConfirm({
      action: 'keep',
      view,
      spares: retiredSpares(plan, lookup, view.id, spares.settings),
    })
  }

  function askDiscard(view: RetiredView): void {
    acted.current = false
    setConfirm({ action: 'discard', view, spares: [] })
  }

  function confirmed(request: RetiredConfirmRequest): void {
    if (request.action === 'discard') discard(request.view)
    else void keep(request.view)
  }

  function discard(view: RetiredView): void {
    const outcome = applyPlanOp((current) => discardRetired(current, view.id), spares)
    if (!outcome.applied) {
      setConfirm(null)
      announce(outcome.error ?? `${view.name} could not be discarded.`)
      return
    }
    acted.current = true
    setConfirm(null)
    announce(`Discarded ${retiredTitle(view)}: it no longer counts as yours. Undo brings it back.`)
  }

  async function keep(view: RetiredView): Promise<void> {
    const current = usePlanStore.getState().plan
    // What goes into the spares, from the plan as it is right now.
    const parts = current === null ? [] : retiredSpares(current, lookup, view.id, spares.settings)
    const outcome = applyPlanOp((latest) => keepAsSpare(latest, view.id), spares)
    if (!outcome.applied) {
      setConfirm(null)
      announce(outcome.error ?? `${view.name} could not be kept as spare.`)
      return
    }
    acted.current = true
    setConfirm(null)
    const after = usePlanStore.getState().plan
    const added: Inventory = {}
    try {
      for (const part of parts) {
        await adjustInventory(part.key, part.qty)
        added[part.key] = part.qty
      }
    } catch (error) {
      announce(
        `${view.name} left the plan, but your spares were not all updated: ${errorMessage(error)}`,
      )
      return
    } finally {
      if (after !== null) setKept({ planId: after.id, name: view.name, plan: after, added })
    }
    announce(
      parts.length === 0
        ? `Kept ${retiredTitle(view)} as spare: it left this plan.`
        : `Kept ${retiredTitle(view)} as spare: ${parts.length === 1 ? 'its part is' : 'its parts are'} in your spares now.`,
    )
  }

  async function undoKeep(done: KeptSpare): Promise<void> {
    const store = usePlanStore.getState()
    if (store.plan !== done.plan) return
    store.undo()
    setKept(null)
    focusHeading.current = true
    try {
      for (const [key, qty] of Object.entries(done.added)) await adjustInventory(key, -qty)
      announce(`Undone: ${done.name} is back under Removed but owned, and out of your spares.`)
    } catch (error) {
      announce(`${done.name} is back, but your spares were not all updated: ${errorMessage(error)}`)
    }
  }

  const showKept = kept !== null && kept.planId === planId
  const canUndoKept = showKept && kept.plan === plan

  return (
    <section aria-labelledby={headingId} className="grid gap-2" data-testid="rack-removed">
      <div className="grid gap-0.5">
        <h3
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="w-fit rounded-sm text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {views.length === 0 ? 'Removed but owned' : `Removed but owned (${views.length})`}
        </h3>
        <p className="text-xs text-muted-foreground">
          {views.length === 0
            ? 'Nothing here. When you delete or retire something you own, it waits here until you reuse it, keep it as a spare or discard it.'
            : 'Parts you took out but still have. The bill of materials counts them as yours (under Leftovers) until you decide.'}
        </p>
      </div>

      {showKept ? (
        <div
          data-testid="retired-kept"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-have-border bg-have-soft p-2"
        >
          <p className="flex min-w-40 flex-1 items-center gap-1.5 text-sm">
            <CircleCheck aria-hidden className="size-4 shrink-0 text-have" />
            Kept {kept.name} as spare.
          </p>
          {canUndoKept ? (
            <Button size="sm" variant="outline" onClick={() => void undoKeep(kept)}>
              <Undo2 aria-hidden />
              Undo
            </Button>
          ) : null}
          <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={() => setKept(null)}>
            <X aria-hidden />
          </Button>
        </div>
      ) : null}

      {views.length === 0 ? null : (
        <ul aria-label="Removed but owned" className="grid gap-1.5">
          {views.map((view) => (
            <RetiredRow
              key={view.id}
              view={view}
              role={view.itemId === undefined ? 'neutral' : catalogEntryRole(lookup, view.itemId)}
              readOnly={readOnly}
              onReuse={() => startReuse(view)}
              onKeep={() => askKeep(view)}
              onDiscard={() => askDiscard(view)}
            />
          ))}
        </ul>
      )}

      <ReuseDialog
        view={reusing}
        open={open}
        spares={spares}
        onClose={() => setReusing(null)}
        onReused={reused}
      />
      <RetiredConfirmDialog
        request={confirm}
        onConfirm={confirmed}
        onCancel={() => setConfirm(null)}
        focusAfter={() => (acted.current ? headingRef.current : null)}
      />
    </section>
  )
}

function RetiredRow({
  view,
  role,
  readOnly,
  onReuse,
  onKeep,
  onDiscard,
}: {
  view: RetiredView
  /** What the part is for: its dot. */
  role: PartRole
  readOnly: boolean
  onReuse: () => void
  onKeep: () => void
  onDiscard: () => void
}) {
  const title = retiredTitle(view)
  return (
    <li
      data-testid={`retired-row-${view.id}`}
      data-kind={view.kind}
      className="grid gap-2 rounded-lg border border-have-border bg-card p-2"
    >
      <div className="grid min-w-0 gap-0.5">
        <p className="text-sm font-medium break-words">
          <RoleDot role={role} className="mr-1.5 mb-px align-middle" />
          {title}
        </p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <HaveIcon aria-hidden className="size-3.5 shrink-0 text-have" />
          <span>
            {retiredKindText(view.kind)} · removed {removedOnText(view.at)}
          </span>
        </p>
        {view.devices.length === 0 ? null : (
          <p className="text-xs break-words">With the {listNames(view.devices)}</p>
        )}
        {view.reuseNote === undefined ? null : (
          <p className="flex items-start gap-1 text-xs text-muted-foreground">
            <Info aria-hidden className="mt-px size-3.5 shrink-0 text-info" />
            {view.reuseNote}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {view.reuse === undefined ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={`Reuse ${title}`}
            disabled={readOnly}
            onClick={onReuse}
          >
            <ArchiveRestore aria-hidden />
            Reuse
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`Keep as spare: ${title}`}
          disabled={readOnly}
          onClick={onKeep}
        >
          <PackagePlus aria-hidden />
          Keep as spare
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Discard ${title}`}
          disabled={readOnly}
          onClick={onDiscard}
        >
          <Trash2 aria-hidden />
          Discard
        </Button>
      </div>
    </li>
  )
}
