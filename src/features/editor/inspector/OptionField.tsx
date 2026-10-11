/**
 * One designer option, rendered from its definition: a boolean is a Switch, a choice a Select.
 * Used for item options, section options and the frame's rack/top/bottom/section options.
 */
import { useId } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { Option } from '@/domain/schema/catalog'
import type { OptionValue } from '@/domain/schema/common'

export function OptionField({
  option,
  value,
  onChange,
  disabled = false,
}: {
  option: Option
  value: OptionValue | undefined
  onChange: (value: OptionValue) => void
  disabled?: boolean
}) {
  const labelId = useId()
  const helpId = useId()
  const help =
    option.help === undefined ? null : (
      <span id={helpId} className="text-xs text-muted-foreground">
        {option.help}
      </span>
    )

  if (option.kind === 'boolean') {
    return (
      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="grid gap-0.5">
          <span id={labelId} className="text-sm">
            {option.label}
          </span>
          {help}
        </span>
        <Switch
          checked={value === true}
          onCheckedChange={(checked) => onChange(checked)}
          aria-labelledby={labelId}
          aria-describedby={help === null ? undefined : helpId}
          disabled={disabled}
        />
      </label>
    )
  }

  const choices = option.choices ?? []
  return (
    <div className="grid gap-1.5">
      <span id={labelId} className="text-sm">
        {option.label}
      </span>
      <Select
        value={typeof value === 'string' ? value : ''}
        onValueChange={(next) => {
          if (typeof next === 'string' && next !== value) onChange(next)
        }}
        items={choices.map((choice) => ({ value: choice.id, label: choice.label }))}
        disabled={disabled}
      >
        <SelectTrigger
          aria-labelledby={labelId}
          aria-describedby={help === null ? undefined : helpId}
          className="w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.id} value={choice.id}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {help}
    </div>
  )
}
