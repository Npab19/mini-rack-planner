import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as diagnostics from '@/lib/diagnostics'
import { useUiStore } from '@/state/uiStore'
import { useEditorState } from '../editorState'
import { EditorLayout } from './EditorLayout'
import { useRackViewport } from './rackViewport'
import { focusPanel, openSheet, resetEditorShell, useEditorShell } from './shellStore'

// The real panels belong to other folders and need a loaded plan; the shell is tested on stubs.
const crash = vi.hoisted(() => ({ checks: false }))

vi.mock('../palette/Palette', () => ({
  Palette: () => <section aria-label="Palette">palette stub</section>,
}))
vi.mock('../equipment/EquipmentTray', () => ({
  EquipmentTray: () => <section aria-label="Equipment to fit">equipment stub</section>,
}))
vi.mock('../inspector/Inspector', () => ({
  Inspector: () => (
    <section aria-label="Inspector">
      <h2>Inspector</h2>
      <button type="button">Mark as Have</button>
    </section>
  ),
}))
vi.mock('../checks/ChecksPanel', () => ({
  ChecksPanel: () => {
    if (crash.checks) throw new Error('checks exploded')
    return <section aria-label="Checks">checks stub</section>
  },
}))
vi.mock('../bom/BomPanel', () => ({
  BomPanel: () => <section aria-label="Bill of materials">bom stub</section>,
}))
vi.mock('../rack/RackView', () => ({
  RackView: function RackStub() {
    const viewport = useRackViewport()
    return <p>rack stub in {viewport?.id ?? 'nothing yet'}</p>
  },
}))

beforeAll(() => {
  diagnostics.setReportContext({ planSchema: 1 })
})

beforeEach(() => {
  crash.checks = false
  useUiStore.setState({ ...useUiStore.getInitialState(), recordingMode: {} })
  useEditorState.getState().reset()
  resetEditorShell()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('EditorLayout on desktop', () => {
  it('puts parts and equipment left, the rack in the middle, inspector and checks right', () => {
    render(<EditorLayout desktop />)
    const ids = ['palette', 'equipment', 'rack', 'inspector', 'checks', 'bom'].map((panel) =>
      screen.getByTestId(`panel-${panel}`),
    )
    // Document order is the visual order: left column, rack, right column, drawer.
    for (let index = 1; index < ids.length; index += 1) {
      const previous = ids[index - 1]
      const current = ids[index]
      if (previous === undefined || current === undefined) throw new Error('missing panel')
      expect(previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      )
    }
    expect(screen.getByTestId('panel-palette')).toHaveTextContent('palette stub')
    expect(screen.getByTestId('panel-rack')).toHaveTextContent('rack stub in editor-rack-viewport')
    // Each column box scrolls on its own.
    for (const panel of ['palette', 'equipment', 'inspector', 'checks']) {
      expect(screen.getByTestId(`panel-${panel}`)).toHaveClass('overflow-y-auto')
    }
    expect(screen.getByTestId('panel-rack')).toHaveClass('overflow-auto')
  })

  it('keeps the BOM drawer closed until toggled, remembering it in the UI store', () => {
    const { rerender } = render(<EditorLayout desktop />)
    expect(screen.queryByText('bom stub')).toBeNull()
    const toggle = screen.getByRole('button', { name: 'Bill of materials' })
    expect(toggle.closest('h2')).not.toBeNull()
    fireEvent.click(toggle)
    expect(useUiStore.getState().panels.bom).toBe(true)
    expect(screen.getByText('bom stub')).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-controls')
    act(() => useUiStore.getState().setPanelOpen('bom', false))
    expect(screen.queryByText('bom stub')).toBeNull()
    act(() => useUiStore.getState().setPanelOpen('bom', true))
    rerender(<EditorLayout desktop />)
    expect(screen.getByText('bom stub')).toBeInTheDocument()
  })

  it('shows a crashed panel as an error card while the other panels keep working', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    crash.checks = true
    render(<EditorLayout desktop />)
    const checks = screen.getByTestId('panel-checks')
    expect(within(checks).getByRole('alert')).toHaveTextContent('This panel hit an error')
    expect(screen.getByTestId('panel-inspector')).toHaveTextContent('Mark as Have')
    expect(screen.getByTestId('panel-rack')).toHaveTextContent('rack stub')

    crash.checks = false
    fireEvent.click(within(checks).getByRole('button', { name: 'Try again' }))
    expect(checks).toHaveTextContent('checks stub')
  })

  it('moves focus into a panel: its marked spot, else its heading, else the box', () => {
    render(<EditorLayout desktop />)
    expect(focusPanel('inspector')).toBe(true)
    expect(screen.getByRole('heading', { name: 'Inspector' })).toHaveFocus()
    expect(focusPanel('palette')).toBe(true)
    expect(screen.getByTestId('panel-palette')).toHaveFocus()
  })

  it('closes a sheet left open below lg', () => {
    openSheet('inspector')
    render(<EditorLayout desktop />)
    expect(useEditorShell.getState().sheetOpen).toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('EditorLayout below lg', () => {
  it('shows only the rack until a panel is opened as a sheet', async () => {
    render(<EditorLayout desktop={false} />)
    expect(screen.getByTestId('panel-rack')).toBeInTheDocument()
    for (const panel of ['palette', 'equipment', 'inspector', 'checks', 'bom']) {
      expect(screen.queryByTestId(`panel-${panel}`)).toBeNull()
    }

    act(() => openSheet('equipment'))
    const sheet = await screen.findByRole('dialog', { name: 'Equipment to fit' })
    expect(within(sheet).getByTestId('panel-equipment')).toHaveTextContent('equipment stub')
    expect(sheet).toHaveAttribute('data-editor-sheet')

    act(() => openSheet('bom'))
    const bom = await screen.findByRole('dialog', { name: 'Bill of materials' })
    expect(within(bom).getByTestId('panel-bom')).toHaveTextContent('bom stub')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    fireEvent.click(within(bom).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(useEditorShell.getState().sheetOpen).toBe(false)
  })

  it('closes the sheet when something starts being placed', async () => {
    render(<EditorLayout desktop={false} />)
    act(() => openSheet('palette'))
    await screen.findByRole('dialog', { name: 'Parts' })
    act(() => useEditorState.getState().startPlacing({ kind: 'item', itemId: 'generic-blank-1u' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
