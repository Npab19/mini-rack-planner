/**
 * "Move to U…": the starts this placement can move to on its face and bay (hole phases and
 * `canPlace`, devices included), as a list to pick from, and Move. One undo step.
 */
import { useId, useMemo, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { movePlacement } from '@/domain/placement'
import type { Frame } from '@/domain/schema/catalog'
import type { Placement } from '@/domain/schema/plan'
import { NativeSelect } from './NativeSelect'
import { applyPlanOp, type SpareContext } from './planOps'
import { placementStarts, placementWhere, positionText } from './stackModel'
import type { OpenPlan } from './useOpenPlan'

export function MoveToU({
  placement,
  name,
  heightSixths,
  open,
  frame,
  spares,
  announce,
}: {
  placement: Placement
  name: string
  heightSixths: number
  open: OpenPlan
  frame: Frame
  spares: SpareContext
  announce: (text: string) => void
}) {
  const { plan, lookup, readOnly } = open
  const selectId = useId()
  const [chosen, setChosen] = useState<number | undefined>(undefined)
  const starts = useMemo(
    () => placementStarts(plan, lookup, frame, placement),
    [plan, lookup, frame, placement],
  )
  const others = starts.filter((y) => y !== placement.y)
  const target = chosen !== undefined && others.includes(chosen) ? chosen : others[0]

  function move(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (target === undefined) return
    const outcome = applyPlanOp(
      (current) => ({ plan: movePlacement(current, placement.id, { y: target }) }),
      spares,
    )
    if (outcome.applied) {
      setChosen(undefined)
      announce(`Moved ${name} to ${placementWhere({ ...placement, y: target }, heightSixths)}.`)
    } else {
      announce(outcome.error ?? `${name} could not be moved.`)
    }
  }

  return (
    <form onSubmit={move} className="grid gap-1.5" noValidate>
      <Label htmlFor={selectId}>Move to U…</Label>
      <div className="flex flex-wrap gap-2">
        <NativeSelect
          id={selectId}
          data-testid="inspector-move-to-u"
          wrapperClassName="w-auto min-w-36 flex-1"
          value={target === undefined ? '' : String(target)}
          onChange={(event) => {
            const value = Number(event.target.value)
            if (Number.isInteger(value)) setChosen(value)
          }}
          disabled={readOnly || others.length === 0}
        >
          {others.length === 0 ? <option value="">No other free spot</option> : null}
          {others.map((y) => (
            <option key={y} value={y}>
              {positionText(y, heightSixths)}
            </option>
          ))}
        </NativeSelect>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={readOnly || target === undefined}
        >
          Move
        </Button>
      </div>
      {others.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          There is no other free spot for it on the {placement.face}.
        </p>
      ) : null}
    </form>
  )
}
