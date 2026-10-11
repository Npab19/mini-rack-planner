import { Feedback } from '@dnd-kit/dom'
import { DragDropProvider, useDraggable } from '@dnd-kit/react'

export type SvgProbeMode = 'default' | 'guarded'

const GUARDED_PLUGINS = [Feedback.configure({ feedback: 'none' })]

/**
 * Pitfall probe, shown only with `?probe=svg-default` or `?probe=svg-guarded`: an SVG <rect>
 * registered as a dnd-kit draggable in its own provider with no DragOverlay, drawn at 4 px per
 * user unit. With the default Feedback the rect itself gets restyled; with per-draggable
 * `Feedback.configure({ feedback: 'none' })` nothing touches it.
 */
export function SvgDraggableProbe({ mode }: { mode: SvgProbeMode }) {
  return (
    <section className="flex flex-col gap-2 rounded-xl border p-3" data-testid="svg-probe-section">
      <h2 className="text-sm font-semibold">
        Pitfall probe: an SVG node as a dnd-kit draggable (Feedback{' '}
        {mode === 'guarded' ? 'none' : 'default'})
      </h2>
      <DragDropProvider>
        <ProbeDrawing mode={mode} />
      </DragDropProvider>
    </section>
  )
}

function ProbeDrawing({ mode }: { mode: SvgProbeMode }) {
  const { ref, isDragging } = useDraggable({
    id: 'svg-probe',
    plugins: mode === 'guarded' ? GUARDED_PLUGINS : undefined,
  })
  return (
    <svg
      data-testid="svg-probe"
      viewBox="0 0 100 50"
      width={400}
      height={200}
      className="touch-none rounded-lg border bg-background"
    >
      <rect
        ref={ref}
        data-probe-rect=""
        data-probe-dragging={isDragging}
        x={10}
        y={10}
        width={20}
        height={20}
        className="fill-sky-500"
      />
    </svg>
  )
}
