import { Check, ClipboardCopy, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react'
import {
  Component,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { isStaleChunkError, isUpdatePending, notifyNewVersion, reloadApp } from '@/app/updatePrompt'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { copyText } from '@/lib/clipboard'
import * as diagnostics from '@/lib/diagnostics'
import { cn } from '@/lib/utils'

type ButtonProps = ComponentProps<typeof Button>
type CopyStatus = 'idle' | 'working' | 'copied' | 'manual'

/** How long the button says "Copied" before offering to copy again. */
const COPIED_RESET_MS = 4000

const ANNOUNCEMENTS: Record<CopyStatus, string> = {
  idle: '',
  working: '',
  copied: 'Diagnostics copied to the clipboard.',
  manual: 'Copying is not available here. The diagnostics are in a text box below to copy by hand.',
}

/**
 * "Copy diagnostics": copies the redacted report. Where the clipboard is unavailable it shows the
 * report in a focused, selected text box instead. Renders sibling elements meant for a
 * `flex flex-wrap` row; the text box takes a full row of its own.
 */
export function CopyDiagnosticsButton({
  variant = 'outline',
  size = 'default',
  className,
}: {
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
  className?: string
}) {
  const [status, setStatus] = useState<CopyStatus>('idle')
  const [manualText, setManualText] = useState<string | null>(null)
  const busy = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const textareaId = useId()

  useEffect(() => {
    if (status !== 'copied') return
    const timer = setTimeout(() => setStatus('idle'), COPIED_RESET_MS)
    return () => clearTimeout(timer)
  }, [status])

  useEffect(() => {
    if (manualText === null) return
    textareaRef.current?.focus()
    textareaRef.current?.select()
  }, [manualText])

  async function copy(): Promise<void> {
    if (busy.current) return
    busy.current = true
    setStatus('working')
    try {
      const report = await diagnostics.collectReport()
      if (await copyText(report)) {
        setManualText(null)
        setStatus('copied')
      } else {
        setManualText(report)
        setStatus('manual')
      }
    } finally {
      busy.current = false
    }
  }

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        aria-busy={status === 'working' || undefined}
        onClick={() => void copy()}
      >
        {status === 'copied' ? <Check aria-hidden="true" /> : <ClipboardCopy aria-hidden="true" />}
        {status === 'copied' ? 'Copied' : 'Copy diagnostics'}
      </Button>
      <span role="status" className="sr-only">
        {ANNOUNCEMENTS[status]}
      </span>
      {manualText === null ? null : (
        <div className="flex basis-full flex-col gap-1.5">
          <label htmlFor={textareaId} className="text-xs text-muted-foreground">
            Copying is blocked in this browser. Select the text and copy it.
          </label>
          <Textarea
            id={textareaId}
            ref={textareaRef}
            readOnly
            rows={6}
            spellCheck={false}
            value={manualText}
            className="field-sizing-fixed max-h-48 font-mono text-xs md:text-xs"
          />
        </div>
      )}
    </>
  )
}

export interface ErrorCardProps {
  error: unknown
  /** Defaults to "This panel hit an error". */
  title?: string
  /** Shows "Try again" (not offered for a stale build: only a reload helps there). */
  onRetry?: () => void
  /** Defaults to saving pending work, then reloading. */
  onReload?: () => void
  className?: string
}

/** The compact error card: what happened, Try again, Reload and Copy diagnostics. */
export function ErrorCard({
  error,
  title = 'This panel hit an error',
  onRetry,
  onReload,
  className,
}: ErrorCardProps) {
  const update = isStaleChunkError(error) || isUpdatePending()
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    // The crash removed whatever had focus: move it here so keyboard and screen-reader users
    // land next to the way out. Focus elsewhere on the page is left alone.
    const active = document.activeElement
    if (active === null || active === document.body)
      headingRef.current?.focus({ preventScroll: true })
  }, [])

  const reload = onReload ?? (() => void reloadApp())
  const retry = update ? undefined : onRetry

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl bg-card p-4 text-sm text-card-foreground ring-1 ring-foreground/10',
        className,
      )}
    >
      <div role="alert" className="flex items-start gap-2.5">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 ref={headingRef} tabIndex={-1} className="font-medium outline-none">
            {update ? 'A new version is available' : title}
          </h2>
          <p className="text-muted-foreground">
            {update
              ? 'Reload to continue. Your saved plans are not affected.'
              : 'The rest of the app still works, and your saved plans are not affected.'}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {retry === undefined ? null : (
          <Button type="button" size="sm" onClick={retry}>
            <RotateCcw aria-hidden="true" />
            Try again
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant={retry === undefined ? 'default' : 'outline'}
          onClick={reload}
        >
          <RefreshCw aria-hidden="true" />
          Reload
        </Button>
        <CopyDiagnosticsButton size="sm" variant="ghost" />
      </div>
    </div>
  )
}

