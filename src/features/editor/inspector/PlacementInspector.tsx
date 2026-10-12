/**
 * The inspector for one placement: name (with a chip for its role) and position, In my rack / To get, its own label,
 * Move to U…, the devices in its slots, its options, facts about the part, Duplicate, Add another
 * at U… (the rack's dialog) and Delete (owned parts ask first: they are kept as retired). Each
 * change is one undo step.
 */
import { Copy, Plus, Trash2 } from 'lucide-react'
import { useId, useState, type KeyboardEvent } from 'react'
import { HAVE_TEXT, NEED_TEXT } from '@/components/common/HaveNeed'
import { HaveNeedToggle } from '@/components/common/HaveNeedToggle'
import { RoleChip } from '@/components/common/PartRole'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { markPlacement } from '@/domain/build'
import { placementRole } from '@/domain/partRole'
import { placementHeightSixths, placementName } from '@/domain/frame'
import { formatU } from '@/domain/geometry'
import { deletePlacement, resolvePlaceable } from '@/domain/placement'
import { resolveOptionValues } from '@/domain/recipe'
import { deviceName, type Option } from '@/domain/schema/catalog'
import type { OptionValue } from '@/domain/schema/common'
import type { Placement } from '@/domain/schema/plan'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { dimsText } from '../palette/paletteModel'
import { requestAddAtU, useAddAtUAvailable } from '../toolbar/addAtURequest'
import { FactList, OpenPageLink, sourceFacts, VerifiedFact, type Fact } from './EntryFacts'
import { optionChangeText } from './FrameOptionsPanel'
import { MoveToU } from './MoveToU'
import { OptionField } from './OptionField'
import { duplicateNear } from './placementOps'
import { applyPlanOp, nowIso, sparesText, type SpareContext } from './planOps'
import { SlotDevices } from './SlotDevices'
import { placementWhere } from './stackModel'
import type { OpenPlan } from './useOpenPlan'

export interface PlacementInspectorProps {
  placement: Placement
  open: OpenPlan
  spares: SpareContext
  announce: (text: string) => void
  /** A device entry selected on the rack. */
  deviceEntryId?: string
  /**
   * This view is about to go (deleted, or replaced by the copy Duplicate selects): the inspector
   * moves focus to the heading of what shows next.
   */
  onGone: () => void
}

const MAX_LABEL_LENGTH = 80

function LabelField({
  placement,
  catalogName,
  readOnly,
  announce,
}: {
  placement: Placement
  catalogName: string
  readOnly: boolean
  announce: (text: string) => void
}) {
  const inputId = useId()
  const hintId = useId()
  const [draft, setDraft] = useState<string | null>(null)

  function commit(): void {
    if (draft === null) return
    const label = draft.trim()
    setDraft(null)
    if (label === (placement.label ?? '')) return
    const changed = usePlanStore.getState().edit((plan) => {
      const target = plan.placements.find((candidate) => candidate.id === placement.id)
      if (target === undefined) return
      if (label === '') delete target.label
      else target.label = label
    })
    if (changed) {
      announce(label === '' ? `Label removed: it is ${catalogName} again.` : `Labelled “${label}”.`)
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape' && draft !== null) {
      // Revert the typing; do not let Escape also close a sheet or clear the selection.
      event.preventDefault()
      event.stopPropagation()
      setDraft(null)
    }
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={inputId}>Label</Label>
      <Input
        id={inputId}
        value={draft ?? placement.label ?? ''}
        placeholder={catalogName}
        maxLength={MAX_LABEL_LENGTH}
        autoComplete="off"
        readOnly={readOnly}
        aria-describedby={hintId}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        Your own name for it, e.g. “NAS”. Enter saves, Escape reverts.
      </p>
    </div>
  )
}

function partFacts(placement: Placement, open: OpenPlan, heightSixths: number): Fact[] {
  const item = open.lookup.item(placement.itemId)
  const device = item === undefined ? open.lookup.device(placement.itemId) : undefined
  if (item !== undefined) {
    return [
      { label: 'Part', value: item.name },
      ...sourceFacts(item.source),
      { label: 'Height', value: formatU(item.heightSixths) },
      { label: 'Depth', value: `${item.depthMm} mm` },
      { label: 'Checked', value: <VerifiedFact verified={item.verified} /> },
    ]
  }
  if (device !== undefined) {
    return [
      { label: 'Device', value: deviceName(device) },
      ...sourceFacts(device.source),
      { label: 'Height', value: formatU(device.rackmount?.heightSixths ?? heightSixths) },
      { label: 'Size', value: dimsText(device.dims) },
      { label: 'Checked', value: <VerifiedFact verified={device.verified} /> },
    ]
  }
  return [
    { label: 'Part', value: `Not in your catalog (“${placement.itemId}”)` },
    { label: 'Height', value: formatU(heightSixths) },
  ]
}

