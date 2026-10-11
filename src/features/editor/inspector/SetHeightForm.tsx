/**
 * "Set height": pick a height the frame's section steps can reach and the end that grows or
 * shrinks, then Apply (`setHeight`: only the planned run at that end is rebuilt, sections you have
 * never change). A preview says what will happen; errors show next to the form.
 */
import { useId, useMemo, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { setHeight, type StackEnd } from '@/domain/frame'
import type { Frame } from '@/domain/schema/catalog'
import { NativeSelect } from './NativeSelect'
import { isResolvable, setHeightRequest } from './sectionOps'
import {
  defaultTargetU,
  heightChangeText,
  reachableHeights,
  stackHeightU,
  stackRows,
} from './stackModel'
import type { OpenPlan } from './useOpenPlan'
import type { StackOps } from './useStackOps'

export interface SetHeightFormProps {
  open: OpenPlan & { frame: Frame }
  ops: StackOps
  announce: (text: string) => void
}

function optionText(heightU: number, currentU: number): string {
  if (heightU === currentU) return `${heightU}U (now)`
  const delta = heightU - currentU
  return `${heightU}U (${delta > 0 ? '+' : '−'}${Math.abs(delta)}U)`
}

export function SetHeightForm({ open, ops, announce }: SetHeightFormProps) {
  const { plan, frame, lookup, readOnly, recording } = open
  const headingId = useId()
  const selectId = useId()
  const atLabelId = useId()
  const errorId = useId()
  const previewId = useId()
  const [at, setAt] = useState<StackEnd>('top')
  const [chosen, setChosen] = useState<number | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const rows = useMemo(() => stackRows(plan, frame), [plan, frame])
  const currentU = stackHeightU(rows)
  const heights = useMemo(() => reachableHeights(rows, frame, at), [rows, frame, at])
  const target =
    chosen !== undefined && heights.includes(chosen) ? chosen : defaultTargetU(heights, currentU)

  const preview = useMemo(() => {
    if (target === undefined || target === currentU) return undefined
    const result = setHeight(plan, frame, target, at, { catalog: lookup })
    if (result.error === undefined) return heightChangeText(rows, stackRows(result.plan, frame), at)
    if (!result.conflicts.some(isResolvable)) return result.error
    // Parts in the way: describe the sections anyway; Apply asks what to do with the parts.
    const lenient = setHeight(plan, frame, target, at, {
      catalog: lookup,
      straddle: 'lower',
      orphans: 'keep',
    })
    const change =
      lenient.error === undefined ? heightChangeText(rows, stackRows(lenient.plan, frame), at) : ''
    return `${change} Some parts are in the way: you will choose what happens to them.`.trim()
  }, [plan, frame, lookup, rows, target, currentU, at])

  function apply(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (target === undefined) return
    if (target === currentU) {
      setError(null)
      announce(`The rack is already ${currentU}U.`)
      return
    }
    const outcome = ops.run(setHeightRequest({ frame, lookup }, target, at, recording))
    if (outcome.status === 'error') {
      setError(outcome.message)
    } else {
      setError(null)
      if (outcome.status === 'applied') setChosen(undefined)
    }
  }

  return (
    <form
      aria-labelledby={headingId}
      onSubmit={apply}
      className="grid gap-3 rounded-lg border p-3"
      noValidate
    >
      <h3 id={headingId} className="text-sm font-medium">
        Set height
      </h3>
      <div className="grid gap-3 @sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={selectId}>Height</Label>
          <NativeSelect
            id={selectId}
            data-testid="rack-tab-set-height"
            value={target === undefined ? '' : String(target)}
            onChange={(event) => {
              const value = Number(event.target.value)
              if (Number.isInteger(value)) setChosen(value)
              setError(null)
            }}
            disabled={readOnly || heights.length === 0}
            aria-invalid={error === null ? undefined : true}
            aria-describedby={
              [preview === undefined ? '' : previewId, error === null ? '' : errorId]
                .filter((id) => id !== '')
                .join(' ') || undefined
            }
          >
            {heights.length === 0 ? <option value="">No reachable height</option> : null}
            {heights.map((heightU) => (
              <option key={heightU} value={heightU}>
                {optionText(heightU, currentU)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid content-start gap-1.5">
          <span id={atLabelId} className="text-sm font-medium">
            Add or remove sections
          </span>
          <RadioGroup
            value={at}
            onValueChange={(value) => {
              setAt(value === 'bottom' ? 'bottom' : 'top')
              setError(null)
            }}
            aria-labelledby={atLabelId}
            className="flex flex-wrap gap-x-4 gap-y-2"
            disabled={readOnly}
          >
            {(['top', 'bottom'] as const).map((end) => (
              <label key={end} className="flex cursor-pointer items-center gap-2 text-sm">
                <RadioGroupItem
                  value={end}
                  aria-label={end === 'top' ? 'At the top' : 'At the bottom'}
                />
                {end === 'top' ? 'At the top' : 'At the bottom'}
              </label>
            ))}
          </RadioGroup>
        </div>
      </div>
      {preview === undefined ? null : (
        <p id={previewId} className="text-sm text-muted-foreground">
          {preview}
        </p>
      )}
      {error === null ? null : (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          data-testid="rack-tab-apply-height"
          disabled={readOnly || target === undefined}
        >
          Apply
        </Button>
        <p className="text-xs text-muted-foreground">
          Only planned sections at that end change; sections in your rack stay.
        </p>
      </div>
    </form>
  )
}
