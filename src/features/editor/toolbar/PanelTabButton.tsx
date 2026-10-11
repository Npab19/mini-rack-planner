import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PanelId } from '@/state/uiStore'
import { openSheet, useOpenSheet } from '../layout/shellStore'

export interface PanelTabButtonProps {
  panel: PanelId
  label: string
  icon: LucideIcon
  /** A short count over the icon ("3"); its meaning goes in `detail` for screen readers. */
  badge?: string
  /** Added to the label for screen readers, e.g. ": 2 errors, 1 warning". */
  detail?: string
  testId?: string
  /** The badge marks a problem (errors): drawn solid instead of outlined. */
  urgent?: boolean
}

/**
 * Below lg: one of the toolbar's panel buttons (Parts, Equipment, Inspector, Checks, BOM). Each
 * opens its panel as a sheet; opening one replaces any other.
 */
export function PanelTabButton({
  panel,
  label,
  icon: Icon,
  badge,
  detail,
  testId,
  urgent = false,
}: PanelTabButtonProps) {
  const open = useOpenSheet() === panel
  return (
    <Button
      variant="ghost"
      data-testid={testId ?? `toolbar-sheet-${panel}`}
      aria-label={detail === undefined ? undefined : `${label}${detail}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => openSheet(panel)}
      className="h-auto min-w-0 flex-col gap-0.5 px-0.5 py-1.5 text-[11px] leading-tight font-medium text-muted-foreground aria-expanded:text-foreground"
    >
      <span className="relative">
        <Icon aria-hidden className="size-5" />
        {badge === undefined ? null : (
          <span
            aria-hidden
            className={cn(
              'absolute -top-1.5 left-3.5 min-w-4 rounded-full border px-1 text-center text-[10px] leading-3.5 font-semibold tabular-nums',
              urgent
                ? 'border-foreground bg-foreground text-background'
                : 'border-dashed border-foreground/50 bg-background text-foreground',
            )}
          >
            {badge}
          </span>
        )}
      </span>
      <span className="max-w-full truncate">{label}</span>
    </Button>
  )
}
