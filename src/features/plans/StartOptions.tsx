import { ClipboardList, LoaderCircle, Sparkles, SquarePlus, type LucideIcon } from 'lucide-react'
import { useId } from 'react'
import { cn } from '@/lib/utils'

/** The three ways to start: record a built rack, plan a new one, or open the sample. */
export type StartChoice = 'record' | 'new' | 'sample'

interface StartOption {
  choice: StartChoice
  icon: LucideIcon
  title: string
  description: string
}

export const START_OPTIONS: readonly StartOption[] = [
  {
    choice: 'record',
    icon: ClipboardList,
    title: 'Record my rack and plan an upgrade',
    description: 'Enter what you have built today, then plan what to add and get a shopping list.',
  },
  {
    choice: 'new',
    icon: SquarePlus,
    title: 'Plan a new rack',
    description: 'Pick a frame, choose its sections and fit your equipment.',
  },
  {
    choice: 'sample',
    icon: Sparkles,
    title: 'Open the sample',
    description: 'A KWS Rack v2 going from 9U to 12U.',
  },
]

function StartButton({
  option,
  busy,
  disabled,
  onChoose,
}: {
  option: StartOption
  busy: boolean
  disabled: boolean
  onChoose: (choice: StartChoice) => void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const Icon = busy ? LoaderCircle : option.icon
  return (
    <button
      type="button"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={() => onChoose(option.choice)}
      className={cn(
        'flex h-full w-full flex-col items-start gap-2 rounded-xl bg-card p-4 text-left text-sm ring-1 ring-foreground/10 transition-colors outline-none',
        'hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60',
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          'size-5 text-muted-foreground',
          busy && 'animate-spin motion-reduce:animate-none',
        )}
      />
      <span id={titleId} className="text-base leading-snug font-medium">
        {busy ? `${option.title}…` : option.title}
      </span>
      <span id={descriptionId} className="text-muted-foreground">
        {option.description}
      </span>
    </button>
  )
}

/** The start choices as large buttons, in a responsive grid. */
export function StartOptions({
  onChoose,
  busyChoice = null,
  className,
}: {
  onChoose: (choice: StartChoice) => void
  /** A choice that is working (the sample being created): shown busy, the others disabled. */
  busyChoice?: StartChoice | null
  className?: string
}) {
  return (
    <ul className={cn('grid gap-3 sm:grid-cols-3', className)}>
      {START_OPTIONS.map((option) => (
        <li key={option.choice}>
          <StartButton
            option={option}
            busy={busyChoice === option.choice}
            disabled={busyChoice !== null}
            onChoose={onChoose}
          />
        </li>
      ))}
    </ul>
  )
}
