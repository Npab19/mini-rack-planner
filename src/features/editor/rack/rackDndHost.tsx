/**
 * The dnd-kit side of rack drags, loaded lazily by `RackDndProvider` (it needs a real browser as
 * soon as it loads). It renders the `DragDropProvider` with `RACK_DND_SENSORS` and
 * `RACK_DND_PLUGINS` and the `DragOverlay` chip out of the layout flow, hands the manager and the
 * entity factories to the editor (`onReady`), and passes drag events to the rack on screen
 * (`rackDropTarget`), which hit-tests the pointer itself and commits the drop.
 *
 * The drag sources and the face droppable register on this manager from outside this subtree
 * (`dragSources.ts`); dnd-kit's React context is only needed by the overlay here.
 */
import { Draggable, Droppable } from '@dnd-kit/dom'
import {
  DragDropProvider,
  DragOverlay,
  useDragDropManager,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/react'
import { CircleCheck, CircleDot, CircleX, GripVertical, Move } from 'lucide-react'
import { useLayoutEffect } from 'react'
import { cn } from '@/lib/utils'
import { usePlanLookup } from '@/state/derived'
import { useEditorState } from '../editorState'
import { announce } from '../layout/announcer'
import { FACE_COLLISION_DETECTOR, RACK_DND_PLUGINS, RACK_DND_SENSORS } from './dndConfig'
import type { RackDndHostApi } from './dragSources'
import { startCarrying, stopCarrying, useRackDrag, type CarryStatus } from './dragStore'
import { RACK_PART_DRAG_TYPE, subjectOfSource, type RackDragData } from './dragSubject'
import { subjectName } from './dropTarget'
import { clientPointOf } from './gesture'
import { rackDropTarget } from './rackDropTarget'

// ---------------------------------------------------------------------------------------------
// dnd-kit events -> the rack on screen

function onDragStart(event: DragStartEvent): void {
  const source = event.operation.source
  const subject = subjectOfSource(source)
  if (subject === null || source === null) return
  startCarrying(subject, String(source.id))
  // A drag replaces click-to-place: one ghost at a time.
  if (useEditorState.getState().placing !== null) useEditorState.getState().cancelPlacing()
}

function onDragMove(event: DragMoveEvent): void {
  const subject = useRackDrag.getState().subject
  if (subject === null) return
  // While dragmove is dispatched, `operation.position` still holds the previous point (spike S2,
  // pitfall 2): `to` (from the pointer sensor) or the native event is the new one.
  const point = event.to ?? clientPointOf(event.nativeEvent)
  rackDropTarget()?.move(subject, point === undefined ? null : point)
}

function onDragEnd(event: DragEndEvent): void {
  const subject = useRackDrag.getState().subject
  stopCarrying()
  if (subject === null) return
  const target = rackDropTarget()
  if (target === undefined) {
    if (!event.canceled) announce('Nothing was added: the rack is not on screen.')
    return
  }
  if (event.canceled) {
    target.cancel(subject)
    return
  }
  // The pointer sensor coalesces moves per frame, so the operation can lag the release by one;
  // the native pointerup carries the exact release point (spike S2, pitfall 3).
  const { x, y } = event.operation.position.current
  const point = clientPointOf(event.nativeEvent) ?? { x, y }
  const hint = event.operation.target
  target.drop(subject, point, hint === null ? null : String(hint.id))
}

// ---------------------------------------------------------------------------------------------
// The host

function Reporter({ onReady }: { onReady: (api: RackDndHostApi | null) => void }) {
  const manager = useDragDropManager()
  useLayoutEffect(() => {
    if (manager === null) return
    onReady({
      manager,
      createDraggable: (id, subject) =>
        new Draggable<RackDragData>(
          { id, type: RACK_PART_DRAG_TYPE, data: { subject }, disabled: true, register: false },
          manager,
        ),
      createDroppable: (id, element) =>
        new Droppable(
          {
            id,
            accept: RACK_PART_DRAG_TYPE,
            collisionDetector: FACE_COLLISION_DETECTOR,
            element,
            register: false,
          },
          manager,
        ),
    })
    return () => onReady(null)
  }, [manager, onReady])
  return null
}

export interface RackDndHostProps {
  /** Called with the manager and factories once ready, and with null on unmount. */
  onReady: (api: RackDndHostApi | null) => void
}

export function RackDndHost({ onReady }: RackDndHostProps) {
  return (
    <DragDropProvider
      sensors={RACK_DND_SENSORS}
      plugins={RACK_DND_PLUGINS}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
    >
      <Reporter onReady={onReady} />
      {/* Out of flow: the idle overlay wrapper must never take layout space (spike S2, pitfall 4). */}
      <div className="pointer-events-none absolute top-0 left-0 size-0">
        <DragOverlay dropAnimation={null}>
          {(source) => <RackDragChip source={source} />}
        </DragOverlay>
      </div>
    </DragDropProvider>
  )
}

// ---------------------------------------------------------------------------------------------
// The chip that follows the pointer

const TONE_ICON: Record<CarryStatus['tone'], typeof CircleCheck> = {
  ok: CircleCheck,
  blocked: CircleX,
  choose: CircleDot,
  idle: Move,
}

/** The carried part's name and what a drop here would do (icon and words, not colour alone). */
function RackDragChip({ source }: { source: { type?: unknown; data?: unknown } }) {
  const subject = subjectOfSource(source)
  const lookup = usePlanLookup()
  const status = useRackDrag((state) => state.status)
  if (subject === null) return null
  const tone = status?.tone ?? 'idle'
  const Icon = TONE_ICON[tone]
  return (
    <div
      aria-hidden="true"
      data-testid="rack-drag-chip"
      data-tone={tone}
      className={cn(
        'flex size-full min-h-12 min-w-40 flex-col justify-center gap-0.5 rounded-lg border-2 bg-card/95 px-3 py-2 text-sm text-card-foreground shadow-lg',
        tone === 'blocked' ? 'border-dashed border-destructive' : 'border-foreground/60',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5 font-medium">
        <GripVertical aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{subjectName(subject, lookup)}</span>
      </span>
      <span
        className={cn(
          'flex min-w-0 items-center gap-1 text-xs',
          tone === 'blocked' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{status?.text ?? 'Drop it on the rack'}</span>
      </span>
    </div>
  )
}
