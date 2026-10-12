/**
 * The toolbar's live summaries: Checks (errors and warnings) and the bill of materials (lines to
 * get), plus the keyboard help button. On desktop they sit in the toolbar row; below lg the
 * Checks and BOM ones are panel buttons that open sheets. Each summary is fenced by an error
 * boundary: if checks or the BOM cannot be computed, the button still opens its panel (which then
 * shows the error) instead of taking the editor down.
 */
import { CircleCheck, CircleQuestionMark, CircleX, ShoppingCart, TriangleAlert } from 'lucide-react'
import { useMemo } from 'react'
import { HaveIcon, HaveNeedBadge } from '@/components/common/HaveNeed'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { Issue } from '@/domain/api'
import { shoppingLines } from '@/domain/bom'
import { cn } from '@/lib/utils'
import { useBom } from '@/state/derived'
import { useUiStore } from '@/state/uiStore'
import { useEditorIssues } from '../checks/useEditorIssues'
import { panelDomId } from '../layout/shellStore'
import { useEditorActions } from './editorActions'
import { PanelTabButton } from './PanelTabButton'

export type SummaryVariant = 'toolbar' | 'tab'

// ---------------------------------------------------------------------------------------------
// Checks

export interface IssueCounts {
  errors: number
  warnings: number
}

export function countIssues(issues: readonly Issue[]): IssueCounts {
  let errors = 0
  let warnings = 0
  for (const issue of issues) {
    if (issue.severity === 'error') errors += 1
    else if (issue.severity === 'warning') warnings += 1
  }
  return { errors, warnings }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** "2 errors, 1 warning" / "no problems". */
export function issueSummary({ errors, warnings }: IssueCounts): string {
  const parts: string[] = []
  if (errors > 0) parts.push(plural(errors, 'error'))
  if (warnings > 0) parts.push(plural(warnings, 'warning'))
  return parts.length === 0 ? 'no problems' : parts.join(', ')
}

type ChecksTone = 'unknown' | 'error' | 'warning' | 'clean'

function checksTone(counts: IssueCounts | null): ChecksTone {
  if (counts === null) return 'unknown'
  if (counts.errors > 0) return 'error'
  return counts.warnings > 0 ? 'warning' : 'clean'
}

/** The worst finding tints the chip; the icons and counts inside say the same in shapes and words. */
const CHECKS_TONE_CLASSES: Readonly<Record<ChecksTone, string>> = {
  unknown: '',
  error:
    'border-destructive/50 bg-destructive-soft hover:bg-destructive-soft/60 dark:border-destructive/50 dark:bg-destructive-soft dark:hover:bg-destructive-soft/60',
  warning:
    'border-warning-border bg-warning-soft hover:bg-warning-soft/60 dark:border-warning-border dark:bg-warning-soft dark:hover:bg-warning-soft/60',
  clean:
    'border-have-border bg-have-soft text-have hover:bg-have-soft/60 hover:text-have dark:border-have-border dark:bg-have-soft dark:hover:bg-have-soft/60',
}

function ChecksToolbarButton({ counts }: { counts: IssueCounts | null }) {
  const actions = useEditorActions()
  const errors = counts?.errors ?? 0
  const warnings = counts?.warnings ?? 0
  const tone = checksTone(counts)
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid="toolbar-checks"
      aria-label={counts === null ? 'Checks' : `Checks: ${issueSummary(counts)}`}
      title="Checks"
      className={CHECKS_TONE_CLASSES[tone]}
      onClick={actions.showChecks}
    >
      {tone === 'clean' ? <CircleCheck aria-hidden /> : null}
      <span>Checks</span>
      {errors > 0 ? (
        <span className="inline-flex items-center gap-0.5 font-semibold text-destructive">
          <CircleX aria-hidden className="size-3.5" />
          {errors}
        </span>
      ) : null}
      {warnings > 0 ? (
        <span className="inline-flex items-center gap-0.5 font-semibold text-warning">
          <TriangleAlert aria-hidden className="size-3.5" />
          {warnings}
        </span>
      ) : null}
    </Button>
  )
}

const CHECKS_ICON_CLASSES: Readonly<Record<ChecksTone, string>> = {
  unknown: '',
  error: 'text-destructive',
  warning: 'text-warning',
  clean: 'text-have',
}

