/**
 * Dragging a tray device onto the rack (M3b). The rack's drag and drop (dnd-kit behind
 * `useRackDnd`) owns gestures, so it provides the component that makes the tray's grab handle
 * draggable, from inside its `DragDropProvider`:
 *
 *   function TrayDraggable({ subject, disabled, children }: TrayDraggableProps) {
 *     const { ref, isDragging } = useTrayDraggable(subject, { disabled }) // the rack's hook
 *     return children({ ref, isDragging })
 *   }
 *   <TrayDragContext value={TrayDraggable}>…the panels…</TrayDragContext>
 *
 * The tray renders its handle through it; a drop on empty rack space opens the mount chooser
 * (`useMountDialogs.openChooser({ deviceId, equipmentId, face, y })`). Without a provider (tests,
 * no rack on screen) the rows are simply not draggable: dragging is never the only way, "Place
 * on …" and "Fit it for me" place devices too.
 */
import { createContext, useContext, type ComponentType, type ReactNode } from 'react'

/** What a tray drag carries. */
export interface TrayDragSubject {
  equipmentId: string
  deviceId: string
}

export interface TrayDragHandle {
  /** Attach to the element the user grabs. */
  ref: (element: HTMLElement | null) => void
  /** This entry is being dragged right now. */
  isDragging: boolean
}

export interface TrayDraggableProps {
  subject: TrayDragSubject
  disabled: boolean
  /** Renders the grab handle with the draggable's ref and state. */
  children: (handle: TrayDragHandle) => ReactNode
}

/** The rack's draggable wrapper for one tray row. */
export type TrayDraggableComponent = ComponentType<TrayDraggableProps>

export const TrayDragContext = createContext<TrayDraggableComponent | null>(null)

/** The rack's draggable wrapper when tray drags are available, else null. */
export function useTrayDragSupport(): TrayDraggableComponent | null {
  return useContext(TrayDragContext)
}
