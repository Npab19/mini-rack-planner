import { DragDropProvider, DragOverlay } from '@dnd-kit/react'
import { useCallback, useId, useReducer, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { DndStyleProbe, type StyleProbe } from './spike-dnd/DndStyleProbe'
import { PALETTE_PLUGINS, PALETTE_SENSORS, paletteKindOf } from './spike-dnd/dndConfig'
import { Palette, PaletteChip } from './spike-dnd/Palette'
import { RackCanvas } from './spike-dnd/RackCanvas'
import type { ItemKind, Placement, Sixths } from './spike-dnd/rackModel'
import { readSpikeParams, SEED_PLACEMENTS } from './spike-dnd/spikeParams'
import { SvgDraggableProbe } from './spike-dnd/SvgDraggableProbe'
import { useAnnouncer, type Announcement } from './spike-dnd/useAnnouncer'
import { useRackDnd, type DropStats, type RackAction } from './spike-dnd/useRackDnd'
import { useRackView } from './spike-dnd/useRackView'
import { useSvgDndMutationCount } from './spike-dnd/useSvgDndMutationCount'
import { ViewToolbar } from './spike-dnd/ViewToolbar'

type StoredAction =
  | { type: 'add'; id: string; kind: ItemKind; y: Sixths }
  | { type: 'move'; id: string; y: Sixths }
  | { type: 'remove'; id: string }

function placementsReducer(
  state: readonly Placement[],
  action: StoredAction,
): readonly Placement[] {
  switch (action.type) {
    case 'add':
      return [...state, { id: action.id, kind: action.kind, y: action.y }]
    case 'move':
      return state.map((p) => (p.id === action.id ? { ...p, y: action.y } : p))
    case 'remove':
      return state.filter((p) => p.id !== action.id)
  }
}

/**
 * Spike S2 (drag-and-drop onto the to-scale SVG rack). Dev-only route: /dev/spike-dnd
 * Findings and the useRackDnd contract: docs/spikes/s2-dnd.md. Verified by scripts/spikes/dnd-check.ts.
 */
export function SpikeDndPage() {
  const [searchParams] = useSearchParams()
  const [params] = useState(() => readSpikeParams(searchParams))
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const view = useRackView(viewportRef, params)
  const [placements, dispatch] = useReducer(
    placementsReducer,
    params.seed === 'empty' ? [] : SEED_PLACEMENTS,
  )
  const nextIdRef = useRef(1)
  const { announcement, announce } = useAnnouncer()

  // Ids come from a counter, not crypto.randomUUID (missing on plain-HTTP LAN origins).
  const commit = useCallback((action: RackAction) => {
    if (action.type === 'add') {
      dispatch({ ...action, id: `p-${nextIdRef.current}` })
      nextIdRef.current += 1
    } else {
      dispatch(action)
    }
  }, [])

  const dnd = useRackDnd({
    svgRef,
    viewportRef,
    placements,
    commit,
    announce,
    onPan: view.panBy,
    viewKey: view.viewKey,
  })
  const [styleProbe, setStyleProbe] = useState<StyleProbe | null>(null)
  const svgDndMutations = useSvgDndMutationCount(viewportRef)
  const keyboardHelpId = useId()

  return (
    <div className="mx-auto flex w-full max-w-screen-2xl flex-1 flex-col gap-3 p-3 lg:h-[calc(100dvh-3rem)] lg:p-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold tracking-tight">
          Spike S2 · drag and drop onto the to-scale SVG rack
        </h1>
        <p className="text-sm text-muted-foreground">
          Drag a palette item onto the rack, or select it and tap a U. Drag placed items (press and
          hold first on touch). Wheel or drag the background to pan.
        </p>
      </header>

      <DragDropProvider
        sensors={PALETTE_SENSORS}
        plugins={PALETTE_PLUGINS}
        {...dnd.providerHandlers}
      >
        <DndStyleProbe onProbe={setStyleProbe} />
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="flex flex-col gap-4">
            <Palette armed={dnd.armed} onArm={dnd.arm} onAddAtU={dnd.addAtU} />
            <p id={keyboardHelpId} className="text-xs leading-relaxed text-muted-foreground">
              Focus a placed item: <Kbd>↑</Kbd> <Kbd>↓</Kbd> move 1U, with <Kbd>Shift</Kbd> 5U;{' '}
              <Kbd>Delete</Kbd> removes it.
            </p>
            <DebugPanel
              stats={dnd.stats}
              styleProbe={styleProbe}
              svgDndMutations={svgDndMutations}
              placements={placements}
            />
          </aside>
          <section className="flex min-h-0 flex-col gap-2" aria-label="Rack editor">
            <ViewToolbar view={view} />
            <div className="h-[50dvh] min-h-[20rem] lg:h-auto lg:min-h-0 lg:flex-1">
              <RackCanvas
                view={view}
                viewportRef={viewportRef}
                svgRef={svgRef}
                placements={placements}
                ghost={dnd.ghost}
                movingId={dnd.movingId}
                armed={dnd.armed}
                faceHandlers={dnd.faceHandlers}
                keyboardHelpId={keyboardHelpId}
                onItemKeyDown={dnd.onItemKeyDown}
              />
            </div>
            <Announcer announcement={announcement} />
          </section>
        </div>
        {/*
          The overlay's wrapper div stays in the DOM while idle and only leaves the flow (Feedback
          makes it position: fixed) once a drag starts. Out of flow here, so starting a drag never
          reflows the editor; and outside every transformed element.
        */}
        <div className="absolute top-0 left-0">
          <DragOverlay
            dropAnimation={null}
            className={cn('rounded-lg p-0.5', dnd.ghost?.origin === 'palette' && 'opacity-40')}
          >
            {(source) => {
              const kind = paletteKindOf(source)
              return kind ? (
                <div className="flex size-full items-center rounded-lg border bg-card px-3 shadow-lg">
                  <PaletteChip kind={kind} />
                </div>
              ) : null
            }}
          </DragOverlay>
        </div>
      </DragDropProvider>

      {params.probe && <SvgDraggableProbe mode={params.probe} />}
    </div>
  )
}

function Announcer({ announcement }: { announcement: Announcement }) {
  return (
    <p
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="announcer"
      data-seq={announcement.seq}
      className="min-h-5 text-sm"
    >
      <span key={announcement.seq}>{announcement.message}</span>
    </p>
  )
}

function DebugPanel({
  stats,
  styleProbe,
  svgDndMutations,
  placements,
}: {
  stats: DropStats
  styleProbe: StyleProbe | null
  svgDndMutations: number
  placements: readonly Placement[]
}) {
  const rows: Array<[string, string]> = [
    ['Placed', String(placements.length)],
    ['Palette drops', String(stats.drops)],
    ['dnd-kit target agreed', `${stats.targetAgreed}/${stats.drops}`],
    ['dnd-kit writes to SVG', String(svgDndMutations)],
    ['dnd-kit <style> first in <head>', styleProbe ? String(styleProbe.styleFirst) : '–'],
    ['Overlay in top layer', styleProbe ? String(styleProbe.overlayInTopLayer) : '–'],
  ]
  return (
    <dl
      data-testid="spike-debug"
      data-drops={stats.drops}
      data-target-agreed={stats.targetAgreed}
      data-svg-dnd-mutations={svgDndMutations}
      data-style-first={styleProbe ? String(styleProbe.styleFirst) : 'unknown'}
      data-overlay-overflow={styleProbe?.overlayOverflow ?? ''}
      data-overlay-padding={styleProbe?.overlayPaddingTop ?? ''}
      data-overlay-top-layer={styleProbe ? String(styleProbe.overlayInTopLayer) : 'unknown'}
      data-last-drop={stats.last}
      className="hidden grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-lg border p-3 text-xs lg:grid"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
