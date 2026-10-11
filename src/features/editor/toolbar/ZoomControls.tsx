import { Scan, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUiStore } from '@/state/uiStore'
import { useEditorActions } from './editorActions'
import { canZoomIn, canZoomOut, formatZoom } from './zoom'

/**
 * Zoom out, the zoom (click: back to 100 %), zoom in, Fit. At a limit the button is marked
 * aria-disabled but stays focusable: pressing it says why nothing happens, and focus is never
 * dropped mid-way through a run of presses.
 */
export function ZoomControls() {
  const zoom = useUiStore((state) => state.zoom)
  const actions = useEditorActions()
  const percent = formatZoom(zoom)
  const atMin = !canZoomOut(zoom)
  const atMax = !canZoomIn(zoom)
  return (
    <div role="group" aria-label="Zoom" className="flex shrink-0 items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="toolbar-zoom-out"
        aria-label="Zoom out"
        aria-disabled={atMin || undefined}
        aria-keyshortcuts="["
        title="Zoom out ([)"
        className="aria-disabled:opacity-50"
        onClick={actions.zoomOut}
      >
        <ZoomOut aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        data-testid="toolbar-zoom-reset"
        aria-label={`Zoom ${percent}. Reset to 100%`}
        title="Reset to 100%"
        className="min-w-13 px-1.5 tabular-nums"
        onClick={actions.resetZoom}
      >
        {percent}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="toolbar-zoom-in"
        aria-label="Zoom in"
        aria-disabled={atMax || undefined}
        aria-keyshortcuts="]"
        title="Zoom in (])"
        className="aria-disabled:opacity-50"
        onClick={actions.zoomIn}
      >
        <ZoomIn aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        data-testid="toolbar-fit"
        aria-keyshortcuts="F"
        title="Fit the whole rack in view (F)"
        className="max-2xl:w-7 max-2xl:px-0"
        onClick={actions.fit}
      >
        <Scan aria-hidden />
        <span className="sr-only 2xl:not-sr-only">Fit</span>
      </Button>
    </div>
  )
}
