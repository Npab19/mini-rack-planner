/**
 * "In my rack" / "To get" as a two-option radio group styled like a segmented control. Words,
 * icon and pattern carry the state (never colour alone): the owned segment is solid when chosen,
 * the to-get segment gets a dashed outline, like the badges in the rest of the app. Colour repeats
 * it: solid green for In my rack, soft amber for To get.
 */
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { HAVE_TEXT, HaveIcon, NEED_TEXT, NeedIcon } from '@/components/common/HaveNeed'
import { cn } from '@/lib/utils'

export interface HaveNeedToggleProps {
  have: boolean
  /** Accessible name of the group, e.g. "Lenovo Tiny mount 1U: in my rack or to get". */
  label: string
  onChange: (have: boolean) => void
  disabled?: boolean
  size?: 'sm' | 'default'
  className?: string
  testId?: string
}

export function HaveNeedToggle({
  have,
  label,
  onChange,
  disabled = false,
  size = 'default',
  className,
  testId,
}: HaveNeedToggleProps) {
  return (
    <RadioGroup
      value={have ? 'have' : 'need'}
      onValueChange={(value) => {
        const next = value === 'have'
        if (next !== have) onChange(next)
      }}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      className={cn('inline-flex w-fit shrink-0 rounded-lg border bg-background p-0.5', className)}
    >
      {(['have', 'need'] as const).map((value) => {
        const Icon = value === 'have' ? HaveIcon : NeedIcon
        return (
          <Radio.Root
            key={value}
            value={value}
            className={cn(
              'inline-flex cursor-pointer items-center gap-1 rounded-md border border-transparent px-2 text-xs whitespace-nowrap text-muted-foreground outline-none select-none',
              size === 'sm' ? 'h-6' : 'h-7',
              'focus-visible:ring-3 focus-visible:ring-ring/50',
              'data-disabled:cursor-not-allowed data-disabled:opacity-60',
              value === 'have'
                ? 'data-checked:bg-have data-checked:font-semibold data-checked:text-have-foreground'
                : 'data-checked:border-dashed data-checked:border-need-border data-checked:bg-need-soft data-checked:font-semibold data-checked:text-need',
            )}
          >
            <Icon aria-hidden className="size-3.5" />
            {value === 'have' ? HAVE_TEXT : NEED_TEXT}
          </Radio.Root>
        )
      })}
    </RadioGroup>
  )
}
