import { useDroppable } from '@dnd-kit/react'
import { useCallback, type KeyboardEvent, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import {
  FACE_COLLISION_DETECTOR,
  FRONT_FACE_DROPPABLE_ID,
  PALETTE_DRAGGABLE_TYPE,
} from './dndConfig'
import { DRAWING, RACK_UNITS, type ItemKind, type Placement } from './rackModel'
import { RackDrawing } from './RackDrawing'
import type { FaceHandlers, Ghost } from './useRackDnd'
import type { RackView } from './useRackView'

export interface RackCanvasProps {
  view: RackView
  viewportRef: RefObject<HTMLDivElement | null>
  svgRef: RefObject<SVGSVGElement | null>
  placements: readonly Placement[]
  ghost: Ghost | null
  movingId: string | null
  armed: ItemKind | null
  faceHandlers: FaceHandlers
  keyboardHelpId: string
  onItemKeyDown: (placement: Placement, event: KeyboardEvent<SVGGElement>) => void
}

/**
 * The front face: a clipping viewport that is the single dnd-kit droppable, holding the SVG
 * drawing. The droppable is the viewport (not the rack <rect>) because getBoundingClientRect of
 * an SVG node ignores overflow clipping: a rect panned half out of view would still "catch" drops
 * over the palette next to the canvas.
 */
export function RackCanvas({
  view,
  viewportRef,
  svgRef,
  placements,
  ghost,
  movingId,
  armed,
  faceHandlers,
  keyboardHelpId,
  onItemKeyDown,
}: RackCanvasProps) {
  const { ref: droppableRef, isDropTarget } = useDroppable({
    id: FRONT_FACE_DROPPABLE_ID,
    accept: PALETTE_DRAGGABLE_TYPE,
    collisionDetector: FACE_COLLISION_DETECTOR,
  })
  const setViewport = useCallback(
    (node: HTMLDivElement | null) => {
      viewportRef.current = node
      droppableRef(node)
    },
    [viewportRef, droppableRef],
  )

  const drawing = (
    <RackDrawing
      placements={placements}
      ghost={ghost}
      movingId={movingId}
      keyboardHelpId={keyboardHelpId}
      onItemKeyDown={onItemKeyDown}
    />
  )
  const svgLabel = `Rack front, ${RACK_UNITS}U`

  return (
    <div
      ref={setViewport}
      tabIndex={-1}
      data-testid="rack-canvas"
      data-view-mode={view.mode}
      data-zoom={view.zoom}
      data-center-x={view.center.x.toFixed(2)}
      data-center-y={view.center.y.toFixed(2)}
      data-drop-target={isDropTarget}
      className={cn(
        'relative size-full touch-none overflow-hidden rounded-xl border bg-muted/30 outline-none select-none [-webkit-touch-callout:none]',
        isDropTarget && 'ring-2 ring-ring/60',
        armed ? 'cursor-copy' : 'cursor-grab active:cursor-grabbing',
      )}
      {...faceHandlers}
    >
      {view.mode === 'viewbox' ? (
        <svg
          ref={svgRef}
          data-testid="rack-svg"
          role="group"
          aria-label={svgLabel}
          viewBox={view.geometry.viewBox}
          className="absolute inset-0 size-full"
        >
          {drawing}
        </svg>
      ) : (
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ transform: view.geometry.transform }}
        >
          <svg
            ref={svgRef}
            data-testid="rack-svg"
            role="group"
            aria-label={svgLabel}
            width={view.geometry.svgWidth}
            height={view.geometry.svgHeight}
            viewBox={`${DRAWING.minX} ${DRAWING.minY} ${DRAWING.width} ${DRAWING.height}`}
          >
            {drawing}
          </svg>
        </div>
      )}
    </div>
  )
}