export interface ErrorFallbackProps {
  error: unknown
  name: string
  /** Clears the error and renders the children again (after `onReset`). */
  reset: () => void
}

export interface ErrorBoundaryProps {
  /** Short, stable name for diagnostics (`boundary:<name>`), e.g. "route" or "bom". */
  name: string
  children?: ReactNode
  /** Replaces the default ErrorCard: a node, or a function of the error and a reset callback. */
  fallback?: ReactNode | ((props: ErrorFallbackProps) => ReactNode)
  /** Runs before "Try again" renders the children again, e.g. to drop the state that crashed. */
  onReset?: () => void
  /** Overrides the default Reload (save pending work, then reload). */
  onReload?: () => void
  /** The boundary resets itself when one of these changes, e.g. the route's path. */
  resetKeys?: readonly unknown[]
  /** ErrorCard title; defaults to "This panel hit an error". */
  title?: string
  /** Classes for the default ErrorCard (placement). */
  className?: string
}

interface ErrorBoundaryState {
  failed: boolean
  error: unknown
}

function keysChanged(previous: readonly unknown[] = [], next: readonly unknown[] = []): boolean {
  return (
    previous.length !== next.length || previous.some((key, index) => !Object.is(key, next[index]))
  )
}

/**
 * Catches render errors below it, records them to diagnostics (with React's component stack)
 * and shows the ErrorCard instead of a blank screen. Stale-chunk errors also trigger the
 * "new version" prompt.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false, error: undefined }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { failed: true, error }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const source = `boundary:${this.props.name}`
    diagnostics.recordError(error, { source, componentStack: info.componentStack ?? undefined })
    if (isStaleChunkError(error)) notifyNewVersion({ source, error })
  }

  override componentDidUpdate(
    previousProps: ErrorBoundaryProps,
    previousState: ErrorBoundaryState,
  ): void {
    // Skip the update that caught the error: keys changing in that same render would loop.
    if (
      this.state.failed &&
      previousState.failed &&
      keysChanged(previousProps.resetKeys, this.props.resetKeys)
    ) {
      this.reset()
    }
  }

  reset = (): void => {
    this.props.onReset?.()
    this.setState({ failed: false, error: undefined })
  }

  override render(): ReactNode {
    const { children, fallback, name, onReload, title, className } = this.props
    if (!this.state.failed) return children
    const { error } = this.state
    if (typeof fallback === 'function') return fallback({ error, name, reset: this.reset })
    if (fallback !== undefined) return fallback
    return (
      <ErrorCard
        error={error}
        title={title}
        onRetry={this.reset}
        onReload={onReload}
        className={className}
      />
    )
  }
}

export type PanelErrorBoundaryProps = Omit<ErrorBoundaryProps, 'fallback' | 'title'>

/**
 * ErrorBoundary for one panel (inspector, BOM, checks, 3D view): a crash there shows the compact
 * card inside the panel and the rest of the editor keeps working.
 *
 *   <PanelErrorBoundary name="bom">
 *     <BomDrawer />
 *   </PanelErrorBoundary>
 */
export function PanelErrorBoundary({ className, ...props }: PanelErrorBoundaryProps) {
  return <ErrorBoundary {...props} className={cn('m-3', className)} />
}
