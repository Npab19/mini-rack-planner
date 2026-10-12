/**
 * How a device sits in its slot: flat, turned 90°, on its side or upright, as far as the slot
 * allows. A radio group styled like a segmented control (icon + words), one option per allowed
 * orientation. Orientations that do not work (too big that way, no room left beside the others,
 * the part would hit something) are disabled, and the reasons are listed under the group and tied
 * to it with `aria-describedby`, so they are never only a greyed-out look. The current way is
 * bold, outlined in the primary colour and tinted with the accent; blocked ones are struck through.
 */
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import {
  ArrowUpFromLine,
  CircleX,
  RectangleHorizontal,
  RectangleVertical,
  RotateCwSquare,
  type LucideIcon,
} from 'lucide-react'
import { useId } from 'react'
import type { OrientationChoice } from '@/domain/devices'
import type { Orientation } from '@/domain/schema/common'
import { cn } from '@/lib/utils'

/** Short labels for the picker. */
export const ORIENTATION_LABELS: Readonly<Record<Orientation, string>> = {
  flat: 'Flat',
  'flat-rotated': 'Turned 90°',
  'on-side': 'On its side',
  upright: 'Upright',
}

const ORIENTATION_ICONS: Readonly<Record<Orientation, LucideIcon>> = {
  flat: RectangleHorizontal,
  'flat-rotated': RotateCwSquare,
  'on-side': RectangleVertical,
  upright: ArrowUpFromLine,
}

/** "flat", "turned 90°", "on its side", "upright": how a device sits, after "now sits". */
const SITS_TEXT: Readonly<Record<Orientation, string>> = {
  flat: 'flat',
  'flat-rotated': 'turned 90°',
  'on-side': 'on its side',
  upright: 'upright',
}

/** "The Raspberry Pi 5 now sits on its side." */
export function turnedText(deviceLabel: string, orientation: Orientation): string {
  return `The ${deviceLabel} now sits ${SITS_TEXT[orientation]}.`
}

function isOrientation(value: unknown): value is Orientation {
  return typeof value === 'string' && Object.hasOwn(ORIENTATION_LABELS, value)
}

export interface OrientationPickerProps {
  choices: readonly OrientationChoice[]
  /** The device's name, for the group's accessible name: "Raspberry Pi 5: how it sits". */
  deviceLabel: string
  onChange: (orientation: Orientation) => void
  disabled?: boolean
  testId?: string
}

export function OrientationPicker({
  choices,
  deviceLabel,
  onChange,
  disabled = false,
  testId,
}: OrientationPickerProps) {
  const reasonsId = useId()
  const current = choices.find((choice) => choice.current)?.orientation
  const blocked = choices.filter((choice) => !choice.ok)
  return (
    <div className="grid gap-1">
      <RadioGroup
        value={current ?? ''}
        onValueChange={(value) => {
          if (isOrientation(value) && value !== current) onChange(value)
        }}
        aria-label={`${deviceLabel}: how it sits`}
        aria-describedby={blocked.length === 0 ? undefined : reasonsId}
        disabled={disabled}
        data-testid={testId}
        className="inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-lg border bg-background p-0.5"
      >
        {choices.map((choice) => {
          const Icon = ORIENTATION_ICONS[choice.orientation]
          return (
            <Radio.Root
              key={choice.orientation}
              value={choice.orientation}
              disabled={!choice.ok}
              className={cn(
                'inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-transparent px-2 text-xs whitespace-nowrap text-muted-foreground outline-none select-none',
                'focus-visible:ring-3 focus-visible:ring-ring/50',
                'data-checked:border-primary data-checked:bg-accent data-checked:font-semibold data-checked:text-accent-foreground',
                'data-disabled:cursor-not-allowed data-disabled:line-through data-disabled:opacity-60',
              )}
            >
              <Icon aria-hidden className="size-3.5 shrink-0" />
              {ORIENTATION_LABELS[choice.orientation]}
            </Radio.Root>
          )
        })}
      </RadioGroup>
      {blocked.length === 0 ? null : (
        <ul id={reasonsId} className="grid gap-0.5 text-xs text-muted-foreground">
          {blocked.map((choice) => (
            <li key={choice.orientation} className="flex items-start gap-1">
              <CircleX aria-hidden className="mt-px size-3 shrink-0" />
              <span className="min-w-0 break-words">
                {ORIENTATION_LABELS[choice.orientation]}: {choice.reason ?? 'it does not fit.'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