function ConfirmDelete({
  name,
  open,
  onConfirm,
  onCancel,
}: {
  name: string
  open: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription>
            It is in your rack, so it is kept as a retired part you own (it shows as surplus in the
            bill of materials). Devices you own go back to Equipment to fit.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Keep it
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            <Trash2 aria-hidden />
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function PlacementInspector({
  placement,
  open,
  spares,
  announce,
  deviceEntryId,
  onGone,
}: PlacementInspectorProps) {
  const { lookup, frame, readOnly, recording } = open
  const headingId = useId()
  const aboutId = useId()
  const [confirming, setConfirming] = useState(false)
  const addAtU = useAddAtUAvailable()
  const item = lookup.item(placement.itemId)
  const placeable = resolvePlaceable(lookup, placement.itemId)
  const heightSixths = placementHeightSixths(placement, lookup)
  const name = placementName(placement, lookup)
  const catalogName =
    item?.name ?? (placeable === undefined ? (placement.name ?? placement.itemId) : placeable.name)
  const have = placement.have !== undefined
  const options: readonly Option[] = item?.options ?? []
  const values = resolveOptionValues(options, placement.options)

  function markHave(next: boolean): void {
    const outcome = applyPlanOp(
      (plan) => ({ plan: markPlacement(plan, placement.id, next, nowIso()) }),
      spares,
    )
    announce(
      outcome.applied
        ? `${name}: ${next ? HAVE_TEXT : NEED_TEXT}.${sparesText(outcome.sparesUsed)}`
        : (outcome.error ?? `${name} could not be marked.`),
    )
  }

  function setOption(option: Option, value: OptionValue): void {
    const changed = usePlanStore.getState().edit((plan) => {
      const target = plan.placements.find((candidate) => candidate.id === placement.id)
      if (target !== undefined) target.options = { ...target.options, [option.id]: value }
    })
    if (changed) announce(optionChangeText(option, value))
  }

  function duplicate(): void {
    let copyId: string | undefined
    const outcome = applyPlanOp((plan) => {
      const result = duplicateNear(plan, lookup, frame, placement.id)
      if (typeof result === 'string') return { plan, conflicts: [], error: result }
      copyId = result.placementId
      return { plan: result.plan }
    }, spares)
    if (!outcome.applied || copyId === undefined) {
      announce(outcome.error ?? `${name} could not be copied.`)
      return
    }
    const copy = usePlanStore.getState().plan?.placements.find((p) => p.id === copyId)
    useUiStore.getState().select([copyId])
    const where = copy === undefined ? '' : ` at ${placementWhere(copy, heightSixths)}`
    announce(`Duplicated ${name}${where}. The copy is to get.`)
    onGone()
  }

  function remove(): void {
    setConfirming(false)
    const outcome = applyPlanOp(
      (plan) => ({ plan: deletePlacement(plan, placement.id, { at: nowIso() }) }),
      spares,
    )
    if (!outcome.applied) {
      announce(outcome.error ?? `${name} could not be deleted.`)
      return
    }
    const ui = useUiStore.getState()
    ui.select(ui.selection.filter((id) => id !== placement.id))
    announce(
      `Deleted ${name}.${have ? ' It is kept as a retired part you own.' : ''} Undo brings it back.`,
    )
    onGone()
  }

  const url = item?.source?.url ?? lookup.device(placement.itemId)?.source?.url

  return (
    <article aria-labelledby={headingId} className="grid gap-4" data-testid="inspector-placement">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2
            id={headingId}
            tabIndex={-1}
            data-panel-focus=""
            className="min-w-0 text-base font-medium break-words outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {name}
          </h2>
          <RoleChip role={placementRole(placement, lookup)} />
        </div>
        <p className="text-sm text-muted-foreground">
          {placementWhere(placement, heightSixths)}
          {placement.label === undefined ? null : ` · ${catalogName}`}
        </p>
      </header>

      <HaveNeedToggle
        have={have}
        label={`${name}: in my rack or to get`}
        onChange={markHave}
        disabled={readOnly}
        testId="inspector-have-toggle"
      />
      {recording && !have ? (
        <p className="-mt-2 text-xs text-muted-foreground">
          Recording: mark what is already built as In my rack.
        </p>
      ) : null}

      <LabelField
        key={placement.id}
        placement={placement}
        catalogName={catalogName}
        readOnly={readOnly}
        announce={announce}
      />

      {frame === undefined || placeable === undefined ? null : (
        <MoveToU
          placement={placement}
          name={name}
          heightSixths={heightSixths}
          open={open}
          frame={frame}
          spares={spares}
          announce={announce}
        />
      )}

      <SlotDevices
        placement={placement}
        slots={placeable?.slots ?? []}
        open={open}
        spares={spares}
        announce={announce}
        {...(deviceEntryId === undefined ? {} : { highlightId: deviceEntryId })}
      />

      {options.length === 0 ? null : (
        <fieldset className="grid gap-3 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">Options</legend>
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

      <section className="grid gap-2" aria-labelledby={aboutId}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id={aboutId} className="text-sm font-medium">
            About this part
          </h3>
          {url === undefined ? null : <OpenPageLink url={url} name={catalogName} />}
        </div>
        <FactList facts={partFacts(placement, open, heightSixths)} />
      </section>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={duplicate}>
          <Copy aria-hidden />
          Duplicate
        </Button>
        {addAtU && placeable !== undefined && frame !== undefined ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={readOnly}
            data-testid="inspector-add-another"
            onClick={() =>
              requestAddAtU(
                placeable.source === 'rackmount'
                  ? { kind: 'device', deviceId: placement.itemId }
                  : { kind: 'item', itemId: placement.itemId },
              )
            }
          >
            <Plus aria-hidden />
            Add another at U…
          </Button>
        ) : null}
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={readOnly}
          onClick={() => (have ? setConfirming(true) : remove())}
        >
          <Trash2 aria-hidden />
          Delete
        </Button>
      </div>
      <ConfirmDelete
        name={name}
        open={confirming}
        onConfirm={remove}
        onCancel={() => setConfirming(false)}
      />
    </article>
  )
}
