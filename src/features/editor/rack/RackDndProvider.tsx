/**
 * Drag and drop from the palette and the Equipment to fit tray onto the rack (M3b, spike S2).
 *
 * Wrap the editor body (the palette, the tray and the rack) in `RackDndProvider` once. It loads
 * the dnd-kit host lazily (`rackDndHost.tsx`: the `DragDropProvider`, the drag chip in the top
 * layer and the event plumbing) and provides its manager to the drag sources and the face
 * droppable (`dragSources.ts`). Until it has loaded, and where the browser lacks what dnd-kit needs
 * (jsdom), nothing is draggable and every other path (Place, tap-to-place, Add at U…, the keys)
 * works as before. Placed parts move with the rack's own Pointer Events (`useRackDnd`), not here.
 *
 * Tray rows: the provider also gives the tray its grab handle (`TrayDragContext`, the tray's own
 * contract in equipment/trayDrag.ts) while drags are on; `useTrayDraggable(equipmentId,
 * deviceId)` (re-exported here) does the same as spreadable props.
 */
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { TrayDragContext } from '../equipment/trayDrag'
import { useIsDesktop } from '../layout/useMediaQuery'
import { RackDndContext, RackTrayDraggable, type RackDndHostApi } from './dragSources'
import type { RackDndHostProps } from './rackDndHost'

export {
  RackTrayDraggable,
  useRackDndAvailable,
  useRackDragSource,
  useTrayDraggable,
  type RackDragSource,
  type TrayDragProps,
} from './dragSources'

/** Whether this browser can run dnd-kit (it observes element sizes from the moment it loads). */
function canDrag(): boolean {
  return typeof window !== 'undefined' && typeof ResizeObserver === 'function'
}

export function RackDndProvider({ children }: { children: ReactNode }) {
  const desktop = useIsDesktop()
  const [Host, setHost] = useState<ComponentType<RackDndHostProps> | null>(null)
  const [api, setApi] = useState<RackDndHostApi | null>(null)

  useEffect(() => {
    if (!canDrag()) return
    let mounted = true
    // A failed load (a stale deploy) is left to the app's update prompt (unhandled rejection);
    // after Vite's preload error the module comes back undefined and dragging stays off.
    void import('./rackDndHost').then((module: typeof import('./rackDndHost') | undefined) => {
      if (mounted && module !== undefined) setHost(() => module.RackDndHost)
    })
    return () => {
      mounted = false
    }
  }, [])

  const value = useMemo(
    () => (api === null ? null : { host: api, enabled: desktop }),
    [api, desktop],
  )
  return (
    <RackDndContext.Provider value={value}>
      <TrayDragContext.Provider value={value?.enabled === true ? RackTrayDraggable : null}>
        {children}
      </TrayDragContext.Provider>
      {Host === null ? null : <Host onReady={setApi} />}
    </RackDndContext.Provider>
  )
}
