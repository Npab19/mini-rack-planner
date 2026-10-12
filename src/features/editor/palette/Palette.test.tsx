import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDbForTests } from '@/db/db'
import { stopLibrarySync } from '@/state/catalogStore'
import { resetDbStatusForTests } from '@/state/dbStatus'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { useAddPart } from '@/features/custom/addPartStore'
import { useEditorState } from '../editorState'
import { buildPlan, currentPlan, openPlan, ZETA } from '../inspector/__fixtures__/editorPlans'
import { clearAnnouncement } from '../layout/announcer'
import { EditorLiveRegion } from '../layout/EditorLiveRegion'
import { subscribeAddAtURequest } from '../toolbar/addAtURequest'
import { Palette } from './Palette'

/** The palette announces through the editor shell's live region. */
function PaletteInShell() {
  return (
    <>
      <Palette />
      <EditorLiveRegion />
    </>
  )
}

function row(id: string): HTMLElement {
  return screen.getByTestId(`palette-item-${id}`)
}

beforeEach(async () => {
  await resetDbForTests()
  resetDbStatusForTests()
  useUiStore.setState({ recordingMode: {}, selection: [] })
  useEditorState.getState().reset()
  clearAnnouncement()
})

afterEach(async () => {
  cleanup()
  await usePlanStore.getState().unload()
  stopLibrarySync()
  vi.restoreAllMocks()
})

