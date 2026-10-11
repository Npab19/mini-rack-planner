/**
 * Editor interaction state (M3a+): what the user is placing from the palette or the equipment
 * tray, the hover ghost, and which inspector tab is open. Not persisted, not undoable; selection,
 * zoom, face and panel visibility live in `@/state/uiStore`.
 */
import { create } from 'zustand'
import type { EditorFace } from '@/state/uiStore'

/**
 * Something being placed by click (click-to-place) or, from M3b, by drag.
 * - `item`: a catalog mount/panel/shelf. With `equipmentId`, the tray device moves into it on
 *   placement (`placeEquipmentOnMount`).
 * - `device`: a device that mounts directly (`device.rackmount`, e.g. a 10" PDU or switch).
 */
export type PlaceSource =
  | { kind: 'item'; itemId: string; equipmentId?: string }
  | { kind: 'device'; deviceId: string; equipmentId?: string }

/** Where the current place/move would land and whether it can. `reasons` are user-facing. */
export interface Ghost {
  y: number
  heightSixths: number
  face: EditorFace
  ok: boolean
  reasons: string[]
}

export type InspectorTab = 'selection' | 'rack'

interface EditorState {
  placing: PlaceSource | null
  ghost: Ghost | null
  inspectorTab: InspectorTab
  /** Placement id currently being moved with the keyboard or (M3b) the pointer. */
  moving: string | null
  startPlacing: (source: PlaceSource) => void
  cancelPlacing: () => void
  setGhost: (ghost: Ghost | null) => void
  setInspectorTab: (tab: InspectorTab) => void
  setMoving: (placementId: string | null) => void
  reset: () => void
}

export const useEditorState = create<EditorState>((set) => ({
  placing: null,
  ghost: null,
  inspectorTab: 'selection',
  moving: null,
  startPlacing: (source) => set({ placing: source, ghost: null }),
  cancelPlacing: () => set({ placing: null, ghost: null }),
  setGhost: (ghost) => set({ ghost }),
  setInspectorTab: (tab) => set({ inspectorTab: tab }),
  setMoving: (placementId) => set({ moving: placementId }),
  reset: () => set({ placing: null, ghost: null, inspectorTab: 'selection', moving: null }),
}))
