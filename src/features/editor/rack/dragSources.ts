/**
 * Drag sources and the face droppable, for components anywhere under `RackDndProvider`. Free of
 * dnd-kit at runtime (type imports only): the provider loads dnd-kit lazily and hands its manager
 * and entity factories down through `RackDndContext`. Until then, and outside the provider (a
 * panel rendered on its own, jsdom tests), the hooks do nothing and the elements stay plain: no
 * entity ever registers with dnd-kit's global default manager, whose Accessibility plugin and
 * KeyboardSensor would rewrite the rows' roles, tab stops and keys.
 */
import type { DragDropManager, Draggable, Droppable } from '@dnd-kit/dom'
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import type { Face } from '@/domain/schema/common'
import { usePlanStore } from '@/state/planStore'
import type { TrayDraggableProps } from '../equipment/trayDrag'
import { useRackDrag } from './dragStore'
import { dragSourceId, faceDroppableId, type DragSubject, type RackDragData } from './dragSubject'

/** What the lazily loaded drag host (`rackDndHost.tsx`) gives the editor. */
export interface RackDndHostApi {
  manager: DragDropManager
  /** A disabled, unregistered draggable for a rack part (register it while mounted). */
  createDraggable: (id: string, subject: DragSubject) => Draggable<RackDragData>
  /** An unregistered droppable over `element` that takes rack parts (pointer intersection). */
  createDroppable: (id: string, element: Element) => Droppable
}

export interface RackDndContextValue {
  host: RackDndHostApi
  /** Drags may start: the rack sits beside the panels (lg and up). Below lg they are sheets over
   *  the rack and tap-to-place is the way to place. */
  enabled: boolean
}

export const RackDndContext = createContext<RackDndContextValue | null>(null)

/** Whether dragging onto the rack is ready here (inside the provider, dnd-kit loaded). */
export function useRackDndAvailable(): boolean {
  return useContext(RackDndContext) !== null
}

export interface RackDragSource {
  /** The `ref` callback for the element the user grabs (the whole row; its buttons and links
   *  stay clickable). */
  setElement: (element: Element | null) => void
  /** A drag can start from it (inside the provider, lg and up, a subject given). */
  draggable: boolean
  /** It is the one being carried now (dim it). */
  dragging: boolean
}

/**
 * Makes an element a drag source for `subject` (null: not draggable, e.g. a read-only plan; pass a
 * memoized object). Interactive children (buttons, links, inputs) never start a drag: dnd-kit's
 * pointer sensor leaves them alone, so they keep working.
 */
export function useRackDragSource(subject: DragSubject | null): RackDragSource {
  const context = useContext(RackDndContext)
  const host = context?.host ?? null
  const enabled = context !== null && context.enabled && subject !== null
  const id = subject === null ? null : dragSourceId(subject)

  // dnd-kit entities are mutable objects outside React: they live in refs, created and registered
  // in a layout effect (after the element's ref is attached), one per manager and subject (the
  // registry is keyed by id; callers memoize the subject, so it changes only with its id).
  const element = useRef<Element | null>(null)
  const draggable = useRef<Draggable<RackDragData> | null>(null)
  useLayoutEffect(() => {
    if (host === null || id === null || subject === null) return
    const entity = host.createDraggable(id, subject)
    entity.element = element.current ?? undefined
    entity.disabled = !enabled
    draggable.current = entity
    const unregister = entity.register()
    return () => {
      unregister?.()
      if (draggable.current === entity) draggable.current = null
    }
  }, [host, id, subject, enabled])

  const setElement = useCallback((next: Element | null) => {
    element.current = next
    const entity = draggable.current
    if (entity === null) return
    // React clears refs when it re-renders a node mid-drag; keep the source until the drop.
    const idle = entity.manager?.dragOperation.status.idle ?? true
    if (next === null && entity.element?.isConnected === true && !idle) return
    entity.element = next ?? undefined
  }, [])
  const dragging = useRackDrag((state) => id !== null && state.sourceId === id)
  return { setElement, draggable: enabled, dragging }
}

/** Props for a tray row: `<li {...useTrayDraggable(entry.id, entry.deviceId)}>`. */
export interface TrayDragProps {
  ref: (element: Element | null) => void
  /** Present while the row can be dragged onto the rack (style it, e.g. a grab cursor). */
  'data-rack-drag-source'?: 'tray'
  /** Present while this row is the one being carried (dim it). */
  'data-dragging'?: 'true'
}

/**
 * Makes an Equipment to fit row draggable onto the rack: onto a mount's slot the device goes in
 * (keeping In my rack / To get, and leaving the tray); ear-mounted gear on empty space is placed
 * directly; any other device on empty space opens the mount chooser at that U. Spread the result
 * on the row element. Inert outside `RackDndProvider`, below lg, for read-only plans and when
 * `disabled`.
 */
export function useTrayDraggable(
  equipmentId: string,
  deviceId: string,
  options: { disabled?: boolean } = {},
): TrayDragProps {
  const readOnly = usePlanStore((state) => state.readOnly)
  const off = readOnly || options.disabled === true
  const subject = useMemo<DragSubject | null>(
    () => (off ? null : { kind: 'device', deviceId, equipmentId }),
    [off, deviceId, equipmentId],
  )
  const source = useRackDragSource(subject)
  return {
    ref: source.setElement,
    ...(source.draggable ? { 'data-rack-drag-source': 'tray' as const } : {}),
    ...(source.dragging ? { 'data-dragging': 'true' as const } : {}),
  }
}

/**
 * The tray's grab handle, as the tray asks for it (`TrayDragContext` in equipment/trayDrag.ts):
 * `RackDndProvider` provides this component while drags are on, and the tray renders each row's
 * handle through it.
 */
export function RackTrayDraggable({ subject, disabled, children }: TrayDraggableProps): ReactNode {
  const props = useTrayDraggable(subject.equipmentId, subject.deviceId, { disabled })
  return children({ ref: props.ref, isDragging: props['data-dragging'] === 'true' })
}

/**
 * Registers the rack's clipping viewport as the face's droppable (one per face; pointer
 * intersection, so the face is the target only while the pointer is over the visible viewport).
 * The rack still hit-tests every point itself; dnd-kit's target is a cross-check.
 */
export function useFaceDroppable(element: HTMLElement | null, face: Face): void {
  const host = useContext(RackDndContext)?.host ?? null
  useLayoutEffect(() => {
    if (host === null || element === null) return
    return host.createDroppable(faceDroppableId(face), element).register()
  }, [host, element, face])
}
