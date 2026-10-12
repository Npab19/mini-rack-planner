/**
 * The Rack tab's "Accessories": things that take no rack space (cable clips, LED guides, feet),
 * from the catalog's accessories (`kind: 'extra'`, the user's own parts included). Each line says
 * how many the plan uses and how many of those are In my rack (in words and icon, the outline
 * dashed while some are still to get); Remove takes a line out, and the ones you own are kept
 * under "Removed but owned". Add picks an accessory and how many; in Recording mode they are In
 * my rack. Every change is one undo step (`domain/extras.ts`); the BOM lists their parts.
 */
import { Plus, X } from 'lucide-react'
import { useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { HaveIcon, NeedIcon } from '@/components/common/HaveNeed'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  addExtra,
  catalogExtras,
  MAX_EXTRA_QTY,
  removeExtra,
  setExtraHaveQty,
  setExtraQty,
  type ExtraOpResult,
} from '@/domain/extras'
import type { Plan, PlanExtra } from '@/domain/schema/plan'
import { cn } from '@/lib/utils'
import { OpenPageLink } from '../inspector/EntryFacts'
import { NativeSelect } from '../inspector/NativeSelect'
import {
  applyPlanOp,
  nowIso,
  sparesText,
  type PlanOpOutcome,
  type SpareContext,
} from '../inspector/planOps'
import type { OpenPlan } from '../inspector/useOpenPlan'
import { CountField } from './CountField'
import { contentsText, haveStatus, isAre } from './extrasView'

export interface AccessoriesSectionProps {
  open: OpenPlan
  spares: SpareContext
  announce: (text: string) => void
}

interface Applied {
  outcome: PlanOpOutcome
  result: ExtraOpResult | undefined
}

export function AccessoriesSection({ open, spares, announce }: AccessoriesSectionProps) {
  const { plan, lookup, readOnly, recording } = open
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusHeading = useRef(false)
  const choices = useMemo(() => catalogExtras(lookup), [lookup])

  // A removed line takes its buttons along: focus the section's heading instead.
  useLayoutEffect(() => {
    if (!focusHeading.current) return
    focusHeading.current = false
    headingRef.current?.focus()
  })

  function nameOf(extra: Pick<PlanExtra, 'itemId'>): string {
    return lookup.item(extra.itemId)?.name ?? `Unknown accessory “${extra.itemId}”`
  }

  function apply(op: (current: Plan) => ExtraOpResult): Applied {
    let result: ExtraOpResult | undefined
    const outcome = applyPlanOp((current) => {
      result = op(current)
      return result
    }, spares)
    return { outcome, result }
  }

  function add(itemId: string, qty: number): string | null {
    const name = nameOf({ itemId })
    const { outcome } = apply((current) =>
      addExtra(current, itemId, qty, recording ? { haveQty: qty } : {}),
    )
    if (!outcome.applied) return outcome.error ?? `${name} could not be added.`
    announce(
      `Added ${qty} × ${name} to the plan${recording ? ', marked In my rack' : ''}.${sparesText(outcome.sparesUsed)}`,
    )
    return null
  }

  function setQty(extra: PlanExtra, qty: number): void {
    const name = nameOf(extra)
    // Recording: the extra ones are already owned, as everything added while recording.
    const owning = recording && qty > extra.qty
    const { outcome, result } = apply((current) => {
      const changed = setExtraQty(current, extra.id, qty, { at: nowIso() })
      if (!owning || changed.error !== undefined) return changed
      const owned = setExtraHaveQty(changed.plan, extra.id, extra.haveQty + qty - extra.qty)
      return owned.error === undefined ? { ...changed, plan: owned.plan } : changed
    })
    if (!outcome.applied) {
      announce(outcome.error ?? `${name} could not be changed.`)
      return
    }
    const kept = extra.haveQty - qty
    const spent = sparesText(outcome.sparesUsed)
    announce(
      owning
        ? `${name}: ${qty} in the plan, the added ones marked In my rack.${spent}`
        : result?.retiredId === undefined || kept <= 0
          ? `${name}: ${qty} in the plan.`
          : `${name}: ${qty} in the plan. The other ${kept} you own ${isAre(kept)} kept under Removed but owned.`,
    )
  }

  function setHave(extra: PlanExtra, haveQty: number): void {
    const name = nameOf(extra)
    const { outcome, result } = apply((current) => setExtraHaveQty(current, extra.id, haveQty))
    if (!outcome.applied) {
      announce(outcome.error ?? `${name} could not be marked.`)
      return
    }
    const owned =
      result?.plan.extras.find((candidate) => candidate.id === extra.id)?.haveQty ?? haveQty
    announce(`${name}: ${owned} of ${extra.qty} in my rack.${sparesText(outcome.sparesUsed)}`)
  }

  function remove(extra: PlanExtra): void {
    const name = nameOf(extra)
    const { outcome } = apply((current) => removeExtra(current, extra.id, { at: nowIso() }))
    if (!outcome.applied) {
      announce(outcome.error ?? `${name} could not be removed.`)
      return
    }
    focusHeading.current = true
    const owned = extra.haveQty
    announce(
      owned > 0
        ? `Removed ${name} from the plan. The ${owned} you own ${isAre(owned)} kept under Removed but owned.`
        : `Removed ${name} from the plan.`,
    )
  }

  return (
    <section aria-labelledby={headingId} className="grid gap-2" data-testid="rack-accessories">
      <div className="grid gap-0.5">
        <h3
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="w-fit rounded-sm text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Accessories
        </h3>
        <p className="text-xs text-muted-foreground">
          Things that take no rack space, such as cable clips, LED guides or feet.
        </p>
      </div>

      {plan.extras.length === 0 ? null : (
        <ul aria-label="Accessories in this plan" className="grid gap-1.5">
          {plan.extras.map((extra) => (
            <AccessoryRow
              key={extra.id}
              extra={extra}
              open={open}
              name={nameOf(extra)}
              onQty={(qty) => setQty(extra, qty)}
              onHave={(haveQty) => setHave(extra, haveQty)}
              onRemove={() => remove(extra)}
            />
          ))}
        </ul>
      )}

      {choices.length === 0 ? (
        <p className="rounded-lg border border-dashed p-2.5 text-xs text-muted-foreground">
          Your catalog has no accessories yet. Accessories in the catalog or in your own parts show
          up here.
        </p>
      ) : (
        <AddAccessoryForm choices={choices} disabled={readOnly} recording={recording} onAdd={add} />
      )}
    </section>
  )
}