describe('Palette', () => {
  it('searches the plan’s parts, hides other frames’ parts, and Place starts placing', async () => {
    await openPlan(buildPlan([{ typeId: 's3', have: true }]))
    render(<PaletteInShell />)

    fireEvent.change(screen.getByTestId('palette-search'), { target: { value: 'zeta' } })
    await waitFor(() => expect(row(ZETA.pcMount)).toBeInTheDocument())
    expect(row(ZETA.blank1u)).toBeInTheDocument()
    expect(row(ZETA.blank2u)).toBeInTheDocument()
    // Made for another frame: hidden while "Fits this frame" is on.
    expect(screen.queryByTestId(`palette-item-${ZETA.labRaxMount}`)).toBeNull()
    // Devices live in their own tab.
    expect(screen.queryByTestId(`palette-item-${ZETA.tinyPc}`)).toBeNull()

    const mount = row(ZETA.pcMount)
    expect(mount).toHaveTextContent(
      '1U · Mounts · by Zeta Designer · Standard Digital File License',
    )
    expect(within(mount).getByText('Unverified')).toBeInTheDocument()
    const link = within(mount).getByRole('link', {
      name: 'Open page: Zeta PC mount 1U (opens in a new tab)',
    })
    expect(link).toHaveAttribute('href', 'https://makerworld.com/en/models/1')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveAttribute('target', '_blank')

    fireEvent.click(screen.getByRole('switch', { name: /Fits this frame/ }))
    await waitFor(() => expect(row(ZETA.labRaxMount)).toBeInTheDocument())

    fireEvent.click(screen.getByTestId(`palette-place-${ZETA.pcMount}`))
    expect(useEditorState.getState().placing).toEqual({ kind: 'item', itemId: ZETA.pcMount })
    expect(screen.getByText(/^Placing Zeta PC mount 1U: choose a free spot/)).toBeInTheDocument()
  })

  it('moves through the results with the arrow keys and places with Enter', async () => {
    await openPlan(buildPlan([{ typeId: 's3', have: true }]))
    render(<PaletteInShell />)
    const search = screen.getByTestId('palette-search')
    fireEvent.change(search, { target: { value: 'zeta' } })
    await waitFor(() => expect(row(ZETA.pcMount)).toBeInTheDocument())

    // Same score: by name. Only the active row is a tab stop.
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const first = screen.getByTestId(`palette-place-${ZETA.blank1u}`)
    expect(first).toHaveFocus()
    expect(first).toHaveAttribute('tabindex', '0')
    expect(screen.getByTestId(`palette-place-${ZETA.blank2u}`)).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(first, { key: 'ArrowDown' })
    const second = screen.getByTestId(`palette-place-${ZETA.blank2u}`)
    expect(second).toHaveFocus()
    expect(second).toHaveAttribute('tabindex', '0')

    fireEvent.keyDown(second, { key: 'End' })
    expect(screen.getByTestId(`palette-place-${ZETA.pcMount}`)).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId(`palette-place-${ZETA.pcMount}`), { key: 'Home' })
    expect(first).toHaveFocus()

    fireEvent.keyDown(first, { key: 'ArrowDown' })
    fireEvent.keyDown(second, { key: 'Enter' })
    expect(useEditorState.getState().placing).toEqual({ kind: 'item', itemId: ZETA.blank2u })

    fireEvent.keyDown(first, { key: 'ArrowUp' })
    expect(search).toHaveFocus()
  })

  it('adds devices to Equipment to fit (owned while recording) and places ear-mounted gear', async () => {
    const plan = await openPlan(buildPlan([{ typeId: 's3', have: true }]))
    useUiStore.getState().setRecordingMode(plan.id, true)
    render(<PaletteInShell />)

    fireEvent.click(screen.getByRole('tab', { name: 'Devices' }))
    fireEvent.change(screen.getByTestId('palette-search'), { target: { value: 'zeta' } })
    await waitFor(() => expect(row(ZETA.switch)).toBeInTheDocument())
    expect(screen.queryByTestId(`palette-item-${ZETA.pcMount}`)).toBeNull()
    expect(row(ZETA.tinyPc)).toHaveTextContent('179 × 183 × 34.5 mm · Mini PCs')

    // Not ear-mounted: no Place, Enter adds it to the tray.
    expect(within(row(ZETA.switch)).queryByRole('button', { name: /^Place/ })).toBeNull()
    fireEvent.click(
      within(row(ZETA.switch)).getByRole('button', {
        name: 'Add to Equipment to fit: Zeta Switch 8',
      }),
    )
    expect(currentPlan().equipment).toEqual([
      expect.objectContaining({ deviceId: ZETA.switch, have: true }),
    ])
    expect(
      screen.getByText('Added Zeta Switch 8 to Equipment to fit, marked In my rack.'),
    ).toBeInTheDocument()

    // Ear-mounted gear: Place it directly.
    expect(row(ZETA.pdu)).toHaveTextContent('1U rack-mount')
    fireEvent.click(screen.getByTestId(`palette-place-${ZETA.pdu}`))
    expect(useEditorState.getState().placing).toEqual({ kind: 'device', deviceId: ZETA.pdu })
  })

  it('filters by category, lists my own parts, and explains when nothing matches', async () => {
    await openPlan(buildPlan([{ typeId: 's3', have: true }]))
    render(<PaletteInShell />)

    fireEvent.click(screen.getByRole('tab', { name: 'My parts' }))
    await waitFor(() => expect(row(ZETA.tinyPc)).toBeInTheDocument())
    expect(row(ZETA.pcMount)).toBeInTheDocument()

    const categories = screen.getByRole('group', { name: 'Categories' })
    fireEvent.click(within(categories).getByRole('button', { name: 'Panels' }))
    await waitFor(() => expect(screen.queryByTestId(`palette-item-${ZETA.tinyPc}`)).toBeNull())
    expect(row(ZETA.blank1u)).toBeInTheDocument()
    expect(row(ZETA.blank2u)).toBeInTheDocument()
    expect(within(categories).getByRole('button', { name: 'Panels' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    fireEvent.change(screen.getByTestId('palette-search'), { target: { value: 'no such part' } })
    expect(await screen.findByText('No parts match “no such part”.')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Can’t find it? Add it yourself: by hand, from a MakerWorld link or from a model file.',
      ),
    ).toBeInTheDocument()
  })

  it('opens Add a part for this plan from the results and from no results', async () => {
    await openPlan(buildPlan([{ typeId: 's3', have: true }]))
    render(<PaletteInShell />)
    fireEvent.change(screen.getByTestId('palette-search'), { target: { value: 'zeta' } })
    await waitFor(() => expect(row(ZETA.pcMount)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Add a part from a link or file' }))
    expect(useAddPart.getState().request).toEqual({
      kind: 'wizard',
      addToOpenPlan: true,
      placeAfterSave: true,
    })
    act(() => useAddPart.getState().close())

    // No results: the search text names the new part.
    fireEvent.change(screen.getByTestId('palette-search'), { target: { value: 'no such part' } })
    expect(await screen.findByText('No parts match “no such part”.')).toBeInTheDocument()
    expect(screen.getAllByRole('group', { name: 'Add your own part' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Create a custom part' }))
    expect(useAddPart.getState().request).toEqual({
      kind: 'item',
      prefill: { name: 'no such part' },
      addToOpenPlan: true,
      placeAfterSave: true,
    })
    act(() => useAddPart.getState().close())

    // A pasted link starts the wizard from it.
    const link = 'https://makerworld.com/en/models/1945283-tiny-mount'
    fireEvent.change(screen.getByTestId('palette-search'), { target: { value: link } })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add a part from a link or file' })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add a part from a link or file' }))
    expect(useAddPart.getState().request).toMatchObject({ kind: 'wizard', url: link })
    act(() => useAddPart.getState().close())
  })

  it('creates a device from the Devices tab', async () => {
    await openPlan(buildPlan([{ typeId: 's3', have: true }]))
    render(<PaletteInShell />)
    fireEvent.click(screen.getByRole('tab', { name: 'Devices' }))
    fireEvent.change(screen.getByTestId('palette-search'), { target: { value: 'Big NAS' } })
    expect(await screen.findByText('No parts match “Big NAS”.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create a custom part' }))
    expect(useAddPart.getState().request).toMatchObject({
      kind: 'device',
      prefill: { model: 'Big NAS' },
      placeAfterSave: true,
    })
    act(() => useAddPart.getState().close())
  })

  it('keeps its rows plain outside the editor’s drag provider', async () => {
    await openPlan(buildPlan([{ typeId: 's3', have: true }]))
    render(<PaletteInShell />)
    fireEvent.change(screen.getByTestId('palette-search'), { target: { value: 'zeta' } })
    await waitFor(() => expect(row(ZETA.pcMount)).toBeInTheDocument())
    const mount = row(ZETA.pcMount)
    expect(mount).not.toHaveAttribute('data-rack-drag-source')
    expect(mount).not.toHaveAttribute('role')
    expect(mount).not.toHaveAttribute('tabindex')
    expect(mount.querySelector('[data-drag-grip]')).toBeNull()
  })

  it('Add at U… asks the rack for its dialog when the rack offers one', async () => {
    await openPlan(buildPlan([{ typeId: 's3', have: true }]))
    const handler = vi.fn()
    const unsubscribe = subscribeAddAtURequest(handler)
    try {
      render(<PaletteInShell />)
      fireEvent.change(screen.getByTestId('palette-search'), { target: { value: 'zeta' } })
      await waitFor(() => expect(row(ZETA.blank1u)).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: 'Add at U…: Zeta blank 1U' }))
      // The rack's dialog is told what to add; nothing starts placing.
      expect(handler).toHaveBeenCalledWith({ kind: 'item', itemId: ZETA.blank1u })
      expect(useEditorState.getState().placing).toBeNull()
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      unsubscribe()
    }
  })

  it('Add at U… opens the rack’s dialog itself when no editor host offers it', async () => {
    await openPlan(
      buildPlan([
        { typeId: 's3', have: true },
        { typeId: 's6', have: true },
      ]),
    )
    render(<PaletteInShell />)
    fireEvent.change(screen.getByTestId('palette-search'), { target: { value: 'zeta' } })
    await waitFor(() => expect(row(ZETA.blank1u)).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Add at U…: Zeta blank 1U' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add Zeta blank 1U at…' })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'U5' }))
    fireEvent.click(within(dialog).getByTestId('add-at-u-submit'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const placements = currentPlan().placements
    expect(placements).toEqual([
      expect.objectContaining({ itemId: ZETA.blank1u, y: 24, face: 'front' }),
    ])
    expect(useUiStore.getState().selection).toEqual([placements[0]?.id])
    expect(useEditorState.getState().placing).toBeNull()
  })
})
