import { Check, LoaderCircle, Lock, TriangleAlert, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePlanStore } from '@/state/planStore'

interface SaveView {
  label: string
  detail?: string
  icon: LucideIcon
  tone: SaveTone
  busy?: boolean
}

type SaveTone = 'saved' | 'saving' | 'read-only' | 'error'

/** The words stay muted (or red when not saved); the icon carries the state's colour. */
const TONE_CLASSES: Readonly<Record<SaveTone, { text: string; icon: string }>> = {
  saved: { text: 'text-muted-foreground', icon: 'text-have' },
  saving: { text: 'text-muted-foreground', icon: 'text-primary' },
  'read-only': { text: 'text-muted-foreground', icon: 'text-warning' },
  error: { text: 'text-destructive', icon: '' },
}

function useSaveView(): SaveView {
  const saveState = usePlanStore((state) => state.saveState)
  const conflict = usePlanStore((state) => state.conflict)
  const readOnly = usePlanStore((state) => state.readOnly)
  const lastError = usePlanStore((state) => state.lastError)
  if (readOnly) {
    return {
      label: 'Read-only',
      detail: 'made with a newer version',
      icon: Lock,
      tone: 'read-only',
    }
  }
  if (conflict !== null) {
    const detail = conflict.theirRev === null ? 'deleted in another tab' : 'changed in another tab'
    return { label: 'Not saved', detail, icon: TriangleAlert, tone: 'error' }
  }
  if (saveState === 'error') {
    return {
      label: 'Not saved',
      detail: lastError ?? undefined,
      icon: TriangleAlert,
      tone: 'error',
    }
  }
  if (saveState === 'saved') return { label: 'Saved', icon: Check, tone: 'saved' }
  // dirty (a save is due within moments) or saving
  return { label: 'Saving…', icon: LoaderCircle, tone: 'saving', busy: true }
}

/**
 * Saved / Saving… / Not saved (why) / Read-only: icon and words, never colour alone. Below `sm`
 * the reason is left to screen readers (the status banner above the editor explains it).
 */
export function SaveIndicator({ className }: { className?: string }) {
  const view = useSaveView()
  const Icon = view.icon
  const tone = TONE_CLASSES[view.tone]
  return (
    <p
      role="status"
      className={cn(
        'flex max-w-56 min-w-0 shrink-0 items-center gap-1.5 text-sm',
        tone.text,
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          'size-4 shrink-0',
          tone.icon,
          view.busy && 'animate-spin motion-reduce:animate-none',
        )}
      />
      <span data-testid="save-state" className="font-medium whitespace-nowrap">
        {view.label}
      </span>
      {view.detail === undefined ? null : (
        <span className="truncate max-sm:sr-only" title={view.detail}>
          ({view.detail})
        </span>
      )}
    </p>
  )
}
