import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { shortcutGroups } from './KeyboardHelp'
import {
  editorShortcutFor,
  isTextEntryTarget,
  shortcutAllowedAt,
  useEditorShortcuts,
  type EditorShortcutHandlers,
  type ShortcutKeys,
} from './useEditorShortcuts'

function keys(key: string, modifiers: Partial<Omit<ShortcutKeys, 'key'>> = {}): ShortcutKeys {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers }
}

function handlers(): EditorShortcutHandlers & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    undo: () => calls.push('undo'),
    redo: () => calls.push('redo'),
    openHelp: () => calls.push('help'),
    escape: () => {
      calls.push('escape')
      return true
    },
    fit: () => calls.push('fit'),
    zoomIn: () => calls.push('zoom-in'),
    zoomOut: () => calls.push('zoom-out'),
    toggleBom: () => calls.push('bom'),
    setFace: (face) => calls.push(face),
  }
}

afterEach(cleanup)

describe('editorShortcutFor', () => {
  it('knows undo and redo on Windows, Linux and macOS', () => {
    expect(editorShortcutFor(keys('z', { ctrlKey: true }))).toBe('undo')
    expect(editorShortcutFor(keys('z', { metaKey: true }))).toBe('undo')
    expect(editorShortcutFor(keys('Z', { ctrlKey: true, shiftKey: true }))).toBe('redo')
    expect(editorShortcutFor(keys('z', { metaKey: true, shiftKey: true }))).toBe('redo')
    expect(editorShortcutFor(keys('y', { ctrlKey: true }))).toBe('redo')
    // Cmd+Y is the browser's History on macOS.
    expect(editorShortcutFor(keys('y', { metaKey: true }))).toBeNull()
    expect(editorShortcutFor(keys('z', { ctrlKey: true, altKey: true }))).toBeNull()
  })

  it('maps the single keys', () => {
    const expected = {
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
    for (const [key, shortcut] of Object.entries(expected)) {
      expect(editorShortcutFor(keys(key)), key).toBe(shortcut)
    }
    expect(editorShortcutFor(keys('?', { shiftKey: true }))).toBe('help')
    for (const key of ['a', '3', 'Enter', 'ArrowUp', 'Delete', 'constructor', 'toString']) {
      expect(editorShortcutFor(keys(key)), key).toBeNull()
    }
  })

  it('moves between panels with F6 and Shift+F6, also from a text field', () => {
    expect(editorShortcutFor(keys('F6'))).toBe('next-panel')
    expect(editorShortcutFor(keys('F6', { shiftKey: true }))).toBe('previous-panel')
    expect(editorShortcutFor(keys('F6', { ctrlKey: true }))).toBeNull()
    expect(editorShortcutFor(keys('F6', { altKey: true }))).toBeNull()
    const input = document.createElement('input')
    expect(shortcutAllowedAt(input, 'next-panel')).toBe(true)
    expect(shortcutAllowedAt(input, 'fit')).toBe(false)
  })

  it('leaves Ctrl, Cmd and Alt combinations to the browser, but lets AltGr type [ and ]', () => {
    expect(editorShortcutFor(keys('f', { ctrlKey: true }))).toBeNull()
    expect(editorShortcutFor(keys('1', { metaKey: true }))).toBeNull()
    expect(editorShortcutFor(keys('b', { altKey: true }))).toBeNull()
    expect(editorShortcutFor(keys('[', { ctrlKey: true, altKey: true, altGraph: true }))).toBe(
      'zoom-out',
    )
  })
})

describe('where shortcuts apply', () => {
  it('not while typing, but on buttons, checkboxes and the page', () => {
    render(
      <div>
        <input aria-label="Name" />
        <input aria-label="Count" type="number" />
        <input aria-label="Got it" type="checkbox" />
        <textarea aria-label="Notes" />
        <select aria-label="Material">
          <option>PLA</option>
        </select>
        <div aria-label="Rich" contentEditable suppressContentEditableWarning />
        <div aria-label="Search" role="combobox" aria-expanded="false" tabIndex={0} />
        <button type="button">Place</button>
      </div>,
    )
    for (const name of ['Name', 'Count', 'Notes', 'Material', 'Search']) {
      expect(isTextEntryTarget(screen.getByLabelText(name)), name).toBe(true)
    }
    expect(isTextEntryTarget(screen.getByLabelText('Rich'))).toBe(true)
    expect(isTextEntryTarget(screen.getByLabelText('Got it'))).toBe(false)
    expect(isTextEntryTarget(screen.getByRole('button', { name: 'Place' }))).toBe(false)
    expect(isTextEntryTarget(document.body)).toBe(false)
    expect(isTextEntryTarget(null)).toBe(false)
  })

  it('not inside dialogs and menus, except undo and redo inside a panel sheet', () => {
    render(
      <div>
        <div role="dialog" aria-label="Help">
          <button type="button">In a dialog</button>
        </div>
        <div role="menu" aria-label="Actions">
          <div role="menuitem" tabIndex={-1}>
            In a menu
          </div>
        </div>
        <div role="dialog" aria-label="Inspector" data-editor-sheet="">
          <button type="button">In a sheet</button>
        </div>
      </div>,
    )
    const inDialog = screen.getByRole('button', { name: 'In a dialog' })
    const inMenu = screen.getByText('In a menu')
    const inSheet = screen.getByRole('button', { name: 'In a sheet' })
    expect(shortcutAllowedAt(inDialog, 'toggle-bom')).toBe(false)
    expect(shortcutAllowedAt(inDialog, 'undo')).toBe(false)
    expect(shortcutAllowedAt(inMenu, 'fit')).toBe(false)
    expect(shortcutAllowedAt(inSheet, 'undo')).toBe(true)
    expect(shortcutAllowedAt(inSheet, 'redo')).toBe(true)
    expect(shortcutAllowedAt(inSheet, 'escape')).toBe(false)
    expect(shortcutAllowedAt(document.body, 'escape')).toBe(true)
    expect(shortcutAllowedAt(null, 'help')).toBe(true)
  })
})

describe('useEditorShortcuts', () => {
  it('runs the latest handlers and stops when unmounted or disabled', () => {
    const first = handlers()
    const second = handlers()
    const { rerender, unmount } = renderHook(
      ({ current, enabled }) => useEditorShortcuts(current, enabled),
      { initialProps: { current: first, enabled: true } },
    )
    fireEvent.keyDown(document.body, { key: 'f' })
    rerender({ current: second, enabled: true })
    fireEvent.keyDown(document.body, { key: '2' })
    fireEvent.keyDown(document.body, { key: '?' })
    expect(first.calls).toEqual(['fit'])
    expect(second.calls).toEqual(['rear', 'help'])
    rerender({ current: second, enabled: false })
    fireEvent.keyDown(document.body, { key: 'b' })
    rerender({ current: second, enabled: true })
    unmount()
    fireEvent.keyDown(document.body, { key: 'b' })
    expect(second.calls).toEqual(['rear', 'help'])
  })

  it('repeats only zoom and history while a key is held, and marks handled keys', () => {
    const current = handlers()
    renderHook(() => useEditorShortcuts(current))
    fireEvent.keyDown(document.body, { key: ']', repeat: true })
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, repeat: true })
    fireEvent.keyDown(document.body, { key: 'b', repeat: true })
    fireEvent.keyDown(document.body, { key: '1', repeat: true })
    expect(current.calls).toEqual(['zoom-in', 'undo'])

    const handled = !fireEvent.keyDown(document.body, { key: 'f' })
    expect(handled).toBe(true)
    // A key nobody uses is not prevented.
    expect(fireEvent.keyDown(document.body, { key: 'q' })).toBe(true)
  })

  it('leaves Esc alone when there was nothing to stop', () => {
    const current = { ...handlers(), escape: () => false }
    renderHook(() => useEditorShortcuts(current))
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true)
  })

  it('runs F6 through cyclePanel, and leaves it to the browser when there is nowhere to go', () => {
    const directions: number[] = []
    let somewhere = true
    const current = {
      ...handlers(),
      cyclePanel: (direction: 1 | -1) => {
        directions.push(direction)
        return somewhere
      },
    }
    renderHook(() => useEditorShortcuts(current))
    expect(fireEvent.keyDown(document.body, { key: 'F6' })).toBe(false)
    expect(fireEvent.keyDown(document.body, { key: 'F6', shiftKey: true })).toBe(false)
    somewhere = false
    expect(fireEvent.keyDown(document.body, { key: 'F6' })).toBe(true)
    expect(directions).toEqual([1, -1, 1])
  })
})

describe('keyboard help', () => {
  it('lists ⌘ on Apple keyboards (no Ctrl+Y there) and Ctrl elsewhere', () => {
    const keysOf = (apple: boolean, action: string) =>
      shortcutGroups(apple)
        .flatMap((group) => group.rows)
        .find((row) => row.action === action)?.keys
    expect(keysOf(false, 'Undo')).toEqual([['Ctrl', 'Z']])
    expect(keysOf(false, 'Redo')).toEqual([
      ['Ctrl', 'Shift', 'Z'],
      ['Ctrl', 'Y'],
    ])
    expect(keysOf(true, 'Undo')).toEqual([['⌘', 'Z']])
    expect(keysOf(true, 'Redo')).toEqual([['⌘', 'Shift', 'Z']])
    expect(keysOf(true, 'Duplicate the part')).toEqual([['⌘', 'D']])
    expect(keysOf(true, 'Move the part without selecting it first')).toEqual([
      ['⌥', '↑'],
      ['⌥', '↓'],
    ])
    // The rack's own keys are listed too.
    const titles = shortcutGroups(false).map((group) => group.title)
    expect(titles).toEqual(['Anywhere in the editor', 'View', 'While placing', 'Parts on the rack'])
  })
})
