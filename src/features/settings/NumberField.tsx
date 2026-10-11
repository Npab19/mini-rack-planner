import { TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { formatDecimal, parseDecimal, roundTo } from './format'
import { useCommitField, type FieldParse } from './useCommitField'

export interface NumberFieldProps {
  id: string
  label: ReactNode
  /** The stored value; undefined shows an empty field. */
  value: number | undefined
  /** Saves a new value (undefined: cleared, only when `optional`). Resolves false on failure. */
  onCommit: (value: number | undefined) => Promise<boolean>
  /** Shown after the field and read with it, e.g. "USD per kg", "%", "mm". */
  unit?: string
  hint?: ReactNode
  /** Inclusive bounds. */
  min?: number
  max?: number
  /** Decimal places kept (more are rounded away). */
  decimals?: number
  /** An empty field is allowed and means "no value". */
  optional?: boolean
  /** Shown for an empty field that is not optional, or a number out of range. */
  requiredMessage?: string
  rangeMessage?: string
  placeholder?: string
  disabled?: boolean
  className?: string
}

/**
 * A labelled number that saves itself (see useCommitField). A text input with a decimal keypad
 * rather than type="number": it takes a decimal comma, never turns a half-typed "1e" into an
 * empty value, and has no spin buttons that save on every click.
 */
export function NumberField({
  id,
  label,
  value,
  onCommit,
  unit,
  hint,
  min = 0,
  max,
  decimals = 2,
  optional = false,
  requiredMessage = 'Enter a number.',
  rangeMessage,
  placeholder,
  disabled,
  className,
}: NumberFieldProps) {
  const parse = (text: string): FieldParse<number | undefined> => {
    const parsed = parseDecimal(text)
    if (parsed.kind === 'empty') {
      return optional ? { ok: true, value: undefined } : { ok: false, message: requiredMessage }
    }
    if (parsed.kind === 'invalid') {
      return { ok: false, message: 'Enter a number using digits, like 22.5.' }
    }
    const rounded = roundTo(parsed.value, decimals)
    if (rounded < min || (max !== undefined && rounded > max)) {
      const range = max === undefined ? `${min} or more` : `from ${min} to ${max}`
      return { ok: false, message: rangeMessage ?? `Enter a number ${range}.` }
    }
    return { ok: true, value: rounded }
  }

  const field = useCommitField<number | undefined>({
    value,
    format: (next) => formatDecimal(next, decimals),
    parse,
    onCommit,
  })

  const unitId = `${id}-unit`
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy =
    [
      unit === undefined ? undefined : unitId,
      hint === undefined ? undefined : hintId,
      field.error === null ? undefined : errorId,
    ]
      .filter((part) => part !== undefined)
      .join(' ') || undefined

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
          placeholder={placeholder}
          disabled={disabled}
          aria-describedby={describedBy}
          className="w-24"
          {...field.inputProps}
        />
        {unit === undefined ? null : (
          <span id={unitId} className="text-sm text-muted-foreground">
            {unit}
          </span>
        )}
      </div>
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {field.error === null ? null : (
        <p id={errorId} role="alert" className="flex items-start gap-1 text-xs text-destructive">
          <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          {field.error}
        </p>
      )}
    </div>
  )
}
