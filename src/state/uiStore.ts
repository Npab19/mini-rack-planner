/**
 * Editor UI state that is neither part of the plan nor undoable: Recording mode per plan, the
 * selection, zoom and face (placeholders for M3a) and which panels are open.
 *
 * Recording mode ("Recording what you have": everything added is marked Have) survives a reload
 * of the same tab through sessionStorage, so a refresh mid-recording does not silently switch to
 * planning. Nothing else is persisted.
 */
import { create } from 'zustand'

export type EditorFace = 'front' | 'rear'
export type PanelId = 'inspector' | 'bom' | 'checks' | 'palette' | 'equipment'

export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 4

const RECORDING_KEY = 'mrp-recording'

export interface UiState {
  /** planId -> Recording mode on. */
  recordingMode: Readonly<Record<string, boolean>>
  /** Selected placement, section or device ids (editor order: first = primary). */
  selection: readonly string[]
  /** 1 = 100 %. */
  zoom: number
  face: EditorFace
  panels: Readonly<Record<PanelId, boolean>>
  setRecordingMode: (planId: string, on: boolean) => void
  select: (ids: readonly string[]) => void
  toggleSelected: (id: string) => void
  clearSelection: () => void
  setZoom: (zoom: number) => void
  setFace: (face: EditorFace) => void
  setPanelOpen: (panel: PanelId, open: boolean) => void
  togglePanel: (panel: PanelId) => void
}

function readRecording(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(globalThis.sessionStorage?.getItem(RECORDING_KEY) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: Record<string, boolean> = {}
    for (const [planId, on] of Object.entries(parsed)) if (on === true) result[planId] = true
    return result
  } catch {
    return {}
  }
}

function writeRecording(recording: Readonly<Record<string, boolean>>): void {
  try {
    globalThis.sessionStorage?.setItem(RECORDING_KEY, JSON.stringify(recording))
  } catch {
    // Storage blocked or full: Recording mode then lasts until the tab reloads.
  }
}

const DEFAULT_PANELS: Record<PanelId, boolean> = {
  inspector: true,
  bom: false,
  checks: false,
  palette: false,
  equipment: false,
}

function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
}

export const useUiStore = create<UiState>()((set) => ({
  recordingMode: readRecording(),
  selection: [],
  zoom: 1,
  face: 'front',
  panels: DEFAULT_PANELS,
  setRecordingMode: (planId, on) =>
    set((state) => {
      const recordingMode = { ...state.recordingMode }
      if (on) recordingMode[planId] = true
      else delete recordingMode[planId]
      writeRecording(recordingMode)
      return { recordingMode }
    }),
  select: (ids) => set({ selection: [...new Set(ids)] }),
  toggleSelected: (id) =>
    set((state) => ({
      selection: state.selection.includes(id)
        ? state.selection.filter((selected) => selected !== id)
        : [...state.selection, id],
    })),
  clearSelection: () => set({ selection: [] }),
  setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),
  setFace: (face) => set({ face }),
  setPanelOpen: (panel, open) => set((state) => ({ panels: { ...state.panels, [panel]: open } })),
  togglePanel: (panel) =>
    set((state) => ({ panels: { ...state.panels, [panel]: !state.panels[panel] } })),
}))

/** Recording mode for a plan (false without a plan). */
export function useRecordingMode(planId: string | null | undefined): boolean {
  return useUiStore((state) => (planId ? state.recordingMode[planId] === true : false))
}

export function isRecording(planId: string | null | undefined): boolean {
  return planId ? useUiStore.getState().recordingMode[planId] === true : false
}
