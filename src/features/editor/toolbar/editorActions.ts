/**
 * What the toolbar buttons and the global shortcuts do, in one place so both behave and announce
 * the same. Plain functions over the stores: they work outside React and in tests.
 */
import { createContext, useContext } from 'react'
import { usePlanStore } from '@/state/planStore'
import { useUiStore, type EditorFace } from '@/state/uiStore'
import { useEditorState } from '../editorState'
import { announce } from '../layout/announcer'
import {
  cycleEditorArea,
  focusIsWithin,
  focusPanel,
  focusRackViewport,
  openSheet,
  PLACING_BANNER_ID,
  setHelpOpen,
  toggleSheet,
} from '../layout/shellStore'
import { requestFit } from './fitRequest'
import { canZoomIn, canZoomOut, formatZoom, zoomInFrom, zoomOutFrom } from './zoom'

export interface EditorActions {
  undo: () => void
  redo: () => void
  zoomIn: () => void
  zoomOut: () => void
  /** Back to 100 %. */
  resetZoom: () => void
  /** Asks the rack to fit itself in view (100 % when no rack is listening; see fitRequest.ts). */
  fit: () => void
  setFace: (face: EditorFace) => void
  /** Desktop: the BOM drawer (remembered in uiStore.panels.bom). Below lg: the BOM sheet. */
  toggleBom: () => void
  /** Desktop: focus moves to the Checks panel. Below lg: the Checks sheet opens. */
  showChecks: () => void
  openHelp: () => void
  /** Stops placing; false when nothing was being placed. */
  cancelPlacing: () => boolean
  /** Esc: stops placing, else clears the selection; false when there was nothing to do. */
  escape: () => boolean
  /** F6 / Shift+F6: focus to the next / previous area (toolbar, panels, rack). */
  cyclePanel: (direction: 1 | -1) => boolean
}

const FACE_TEXT: Record<EditorFace, string> = {
  front: 'Showing the front of the rack.',
  rear: 'Showing the rear of the rack.',
}

function undo(): void {
  const store = usePlanStore.getState()
  const before = store.plan
  store.undo()
  // Nothing in the history, a read-only plan or a drag in progress: nothing changed.
  announce(usePlanStore.getState().plan === before ? 'Nothing to undo.' : 'Undone.')
}

function redo(): void {
  const store = usePlanStore.getState()
  const before = store.plan
  store.redo()
  announce(usePlanStore.getState().plan === before ? 'Nothing to redo.' : 'Redone.')
}

function setZoomTo(zoom: number): void {
  useUiStore.getState().setZoom(zoom)
  announce(`Zoom ${formatZoom(useUiStore.getState().zoom)}.`)
}

function zoomIn(): void {
  const { zoom } = useUiStore.getState()
  if (canZoomIn(zoom)) setZoomTo(zoomInFrom(zoom))
  else announce(`Zoom ${formatZoom(zoom)}, the largest.`)
}

function zoomOut(): void {
  const { zoom } = useUiStore.getState()
  if (canZoomOut(zoom)) setZoomTo(zoomOutFrom(zoom))
  else announce(`Zoom ${formatZoom(zoom)}, the smallest.`)
}

function resetZoom(): void {
  setZoomTo(1)
}

function fit(): void {
  // No rack on screen to measure: back to 100 %.
  if (!requestFit()) useUiStore.getState().setZoom(1)
  announce(`Zoomed to fit: ${formatZoom(useUiStore.getState().zoom)}.`)
}

function setFace(face: EditorFace): void {
  const ui = useUiStore.getState()
  if (ui.face !== face) ui.setFace(face)
  announce(FACE_TEXT[face])
}

function cancelPlacing(): boolean {
  if (useEditorState.getState().placing === null) return false
  // The banner (and its Cancel button) goes away: keep focus on the page, next to the rack.
  const focusWasInBanner = focusIsWithin(PLACING_BANNER_ID)
  useEditorState.getState().cancelPlacing()
  if (focusWasInBanner) focusRackViewport()
  // The rack's own "Stop placing" says the same.
  announce('Stopped placing.')
  return true
}

function escape(): boolean {
  if (cancelPlacing()) return true
  // A move in progress belongs to the rack, which handles its own Esc.
  if (useEditorState.getState().moving !== null) return false
  const ui = useUiStore.getState()
  if (ui.selection.length === 0) return false
  ui.clearSelection()
  announce('Selection cleared.')
  return true
}

function openHelp(): void {
  setHelpOpen(true)
}

/** The actions for the current layout (`desktop`: lg and up, panels in columns). */
export function createEditorActions({ desktop }: { desktop: boolean }): EditorActions {
  return {
    undo,
    redo,
    zoomIn,
    zoomOut,
    resetZoom,
    fit,
    setFace,
    toggleBom: desktop
      ? () => {
          const open = !useUiStore.getState().panels.bom
          useUiStore.getState().setPanelOpen('bom', open)
          announce(open ? 'Bill of materials shown.' : 'Bill of materials hidden.')
        }
      : () => toggleSheet('bom'),
    showChecks: desktop
      ? () => {
          focusPanel('checks')
        }
      : () => openSheet('checks'),
    openHelp,
    cancelPlacing,
    escape,
    cyclePanel: cycleEditorArea,
  }
}

const EditorActionsContext = createContext<EditorActions | null>(null)

export const EditorActionsProvider = EditorActionsContext.Provider

/** The editor's actions (inside the editor shell). */
export function useEditorActions(): EditorActions {
  const actions = useContext(EditorActionsContext)
  if (actions === null) throw new Error('useEditorActions is used outside the editor shell.')
  return actions
}
