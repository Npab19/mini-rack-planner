/**
 * The editor's global keyboard shortcuts (the rack's own keys, arrows, Delete, Ctrl+D and Enter,
 * belong to the rack and are only listed in the keyboard help):
 *
 * - Ctrl/Cmd+Z undo; Ctrl/Cmd+Shift+Z or Ctrl+Y redo
 * - ? keyboard help; Esc stops placing, else clears the selection
 * - F fit; [ and ] (or - and +) zoom out and in; 1 front, 2 rear; B the bill of materials
 * - F6 / Shift+F6 move focus to the next / previous panel (as in desktop apps)
 *
 * They never fire while typing (inputs, text areas, selects, contenteditable), inside a dialog,
 * menu or list box (those handle their own keys; Esc closes them), or when a component already
 * handled the key (`event.preventDefault()`). The exceptions: undo and redo also work inside the
 * editor's panel sheets (`data-editor-sheet`), where a panel is edited below lg, and F6 also
 * works from a text field (it types nothing).
 */
import { useEffect, useRef } from 'react'
import type { EditorFace } from '@/state/uiStore'

export type EditorShortcut =
  | 'undo'
  | 'redo'
  | 'help'
  | 'escape'
  | 'fit'
  | 'zoom-in'
  | 'zoom-out'
  | 'toggle-bom'
  | 'face-front'
  | 'face-rear'
  | 'next-panel'
  | 'previous-panel'

/** The parts of a keyboard event the matcher reads. */
export interface ShortcutKeys {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** AltGr (reported as Ctrl+Alt on Windows) types [ and ] on many layouts. */
  altGraph?: boolean
}

const SINGLE_KEYS: Readonly<Record<string, EditorShortcut>> = {
  Escape: 'escape',
  '?': 'help',
  f: 'fit',
  F: 'fit',
  b: 'toggle-bom',
  B: 'toggle-bom',
  '[': 'zoom-out',
  '-': 'zoom-out',
  ']': 'zoom-in',
  '+': 'zoom-in',
  '=': 'zoom-in',
  '1': 'face-front',
  '2': 'face-rear',
}

/** Which shortcut a key press is, ignoring where it happened; null for none. */
export function editorShortcutFor(keys: ShortcutKeys): EditorShortcut | null {
  const command = keys.ctrlKey || keys.metaKey
  if (keys.key === 'F6') {
    if (command || keys.altKey) return null
    return keys.shiftKey ? 'previous-panel' : 'next-panel'
  }
  if (command && !keys.altKey) {
    const key = keys.key.toLowerCase()
    if (key === 'z') return keys.shiftKey ? 'redo' : 'undo'
    // Ctrl+Y is the Windows redo; Cmd+Y is the browser's History on macOS, so it is left alone.
    if (key === 'y' && keys.ctrlKey && !keys.metaKey && !keys.shiftKey) return 'redo'
    return null
  }
  // Single keys go without Ctrl, Cmd or Alt (browser and system shortcuts), except AltGr typing a
  // character.
  if ((command || keys.altKey) && keys.altGraph !== true) return null
  return Object.hasOwn(SINGLE_KEYS, keys.key) ? (SINGLE_KEYS[keys.key] ?? null) : null
}

/** Held down, these repeat (zooming, stepping through history); the others act once per press. */
const REPEATABLE: ReadonlySet<EditorShortcut> = new Set(['undo', 'redo', 'zoom-in', 'zoom-out'])

const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

const TEXT_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])

/** Editable rich text (the attribute check also covers engines without `isContentEditable`). */
const CONTENT_EDITABLE_SELECTOR = '[contenteditable]:not([contenteditable="false"])'

/** Where typing a key enters text (or edits a value), so the key is not a shortcut. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target instanceof HTMLElement && target.isContentEditable) return true
  if (target.closest(CONTENT_EDITABLE_SELECTOR) !== null) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(target.type)
  return TEXT_ROLES.has(target.getAttribute('role') ?? '')
}

/** Popups that own their keys: dialogs and sheets, menus, list boxes. */
const POPUP_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

/** Moving between panels types nothing, so it works from text fields too. */
const PANEL_SHORTCUTS: ReadonlySet<EditorShortcut> = new Set(['next-panel', 'previous-panel'])

/** Whether a shortcut may run for a key pressed on `target`. */
export function shortcutAllowedAt(target: EventTarget | null, shortcut: EditorShortcut): boolean {
  if (isTextEntryTarget(target) && !PANEL_SHORTCUTS.has(shortcut)) return false
  if (!(target instanceof Element)) return true
  const popup = target.closest(POPUP_SELECTOR)
  if (popup === null) return true
  return popup.hasAttribute('data-editor-sheet') && (shortcut === 'undo' || shortcut === 'redo')
}

export interface EditorShortcutHandlers {
  undo: () => void
  redo: () => void
  openHelp: () => void
  /** Returns false when there was nothing to stop or clear (the key is then left alone). */
  escape: () => boolean
  fit: () => void
  zoomIn: () => void
  zoomOut: () => void
  toggleBom: () => void
  setFace: (face: EditorFace) => void
  /** F6 / Shift+F6; returns false when there is nowhere to go (the key is then left alone). */
  cyclePanel?: (direction: 1 | -1) => boolean
}

function run(handlers: EditorShortcutHandlers, shortcut: EditorShortcut): boolean {
  switch (shortcut) {
    case 'undo':
      handlers.undo()
      return true
    case 'redo':
      handlers.redo()
      return true
    case 'help':
      handlers.openHelp()
      return true
    case 'escape':
      return handlers.escape()
    case 'fit':
      handlers.fit()
      return true
    case 'zoom-in':
      handlers.zoomIn()
      return true
    case 'zoom-out':
      handlers.zoomOut()
      return true
    case 'toggle-bom':
      handlers.toggleBom()
      return true
    case 'face-front':
      handlers.setFace('front')
      return true
    case 'face-rear':
      handlers.setFace('rear')
      return true
    case 'next-panel':
      return handlers.cyclePanel?.(1) ?? false
    case 'previous-panel':
      return handlers.cyclePanel?.(-1) ?? false
  }
}

/**
 * Listens on the document while mounted (and `enabled`). Handlers may change between renders;
 * the latest ones always run.
 */
export function useEditorShortcuts(handlers: EditorShortcutHandlers, enabled = true): void {
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })

  useEffect(() => {
    if (!enabled) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.isComposing) return
      const shortcut = editorShortcutFor({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        altGraph: event.getModifierState('AltGraph'),
      })
      if (shortcut === null || !shortcutAllowedAt(event.target, shortcut)) return
      if (event.repeat && !REPEATABLE.has(shortcut)) {
        if (shortcut !== 'escape') event.preventDefault()
        return
      }
      if (run(latest.current, shortcut)) event.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