function ChecksView({ counts, variant }: { counts: IssueCounts | null; variant: SummaryVariant }) {
  if (variant === 'toolbar') return <ChecksToolbarButton counts={counts} />
  const errors = counts?.errors ?? 0
  const warnings = counts?.warnings ?? 0
  const total = errors + warnings
  const tone = checksTone(counts)
  return (
    <PanelTabButton
      panel="checks"
      label="Checks"
      icon={errors > 0 ? CircleX : warnings > 0 ? TriangleAlert : CircleCheck}
      iconClassName={CHECKS_ICON_CLASSES[tone]}
      badge={total > 0 ? String(total) : undefined}
      tone={errors > 0 ? 'error' : 'warning'}
      detail={counts === null ? undefined : `: ${issueSummary(counts)}`}
      testId="toolbar-checks"
    />
  )
}

/**
 * The same issues the Checks panel lists (the checks plus the stack's own validation), so the
 * badge and the panel never disagree.
 */
function useIssueCounts(): IssueCounts {
  const issues = useEditorIssues()
  return useMemo(() => countIssues(issues), [issues])
}

function LiveChecksButton({ variant }: { variant: SummaryVariant }) {
  const counts = useIssueCounts()
  return <ChecksView counts={counts} variant={variant} />
}

/** Errors and warnings from the checks; opens the Checks panel. */
export function ChecksButton({ variant }: { variant: SummaryVariant }) {
  return (
    <ErrorBoundary name="toolbar-checks" fallback={<ChecksView counts={null} variant={variant} />}>
      <LiveChecksButton variant={variant} />
    </ErrorBoundary>
  )
}

// ---------------------------------------------------------------------------------------------
// Bill of materials

/** "nothing to get", "1 line to get", "9 lines to get". */
function toGetText(toGet: number): string {
  if (toGet === 0) return 'nothing to get'
  return toGet === 1 ? '1 line to get' : `${toGet} lines to get`
}

function BomToolbarButton({ toGet }: { toGet: number | null }) {
  const actions = useEditorActions()
  const open = useUiStore((state) => state.panels.bom)
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid="toolbar-bom"
      aria-label={toGet === null ? 'BOM' : `BOM: ${toGetText(toGet)}`}
      aria-expanded={open}
      aria-controls={panelDomId('bom')}
      aria-keyshortcuts="B"
      title="Bill of materials (B)"
      onClick={actions.toggleBom}
    >
      <ShoppingCart aria-hidden />
      <span>BOM</span>
      {toGet === null ? null : toGet === 0 ? (
        <Badge variant="have">
          <HaveIcon aria-hidden />
          Nothing to get
        </Badge>
      ) : (
        <HaveNeedBadge have={false} count={toGet} />
      )}
    </Button>
  )
}

function BomView({ toGet, variant }: { toGet: number | null; variant: SummaryVariant }) {
  if (variant === 'toolbar') return <BomToolbarButton toGet={toGet} />
  return (
    <PanelTabButton
      panel="bom"
      label="BOM"
      icon={ShoppingCart}
      badge={toGet !== null && toGet > 0 ? String(toGet) : undefined}
      tone="need"
      detail={toGet === null ? ': bill of materials' : `: bill of materials, ${toGetText(toGet)}`}
      testId="toolbar-bom"
    />
  )
}

function LiveBomButton({ variant }: { variant: SummaryVariant }) {
  const bom = useBom()
  const toGet = useMemo(() => (bom === undefined ? null : shoppingLines(bom).length), [bom])
  return <BomView toGet={toGet} variant={variant} />
}

/** Lines still to get (the shopping list); opens the bill of materials. */
export function BomButton({ variant }: { variant: SummaryVariant }) {
  return (
    <ErrorBoundary name="toolbar-bom" fallback={<BomView toGet={null} variant={variant} />}>
      <LiveBomButton variant={variant} />
    </ErrorBoundary>
  )
}

// ---------------------------------------------------------------------------------------------
// Keyboard help

export function HelpButton({ className }: { className?: string }) {
  const actions = useEditorActions()
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      data-testid="toolbar-help"
      aria-label="Keyboard shortcuts"
      aria-haspopup="dialog"
      aria-keyshortcuts="?"
      title="Keyboard shortcuts (?)"
      className={cn('shrink-0', className)}
      onClick={actions.openHelp}
    >
      <CircleQuestionMark aria-hidden />
    </Button>
  )
}
