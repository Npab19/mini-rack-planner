/**
 * A whole-number field that saves when you leave it or press Enter (Escape reverts the typing),
 * so every keystroke is not an undo step. Values are rounded down and kept within min..max;
 * an empty or unreadable entry puts the old value back.
 */
import { useId, useState, type KeyboardEvent } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export interface CountFieldProps {
  label: string
  value: number
  min: number
  max: number
  onCommit: (value: number) => void
  /** Shown after the field and read as its description, e.g. "of 4". */
  suffix?: string
  disabled?: boolean
  testId?: string
}

export function CountField({
  label,
  value,
  min,
  max,
  onCommit,
  suffix,
  disabled = false,
  testId,
}: CountFieldProps) {
  const inputId = useId()
  const suffixId = useId()
  const [draft, setDraft] = useState<string | null>(null)

  function commit(): void {
    if (draft === null) return
    const text = draft.trim()
    setDraft(null)
    const parsed = Number(text)
    if (text === '' || !Number.isFinite(parsed)) return
    const next = Math.min(max, Math.max(min, Math.floor(parsed)))
    if (next !== value) onCommit(next)
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
    <div className="grid gap-1">
      <Label htmlFor={inputId} className="text-xs">
        {label}
      </Label>
      <span className="flex items-center gap-1.5">
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={draft ?? String(value)}
          disabled={disabled}
          aria-describedby={suffix === undefined ? undefined : suffixId}
          data-testid={testId}
          className="w-20 tabular-nums"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
        {suffix === undefined ? null : (
          <span id={suffixId} className="text-xs whitespace-nowrap text-muted-foreground">
            {suffix}
          </span>
        )}
      </span>
    </div>
  )
}
