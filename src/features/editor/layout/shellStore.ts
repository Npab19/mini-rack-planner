/**
 * Editor shell state that is neither part of the plan nor shared beyond the editor: which panel
 * sheet is open below lg (one at a time) and whether the keyboard help is open. Desktop panel
 * visibility (the BOM drawer) lives in `uiStore.panels`.
 */
import { create } from 'zustand'
import type { PanelId } from '@/state/uiStore'
import { useEditorState } from '../editorState'

interface EditorShellState {
  /** The panel shown in the sheet. Kept after closing so the sheet can animate out with it. */
  sheet: PanelId | null
  sheetOpen: boolean
  helpOpen: boolean
}

const INITIAL: EditorShellState = { sheet: null, sheetOpen: false, helpOpen: false }

export const useEditorShell = create<EditorShellState>()(() => INITIAL)

/** Opens `panel` as the sheet, replacing any other (only one sheet at a time). */
export function openSheet(panel: PanelId): void {
  useEditorShell.setState({ sheet: panel, sheetOpen: true })
}

export function closeSheet(): void {
  if (useEditorShell.getState().sheetOpen) useEditorShell.setState({ sheetOpen: false })
}

/** Callbacks waiting for the open sheet to finish closing. */
let afterSheetClose: Array<() => void> = []

/**
 * Runs `callback` once no sheet is open: at once when none is, else after the open sheet has
 * finished closing. A dialog opened from inside a sheet (the palette's or the inspector's "Add at
 * U…") would otherwise open under a closing modal that still holds focus.
 */
export function closeSheetThen(callback: () => void): void {
  if (!useEditorShell.getState().sheetOpen) {
    callback()
    return
  }
  afterSheetClose.push(callback)
  closeSheet()
}

/** The sheet has finished closing (PanelSheet): runs what `closeSheetThen` held back. */
export function sheetClosed(): void {
  const callbacks = afterSheetClose
  afterSheetClose = []
  for (const callback of callbacks) callback()
}

export function toggleSheet(panel: PanelId): void {
  const { sheet, sheetOpen } = useEditorShell.getState()
  if (sheetOpen && sheet === panel) closeSheet()
  else openSheet(panel)
}

/** The panel whose sheet is open, or null. */
export function useOpenSheet(): PanelId | null {
  return useEditorShell((state) => (state.sheetOpen ? state.sheet : null))
}

export function setHelpOpen(open: boolean): void {
  useEditorShell.setState({ helpOpen: open })
}

export function resetEditorShell(): void {
  afterSheetClose = []
  useEditorShell.setState(INITIAL)
}

// ---------------------------------------------------------------------------------------------
// DOM hooks for focus moves (the panels are owned elsewhere, so the shell finds them by id)

/** The container the shell renders around a panel (column, drawer body or sheet body). */
export function panelDomId(panel: PanelId): string {
  return `editor-panel-${panel}`
}

/** The rack's scroll container (zoom happens inside it). */
export const RACK_VIEWPORT_ID = 'editor-rack-viewport'

/** The placing banner, so cancelling from inside it can move focus out first. */
export const PLACING_BANNER_ID = 'editor-placing-banner'

function focusElement(element: HTMLElement): void {
  if (element.tabIndex < 0 && !element.hasAttribute('tabindex')) {
    element.setAttribute('tabindex', '-1')
  }
  element.focus({ preventScroll: true })
  element.scrollIntoView?.({ block: 'nearest' })
}

/**
 * Moves focus into a panel's container: to the element marked `data-panel-focus`, else the
 * panel's first heading, else the container itself. False when the panel is not on screen.
 */
export function focusPanel(panel: PanelId): boolean {
  const container = document.getElementById(panelDomId(panel))
  if (container === null) return false
  const target =
    container.querySelector<HTMLElement>('[data-panel-focus]') ??
    container.querySelector<HTMLElement>('h2, h3') ??
    container
  focusElement(target)
  return true
}

/** Focus to the rack (used when the focused control disappears, e.g. the placing banner). */
export function focusRackViewport(): void {
  const viewport = document.getElementById(RACK_VIEWPORT_ID)
  if (viewport !== null) focusElement(viewport)
}

/** The toolbar (the plan name's heading is focused when a plan opens). */
export const TOOLBAR_ID = 'editor-toolbar'

/**
 * The editor's areas in their visual (and Tab) order: F6 / Shift+F6 move between those on screen.
 * Below lg only the toolbar and the rack are on the page (panels open as sheets).
 */
const AREAS = ['toolbar', 'palette', 'equipment', 'rack', 'inspector', 'checks', 'bom'] as const
type EditorArea = (typeof AREAS)[number]

function areaElement(area: EditorArea): HTMLElement | null {
  if (area === 'toolbar') return document.getElementById(TOOLBAR_ID)
  if (area === 'rack') return document.getElementById(RACK_VIEWPORT_ID)
  return document.getElementById(panelDomId(area))
}

function focusIfFocusable(element: Element | null): boolean {
  if (!(element instanceof SVGElement || element instanceof HTMLElement)) return false
  element.focus({ preventScroll: true })
  return document.activeElement === element
}

/**
 * Focus to the rack drawing itself, where the arrow keys move the placing ghost and Enter places
 * (after Place in the palette or the equipment tray); else the scroll area around it.
 */
export function focusRackDrawing(): void {
  const viewport = document.getElementById(RACK_VIEWPORT_ID)
  if (focusIfFocusable(viewport?.querySelector('[data-testid="rack-svg"]') ?? null)) return
  if (viewport !== null) focusElement(viewport)
}

/**
 * Focus into the rack: while something is being placed, the drawing (its keys move the ghost);
 * else the placed part in the tab order, else the scroll area around it.
 */
function focusRackArea(): boolean {
  const viewport = document.getElementById(RACK_VIEWPORT_ID)
  if (viewport === null) return false
  if (useEditorState.getState().placing !== null) {
    focusRackDrawing()
    return true
  }
  if (focusIfFocusable(viewport.querySelector('[data-placement-id][tabindex="0"]'))) return true
  focusElement(viewport)
  return true
}

function focusArea(area: EditorArea): boolean {
  if (area === 'rack') return focusRackArea()
  if (area === 'toolbar') {
    const toolbar = document.getElementById(TOOLBAR_ID)
    const heading = toolbar?.querySelector<HTMLElement>('h1')
    if (heading === null || heading === undefined) return false
    focusElement(heading)
    return true
  }
  return focusPanel(area)
}

/**
 * F6 / Shift+F6: focus moves to the next / previous area that is on screen (wrapping around).
 * From outside them all, the first (or the last) one. False when there is none.
 */
export function cycleEditorArea(direction: 1 | -1): boolean {
  const areas = AREAS.filter((area) => areaElement(area) !== null)
  const count = areas.length
  if (count === 0) return false
  const active = document.activeElement
  const current = areas.findIndex((area) => areaElement(area)?.contains(active) ?? false)
  const start = current === -1 ? (direction === 1 ? -1 : count) : current
  for (let step = 1; step <= count; step++) {
    const area = areas[(((start + direction * step) % count) + count) % count]
    if (area !== undefined && focusArea(area)) return true
  }
  return false
}

/** Whether focus is inside the element with `id`. */
export function focusIsWithin(id: string): boolean {
  const element = document.getElementById(id)
  return element !== null && element.contains(document.activeElement)
}
