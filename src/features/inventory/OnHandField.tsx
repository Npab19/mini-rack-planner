/**
 * How many of one part are on hand: − / the number / + and the unit, used on the On hand page and
 * in the bill of materials. Typing saves on Enter, on leaving the field and after a short pause
 * (`useCommitField`); Escape puts the stored number back; an empty field means none. The buttons
 * add or take away one at once (100 mm for stock sold by length). The minus button stays
 * focusable at 0, so focus never drops out of the row.
 */
import { Minus, Plus, TriangleAlert } from 'lucide-react'
import { useId, type Ref } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { BomUnit } from '@/domain/api'
import { parseDecimal } from '@/features/settings/format'
import { useCommitField, type FieldParse } from '@/features/settings/useCommitField'
import { cn } from '@/lib/utils'

/** The largest count the field takes (a typo such as 2000000 is caught, not saved). */
export const MAX_ON_HAND = 1_000_000

/** What one press of − or + changes: one piece, or 100 mm of stock. */
export function stepOf(unit: BomUnit): number {
  return unit === 'mm' ? 100 : 1
}

/** Whole pieces (or plates); stock by length to 0.1 mm. Empty is 0. */
export function parseOnHand(text: string, unit: BomUnit): FieldParse<number> {
  const parsed = parseDecimal(text)
  if (parsed.kind === 'empty') return { ok: true, value: 0 }
  if (parsed.kind === 'invalid') {
    return { ok: false, message: 'Enter a number using digits, like 20.' }
  }
  if (unit !== 'mm' && !Number.isInteger(parsed.value)) {
    return { ok: false, message: 'Enter a whole number, like 20.' }
  }
  const value = unit === 'mm' ? Math.round(parsed.value * 10) / 10 : parsed.value
  if (value > MAX_ON_HAND) return { ok: false, message: 'Enter 1000000 or less.' }
  return { ok: true, value }
}

export interface OnHandFieldProps {
  /** The part's name: the field is read as "On hand: <name>". */
  name: string
  value: number
  unit: BomUnit
  /** Saves a typed count; resolves false when that failed (the typing is kept to try again). */
  onSet: (qty: number) => Promise<boolean>
  /** Adds (or, negative, takes away) one step. */
  onStep: (delta: number) => void
  disabled?: boolean
  /** data-testid of the number field; the buttons get `-minus` and `-plus`. */
  testId?: string
  className?: string
  /** The number field, e.g. to focus it when a popover opens. */
  inputRef?: Ref<HTMLInputElement>
}

export function OnHandField({
  name,
  value,
  unit,
  onSet,
  onStep,
  disabled = false,
  testId,
  className,
  inputRef,
}: OnHandFieldProps) {
  const id = useId()
  const unitId = `${id}-unit`
  const errorId = `${id}-error`
  const step = stepOf(unit)
  const field = useCommitField<number>({
    value,
    format: (qty) => String(qty),
    parse: (text) => parseOnHand(text, unit),
    onCommit: onSet,
  })
  const stepText = unit === 'mm' ? `${step} mm` : String(step)
  const describedBy = [unitId, field.error === null ? undefined : errorId]
    .filter((part) => part !== undefined)
    .join(' ')

  return (
    <div className={cn('flex flex-col items-end gap-1', className)}>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          aria-label={`Take away ${stepText}: ${name}`}
          data-testid={testId === undefined ? undefined : `${testId}-minus`}
          disabled={disabled || value <= 0}
          focusableWhenDisabled
          onClick={() => onStep(-Math.min(step, value))}
        >
          <Minus aria-hidden />
        </Button>
        <Input
          ref={inputRef}
          id={id}
          aria-label={`On hand: ${name}`}
          aria-describedby={describedBy}
          inputMode={unit === 'mm' ? 'decimal' : 'numeric'}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
          disabled={disabled}
          data-testid={testId}
          className="w-[4.75rem] text-right font-medium tabular-nums"
          {...field.inputProps}
        />
        <Button
          variant="outline"
          size="icon"
          aria-label={`Add ${stepText}: ${name}`}
          data-testid={testId === undefined ? undefined : `${testId}-plus`}
          disabled={disabled || value >= MAX_ON_HAND}
          focusableWhenDisabled
          onClick={() => onStep(Math.min(step, MAX_ON_HAND - value))}
        >
          <Plus aria-hidden />
        </Button>
        <span id={unitId} className="w-10 text-xs text-muted-foreground">
          {unit}
        </span>
      </div>
      {field.error === null ? null : (
        <p
          id={errorId}
          role="alert"
          className="flex max-w-56 items-start gap-1 text-xs text-destructive"
        >
          <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          {field.error}
        </p>
      )}
    </div>
  )
}
