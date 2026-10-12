import type { LucideIcon } from 'lucide-react'
import { HAVE_NEED_CLASSES } from '@/components/common/HaveNeed'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PanelId } from '@/state/uiStore'
import { openSheet, useOpenSheet } from '../layout/shellStore'

/** What the badge counts: things in the plan, things to get, warnings, or errors. */
export type PanelBadgeTone = 'count' | 'need' | 'warning' | 'error'

/**
 * Errors are solid; the rest are outlined (To get dashed, as everywhere). The count's meaning is in
 * the button's accessible name, and the panel icon repeats the severity in its shape.
 */
const BADGE_CLASSES: Readonly<Record<PanelBadgeTone, string>> = {
  count: 'border-primary bg-accent text-accent-foreground',
  need: HAVE_NEED_CLASSES.need,
  warning: 'border-warning-border bg-warning-soft text-warning',
  error: 'border-destructive bg-destructive text-background',
}

export interface PanelTabButtonProps {
  panel: PanelId
  label: string
  icon: LucideIcon
  /** Colours the icon, e.g. by the worst finding. */
  iconClassName?: string
  /** A short count over the icon ("3"); its meaning goes in `detail` for screen readers. */
  badge?: string
  /** Added to the label for screen readers, e.g. ": 2 errors, 1 warning". */
  detail?: string
  testId?: string
  tone?: PanelBadgeTone
}

/**
 * Below lg: one of the toolbar's panel buttons (Parts, Equipment, Inspector, Checks, BOM). Each
 * opens its panel as a sheet; opening one replaces any other. The open one is tinted in the accent
 * and underlined with a bar, so it is marked by more than colour.
 */
export function PanelTabButton({
  panel,
  label,
  icon: Icon,
  iconClassName,
  badge,
  detail,
  testId,
  tone = 'count',
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
      className={cn(
        'relative h-auto min-w-0 flex-col gap-0.5 px-0.5 py-1.5 text-[11px] leading-tight font-medium text-muted-foreground',
        'aria-expanded:bg-accent aria-expanded:text-accent-foreground dark:aria-expanded:bg-accent',
        'after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary after:opacity-0 aria-expanded:after:opacity-100',
      )}
    >
      <span className="relative">
        <Icon aria-hidden className={cn('size-5', iconClassName)} />
        {badge === undefined ? null : (
          <span
            aria-hidden
            className={cn(
              'absolute -top-1.5 left-3.5 min-w-4 rounded-full border px-1 text-center text-[10px] leading-3.5 font-semibold tabular-nums',
              BADGE_CLASSES[tone],
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