function AccessoryRow({
  extra,
  open,
  name,
  onQty,
  onHave,
  onRemove,
}: {
  extra: PlanExtra
  open: OpenPlan
  name: string
  onQty: (qty: number) => void
  onHave: (haveQty: number) => void
  onRemove: () => void
}) {
  const nameId = useId()
  const { lookup, readOnly } = open
  const item = lookup.item(extra.itemId)
  const contents = item === undefined ? undefined : contentsText(item, lookup)
  const status = haveStatus(extra)
  const StatusIcon = status.allHave ? HaveIcon : NeedIcon
  return (
    <li
      data-testid={`extra-row-${extra.id}`}
      data-have={status.allHave}
      className={cn(
        'rounded-lg border bg-card p-2',
        !status.allHave && 'border-dashed border-foreground/30',
      )}
    >
      <div role="group" aria-labelledby={nameId} className="grid gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p id={nameId} className="text-sm font-medium break-words">
              {name}
            </p>
            {contents === undefined ? null : (
              <p className="text-xs break-words text-muted-foreground">Each: {contents}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {item?.source === undefined ? null : (
              <OpenPageLink url={item.source.url} name={name} iconOnly />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${name} from the plan`}
              title="Remove from the plan"
              disabled={readOnly}
              onClick={onRemove}
            >
              <X aria-hidden />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <CountField
            label="Quantity"
            value={extra.qty}
            min={1}
            max={MAX_EXTRA_QTY}
            disabled={readOnly}
            onCommit={onQty}
            testId={`extra-qty-${extra.id}`}
          />
          <CountField
            label="In my rack"
            value={Math.min(extra.haveQty, extra.qty)}
            min={0}
            max={extra.qty}
            suffix={`of ${extra.qty}`}
            disabled={readOnly}
            onCommit={onHave}
            testId={`extra-have-${extra.id}`}
          />
        </div>
        <p className="flex items-center gap-1.5 text-xs" data-testid={`extra-status-${extra.id}`}>
          <StatusIcon aria-hidden className="size-3.5 shrink-0" />
          {status.text}
        </p>
      </div>
    </li>
  )
}

function AddAccessoryForm({
  choices,
  disabled,
  recording,
  onAdd,
}: {
  choices: ReturnType<typeof catalogExtras>
  disabled: boolean
  recording: boolean
  /** Adds; returns why it could not, or null. */
  onAdd: (itemId: string, qty: number) => string | null
}) {
  const selectId = useId()
  const qtyId = useId()
  const errorId = useId()
  const [chosenId, setChosenId] = useState(choices[0]?.id ?? '')
  const [qtyText, setQtyText] = useState('1')
  const [error, setError] = useState<string | null>(null)
  const chosen = choices.find((item) => item.id === chosenId) ?? choices[0]

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (chosen === undefined) return
    const qty = Number(qtyText.trim())
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_EXTRA_QTY) {
      setError(`Enter how many, from 1 to ${MAX_EXTRA_QTY}.`)
      return
    }
    const problem = onAdd(chosen.id, qty)
    setError(problem)
    if (problem === null) setQtyText('1')
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Add an accessory"
      className="grid gap-2 rounded-lg border border-dashed p-2.5"
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-40 flex-1 gap-1">
          <Label htmlFor={selectId} className="text-xs">
            Accessory
          </Label>
          <NativeSelect
            id={selectId}
            value={chosen?.id ?? ''}
            disabled={disabled}
            data-testid="extra-add-choice"
            onChange={(event) => {
              setChosenId(event.target.value)
              setError(null)
            }}
          >
            {choices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={qtyId} className="text-xs">
            How many
          </Label>
          <Input
            id={qtyId}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_EXTRA_QTY}
            step={1}
            value={qtyText}
            disabled={disabled}
            aria-invalid={error === null ? undefined : true}
            aria-describedby={error === null ? undefined : errorId}
            data-testid="extra-add-qty"
            className="w-20 tabular-nums"
            onChange={(event) => {
              setQtyText(event.target.value)
              setError(null)
            }}
          />
        </div>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={disabled}
          aria-label="Add accessory"
          data-testid="extra-add"
        >
          <Plus aria-hidden />
          Add
        </Button>
      </div>
      {error === null ? null : (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {recording ? (
        <p className="text-xs text-muted-foreground">Recording: they are added as In my rack.</p>
      ) : null}
    </form>
  )
}
