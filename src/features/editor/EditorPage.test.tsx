import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadBundledCatalog } from '@/catalog/loader'
import { getDb, resetDbForTests } from '@/db/db'
import { putLibraryEntry } from '@/db/libraryRepo'
import { createPlan, getPlan, listPlanSummaries, savePlan } from '@/db/plansRepo'
import { newCustomDevice } from '@/domain/customParts'
import { addEquipment } from '@/domain/devices'
import type { Plan } from '@/domain/schema/plan'
import { buildSamplePlan } from '@/features/plans/sample'
import { stopLibrarySync, useCatalogStore } from '@/state/catalogStore'
import { resetDbStatusForTests } from '@/state/dbStatus'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { EditorPage } from './EditorPage'
import { useEditorState } from './editorState'
import { clearAnnouncement } from './layout/announcer'
import { resetEditorShell } from './layout/shellStore'
import { DESKTOP_QUERY } from './layout/useMediaQuery'
import { subscribeAddAtURequest } from './toolbar/addAtURequest'
import { subscribeFitRequest } from './toolbar/fitRequest'

/** Autosave runs 400 ms after the last change; allow for a slow machine. */
const SAVED = { timeout: 4000 }

const PANELS = ['palette', 'equipment', 'inspector', 'checks', 'bom'] as const

function renderEditor(planId: string) {
  const router = createMemoryRouter(
    [
      { path: '/', element: <h1>Your racks</h1> },
      { path: '/plan/:planId', element: <EditorPage /> },
    ],
    { initialEntries: [`/plan/${planId}`] },
  )
  render(<RouterProvider router={router} />)
  return router
}

async function storedSample(): Promise<Plan> {
  const { plan } = buildSamplePlan(loadBundledCatalog().lookup, new Date().toISOString())
  return createPlan(plan)
}

async function nameInput(): Promise<HTMLInputElement> {
  const input = await screen.findByTestId('plan-name-input')
  if (!(input instanceof HTMLInputElement)) throw new Error('not an input')
  return input
}

function saveState(): string {
  return screen.getByTestId('save-state').textContent ?? ''
}

function press(
  key: string,
  init: Partial<KeyboardEventInit> = {},
  target: Element = document.body,
) {
  fireEvent.keyDown(target, { key, ...init })
}

/** The shell's live region (role status, polite). */
function announced(text: string): void {
  expect(screen.getAllByRole('status').some((region) => region.textContent?.trim() === text)).toBe(
    true,
  )
}

/** jsdom has no matchMedia: the editor then uses the desktop layout. This picks one explicitly. */
function useLayout(desktop: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === DESKTOP_QUERY ? desktop : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
}

beforeEach(async () => {
  await resetDbForTests()
  resetDbStatusForTests()
  useUiStore.setState({ ...useUiStore.getInitialState(), recordingMode: {} })
  useEditorState.getState().reset()
  resetEditorShell()
  clearAnnouncement()
})

afterEach(async () => {
  cleanup()
  Reflect.deleteProperty(window, 'matchMedia')
  vi.restoreAllMocks()
  await usePlanStore.getState().unload()
  stopLibrarySync()
})

describe('EditorPage: loading and the M2 behaviour', () => {
  it('says when the plan is not in this browser', async () => {
    renderEditor('plan-missing')
    expect(screen.getByRole('heading', { level: 1, name: 'Rack editor' })).toBeInTheDocument()
    expect(await screen.findByText('Plan not found')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to your racks' })).toHaveAttribute('href', '/')
  })

  it('shows the plan in the toolbar: editable name, frame and stack, save state', async () => {
    const plan = await storedSample()
    renderEditor(plan.id)
    const input = await nameInput()
    expect(input).toHaveValue('Sample: KWS 9U → 12U')
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus()
    const toolbar = screen.getByTestId('editor-toolbar')
    expect(within(toolbar).getByText('KWS Rack v2 · 3U + 6U + 3U · 12U')).toBeInTheDocument()
    expect(within(toolbar).getByRole('link', { name: 'Your racks' })).toHaveAttribute('href', '/')
    expect(saveState()).toBe('Saved')
    expect(screen.queryByText('Recording what you have')).toBeNull()
    expect(screen.queryByTestId('placing-banner')).toBeNull()
  })

  it('autosaves a rename, which undo and redo (buttons and keys) take back and forth', async () => {
    const plan = await storedSample()
    renderEditor(plan.id)
    const input = await nameInput()
    fireEvent.change(input, { target: { value: 'Garage rack' } })
    expect(saveState()).toBe('Saving…')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(saveState()).toBe('Saved'), SAVED)
    expect((await getPlan(plan.id)).plan.name).toBe('Garage rack')

    const undo = screen.getByRole('button', { name: 'Undo' })
    expect(undo).toHaveAttribute('data-testid', 'toolbar-undo')
    expect(undo).toBeEnabled()
    fireEvent.click(undo)
    expect(input).toHaveValue('Sample: KWS 9U → 12U')
    announced('Undone.')
    press('z', { ctrlKey: true, shiftKey: true })
    expect(input).toHaveValue('Garage rack')
    announced('Redone.')
    press('z', { ctrlKey: true })
    expect(input).toHaveValue('Sample: KWS 9U → 12U')
    press('y', { ctrlKey: true })
    expect(input).toHaveValue('Garage rack')
    press('z', { metaKey: true })
    expect(input).toHaveValue('Sample: KWS 9U → 12U')
    press('z', { ctrlKey: true })
    announced('Nothing to undo.')
    await waitFor(() => expect(saveState()).toBe('Saved'), SAVED)
    expect((await getPlan(plan.id)).plan.name).toBe('Sample: KWS 9U → 12U')
  })

  it('leaves Ctrl+Z to a text field being typed in', async () => {
    const plan = await storedSample()
    renderEditor(plan.id)
    const input = await nameInput()
    fireEvent.change(input, { target: { value: 'Garage rack' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(saveState()).toBe('Saved'), SAVED)
    press('z', { ctrlKey: true }, input)
    expect(usePlanStore.getState().plan?.name).toBe('Garage rack')
  })

  it('keeps a typing pause as one step, never stores a blank name, and Escape reverts', async () => {
    const plan = await storedSample()
    renderEditor(plan.id)
    const input = await nameInput()
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByText(/A plan needs a name/)).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(input, { target: { value: 'Shed' } })
    fireEvent.change(input, { target: { value: 'Shed rack' } })
    // The pause ends the step, then autosave runs.
    await waitFor(() => expect(saveState()).toBe('Saved'), SAVED)
    expect((await getPlan(plan.id)).plan.name).toBe('Shed rack')
    expect(usePlanStore.temporal.getState().pastStates).toHaveLength(1)

    fireEvent.change(input, { target: { value: 'Oops' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('Shed rack')
    expect(usePlanStore.getState().plan?.name).toBe('Shed rack')
  })

  it('shows Recording mode until "Done, start planning"', async () => {
    const plan = await storedSample()
    useUiStore.getState().setRecordingMode(plan.id, true)
    renderEditor(plan.id)
    const banner = await screen.findByRole('region', { name: 'Recording what you have' })
    fireEvent.click(within(banner).getByRole('button', { name: 'Done, start planning' }))
    expect(screen.queryByRole('region', { name: 'Recording what you have' })).toBeNull()
    expect(useUiStore.getState().recordingMode[plan.id]).toBeUndefined()
    announced('Planning: new things you add are marked To get.')
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus()
  })

  it('opens a plan from a newer app version read-only', async () => {
    const plan = await storedSample()
    await getDb().plans.update(plan.id, { schema: 2, plan: { ...plan, schema: 2 } })
    renderEditor(plan.id)
    const input = await nameInput()
    expect(input).toHaveAttribute('readonly')
    expect(saveState()).toBe('Read-only')
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled()
  })

  it('reports a change made in another tab instead of overwriting it', async () => {
    const plan = await storedSample()
    renderEditor(plan.id)
    const input = await nameInput()
    // Another tab saves first (rev 1 -> 2).
    await act(async () => {
      await savePlan({ ...plan, name: 'Renamed elsewhere' }, 1)
    })
    fireEvent.change(input, { target: { value: 'Renamed here' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(saveState()).toBe('Not saved'), SAVED)
    expect(screen.getByText('(changed in another tab)')).toBeInTheDocument()
    expect((await getPlan(plan.id)).plan.name).toBe('Renamed elsewhere')
  })

  it('asks before leaving with changes another tab kept from being saved', async () => {
    const plan = await storedSample()
    const router = renderEditor(plan.id)
    const input = await nameInput()
    await act(async () => {
      await savePlan({ ...plan, name: 'Renamed elsewhere' }, 1)
    })
    fireEvent.change(input, { target: { value: 'Renamed here' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(saveState()).toBe('Not saved'), SAVED)

    fireEvent.click(screen.getByRole('link', { name: 'Your racks' }))
    const dialog = await screen.findByRole('dialog', { name: 'Keep your latest changes?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay here' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(router.state.location.pathname).toBe(`/plan/${plan.id}`)

    fireEvent.click(screen.getByRole('link', { name: 'Your racks' }))
    const again = await screen.findByRole('dialog', { name: 'Keep your latest changes?' })
    fireEvent.click(within(again).getByRole('button', { name: 'Save as a copy and leave' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'), SAVED)
    const others = (await listPlanSummaries()).filter((summary) => summary.id !== plan.id)
    expect(others.map((summary) => summary.name)).toEqual(['Renamed here (copy)'])
    expect((await getPlan(plan.id)).plan.name).toBe('Renamed elsewhere')
  })

  it('lets a plan without stranded changes go without asking', async () => {
    const plan = await storedSample()
    const router = renderEditor(plan.id)
    await nameInput()
    fireEvent.click(screen.getByRole('link', { name: 'Your racks' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('EditorPage: desktop layout (lg and up)', () => {
  beforeEach(() => useLayout(true))

  it('lays out the toolbar, the rack and the five panels, the BOM as a closed drawer', async () => {
    const plan = await storedSample()
    renderEditor(plan.id)
    await nameInput()
    for (const testId of [
      'editor-toolbar',
      'toolbar-undo',
      'toolbar-redo',
      'toolbar-zoom-in',
      'toolbar-zoom-out',
      'toolbar-fit',
      'toolbar-face-front',
      'toolbar-face-rear',
      'toolbar-checks',
      'toolbar-bom',
      'panel-rack',
    ]) {
      expect(screen.getByTestId(testId)).toBeInTheDocument()
    }
    for (const panel of PANELS) expect(screen.getByTestId(`panel-${panel}`)).toBeInTheDocument()
    // The real panels render inside their boxes.
    for (const panel of ['palette', 'equipment', 'inspector', 'checks'] as const) {
      expect(screen.getByTestId(`panel-${panel}`)).not.toBeEmptyDOMElement()
    }
    expect(screen.getByTestId('panel-rack')).not.toBeEmptyDOMElement()
    // No sheet buttons on desktop.
    expect(screen.queryByTestId('toolbar-sheet-palette')).toBeNull()

    const drawer = screen.getByTestId('panel-bom')
    const toggle = within(drawer).getByRole('button', { name: 'Bill of materials' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(drawer.childElementCount).toBe(1)
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(useUiStore.getState().panels.bom).toBe(true)
    expect(drawer.childElementCount).toBe(2)
    expect(screen.getByTestId('toolbar-bom')).toHaveAttribute('aria-expanded', 'true')
  })

  it('summarises checks and lines to get; Checks moves focus to the panel', async () => {
    const plan = await storedSample()
    renderEditor(plan.id)
    await nameInput()
    const checks = screen.getByTestId('toolbar-checks')
    expect(checks).toHaveAccessibleName(/^Checks: (no problems|\d+ (error|warning)s?.*)$/)
    const bom = screen.getByTestId('toolbar-bom')
    // The sample's new 3U section and its drive rack are still to get.
    expect(bom).toHaveAccessibleName(/^BOM: \d+ lines? to get$/)
    expect(within(bom).getByText(/^\d+ to get$/)).toBeInTheDocument()

    fireEvent.click(checks)
    expect(screen.getByTestId('panel-checks').contains(document.activeElement)).toBe(true)

    fireEvent.click(bom)
    expect(useUiStore.getState().panels.bom).toBe(true)
    announced('Bill of materials shown.')
  })

  it('zooms, fits and turns the rack from the toolbar', async () => {
    const plan = await storedSample()
    renderEditor(plan.id)
    await nameInput()
    fireEvent.click(screen.getByTestId('toolbar-zoom-in'))
    expect(useUiStore.getState().zoom).toBe(1.1)
    announced('Zoom 110%.')
    fireEvent.click(screen.getByTestId('toolbar-zoom-out'))
    fireEvent.click(screen.getByTestId('toolbar-zoom-out'))
    expect(useUiStore.getState().zoom).toBe(0.9)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom 90%. Reset to 100%' }))
    expect(useUiStore.getState().zoom).toBe(1)

    act(() => useUiStore.getState().setZoom(4))
    const zoomIn = screen.getByTestId('toolbar-zoom-in')
    expect(zoomIn).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(zoomIn)
    expect(useUiStore.getState().zoom).toBe(4)
    announced('Zoom 400%, the largest.')

    const fit = vi.fn(() => useUiStore.getState().setZoom(0.8))
    const stop = subscribeFitRequest(fit)
    fireEvent.click(screen.getByTestId('toolbar-fit'))
    stop()
    expect(fit).toHaveBeenCalledTimes(1)
    announced('Zoomed to fit: 80%.')

    const faces = screen.getByRole('radiogroup', { name: 'Rack face' })
    const rear = within(faces).getByRole('radio', { name: 'Rear' })
    fireEvent.click(rear)
    expect(useUiStore.getState().face).toBe('rear')
    expect(rear).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('toolbar-face-front')).toHaveAttribute('aria-checked', 'false')
    announced('Showing the rear of the rack.')
  })

  it('runs the global shortcuts, but not while typing or inside a dialog', async () => {
    const plan = await storedSample()
    renderEditor(plan.id)
    const input = await nameInput()

    press(']')
    expect(useUiStore.getState().zoom).toBe(1.1)
    press('[')
    press('-')
    expect(useUiStore.getState().zoom).toBe(0.9)
    press('+')
    expect(useUiStore.getState().zoom).toBe(1)
    press('2')
    expect(useUiStore.getState().face).toBe('rear')
    // Browser and system shortcuts stay theirs.
    press('1', { altKey: true })
    press('1', { ctrlKey: true })
    expect(useUiStore.getState().face).toBe('rear')
    press('1')
    expect(useUiStore.getState().face).toBe('front')
    press('b')
    expect(useUiStore.getState().panels.bom).toBe(true)
    press('B')
    expect(useUiStore.getState().panels.bom).toBe(false)
    const fit = vi.fn()
    const stop = subscribeFitRequest(fit)
    press('f')
    press('f', { ctrlKey: true })
    press('f', { metaKey: true })
    stop()
    expect(fit).toHaveBeenCalledTimes(1)
    // A key someone already handled is left alone.
    const handled = new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true })
    handled.preventDefault()
    document.body.dispatchEvent(handled)
    expect(useUiStore.getState().panels.bom).toBe(false)

    // Typing in a field types.
    press('b', {}, input)
    press(']', {}, input)
    expect(useUiStore.getState().panels.bom).toBe(false)
    expect(useUiStore.getState().zoom).toBe(1)

    press('?')
    const help = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    for (const action of ['Undo', 'Redo', 'Fit the whole rack in view', 'Duplicate the part']) {
      expect(within(help).getByText(action)).toBeInTheDocument()
    }
    // Inside the dialog the editor's keys do nothing; Esc closes the dialog.
    press('b', {}, within(help).getByRole('button', { name: 'Close' }))
    expect(useUiStore.getState().panels.bom).toBe(false)
    fireEvent.click(within(help).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(screen.getByTestId('toolbar-help'))
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
  })

  it('shows what is being placed; Esc or Cancel stops placing, then Esc clears the selection', async () => {
    const plan = await storedSample()
    renderEditor(plan.id)
    await nameInput()

    act(() => {
      useEditorState.getState().startPlacing({ kind: 'item', itemId: 'lenovo-tiny-mount-1u' })
    })
    const banner = screen.getByTestId('placing-banner')
    expect(banner).toHaveTextContent(
      'Placing Lenovo Tiny mount 1U – click a free spot on the rack, or press Esc.',
    )
    // Add at U… opens the rack's dialog for what is being placed; Esc there closes only it.
    fireEvent.click(within(banner).getByRole('button', { name: 'Add at U…' }))
    const addAt = await screen.findByRole('dialog', { name: 'Add Lenovo Tiny mount 1U at…' })
    fireEvent.keyDown(addAt, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(useEditorState.getState().placing).not.toBeNull()

    press('Escape')
    expect(useEditorState.getState().placing).toBeNull()
    expect(screen.queryByTestId('placing-banner')).toBeNull()
    announced('Stopped placing.')

    // A tray device going into a mount; a later "Add at U…" handler takes over from the rack's.
    act(() => {
      usePlanStore.getState().edit((draft) => {
        draft.equipment.push({
          id: 'eq-test',
          deviceId: 'lenovo-thinkcentre-m720q-tiny',
          have: false,
        })
      })
    })
    const addAtU = vi.fn()
    let stop: () => void = () => undefined
    act(() => {
      stop = subscribeAddAtURequest(addAtU)
      useEditorState
        .getState()
        .startPlacing({ kind: 'item', itemId: 'lenovo-tiny-mount-1u', equipmentId: 'eq-test' })
    })
    const again = screen.getByTestId('placing-banner')
    expect(again).toHaveTextContent(
      'Placing Lenovo Tiny mount 1U for Lenovo ThinkCentre M720q Tiny',
    )
    fireEvent.click(within(again).getByRole('button', { name: 'Add at U…' }))
    expect(addAtU).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => stop())
    const cancel = within(again).getByRole('button', { name: 'Cancel' })
    cancel.focus()
    fireEvent.click(cancel)
    expect(useEditorState.getState().placing).toBeNull()
    // Focus does not fall to the page when the banner goes: it lands on the rack.
    expect(screen.getByTestId('panel-rack')).toHaveFocus()

    act(() => useUiStore.getState().select(['some-placement']))
    press('Escape')
    expect(useUiStore.getState().selection).toEqual([])
    announced('Selection cleared.')
  })

  it('moves between the toolbar, the panels and the rack with F6 and Shift+F6', async () => {
    const plan = await storedSample()
    renderEditor(plan.id)
    await nameInput()
    const focusIn = (testId: string) =>
      expect(screen.getByTestId(testId).contains(document.activeElement)).toBe(true)
    const f6 = (shiftKey = false) =>
      act(() => press('F6', { shiftKey }, document.activeElement ?? document.body))

    // The plan opens on its heading, in the toolbar.
    focusIn('editor-toolbar')
    f6()
    expect(screen.getByTestId('palette-search')).toHaveFocus()
    // F6 works from a text field too: it types nothing.
    f6()
    focusIn('panel-equipment')
    f6()
    // The rack: its part in the tab order.
    expect(document.activeElement?.getAttribute('data-placement-id')).not.toBeNull()
    focusIn('panel-rack')
    f6()
    focusIn('panel-inspector')
    f6()
    focusIn('panel-checks')
    f6()
    expect(screen.getByRole('button', { name: 'Bill of materials' })).toHaveFocus()
    f6()
    focusIn('editor-toolbar')
    f6(true)
    expect(screen.getByRole('button', { name: 'Bill of materials' })).toHaveFocus()
    f6(true)
    focusIn('panel-checks')
  })

  it('F6 to the rack while placing lands on the drawing, where the keys move the ghost', async () => {
    const plan = await storedSample()
    renderEditor(plan.id)
    await nameInput()
    act(() => useEditorState.getState().startPlacing({ kind: 'item', itemId: 'generic-blank-1u' }))
    // From the heading: Parts, Equipment, then the rack.
    for (let step = 0; step < 3; step += 1) {
      act(() => press('F6', {}, document.activeElement ?? document.body))
    }
    expect(screen.getByTestId('rack-svg')).toHaveFocus()
  })

  it('places from the palette with Add at U…, then shows the new part in the inspector', async () => {
    const plan = await storedSample()
    renderEditor(plan.id)
    await nameInput()
    const palette = screen.getByTestId('panel-palette')
    fireEvent.change(within(palette).getByTestId('palette-search'), {
      target: { value: 'Vented panel' },
    })
    fireEvent.click(
      await within(palette).findByRole('button', { name: 'Add at U…: Vented panel 1U' }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'Add Vented panel 1U at…' })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'U7' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add at U7' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const added = usePlanStore.getState().plan?.placements.at(-1)
    expect(added).toMatchObject({ itemId: 'generic-vent-1u', y: 36 })
    expect(useUiStore.getState().selection).toEqual([added?.id])
    // Nothing was being placed, and nothing is now.
    expect(useEditorState.getState().placing).toBeNull()
    const inspector = screen.getByTestId('panel-inspector')
    expect(
      within(inspector).getByRole('heading', { level: 2, name: 'Vented panel 1U' }),
    ).toBeInTheDocument()
    expect(within(inspector).getByText('U7 · front')).toBeInTheDocument()

    // "Add another at U…" in the inspector asks the same dialog for the same part.
    fireEvent.click(within(inspector).getByRole('button', { name: 'Add another at U…' }))
    const again = await screen.findByRole('dialog', { name: 'Add Vented panel 1U at…' })
    fireEvent.click(within(again).getByRole('radio', { name: 'U8' }))
    fireEvent.click(within(again).getByRole('button', { name: 'Add at U8' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const second = usePlanStore.getState().plan?.placements.at(-1)
    expect(second).toMatchObject({ itemId: 'generic-vent-1u', y: 42 })
    expect(useUiStore.getState().selection).toEqual([second?.id])
    expect(within(inspector).getByText('U8 · front')).toBeInTheDocument()
  })

  it('resets the editor state when the editor closes', async () => {
    const plan = await storedSample()
    const router = renderEditor(plan.id)
    await nameInput()
    act(() => {
      useEditorState.getState().startPlacing({ kind: 'device', deviceId: 'netio-powerpdu-4kb' })
      useEditorState.getState().setInspectorTab('rack')
    })
    expect(screen.getByTestId('placing-banner')).toHaveTextContent(/^Placing NETIO /)
    fireEvent.click(screen.getByRole('link', { name: 'Your racks' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(useEditorState.getState().placing).toBeNull()
    expect(useEditorState.getState().inspectorTab).toBe('selection')
  })
  it('copies a part of your own into the plan when an edit starts using it', async () => {
    const device = await putLibraryEntry(
      newCustomDevice(
        {
          brand: 'Zeta',
          model: 'Box 9',
          category: 'mini-pc',
          widthMm: 150,
          depthMm: 150,
          heightMm: 40,
          power: 'brick',
          today: '2026-10-11',
        },
        new Set(),
      ),
    )
    const plan = await storedSample()
    const router = renderEditor(plan.id)
    await nameInput()
    await waitFor(() =>
      expect(useCatalogStore.getState().library.map((entry) => entry.id)).toContain(device.id),
    )
    const applied = usePlanStore
      .getState()
      .applyOp((current) => ({ plan: addEquipment(current, device.id, false) }))
    expect(applied.applied).toBe(true)
    expect(usePlanStore.getState().plan?.custom.devices).toEqual([device])
    // One undo step takes back the device and its copy.
    act(() => usePlanStore.getState().undo())
    expect(usePlanStore.getState().plan?.custom.devices).toEqual([])

    // Leaving the editor stops it: plan edits elsewhere are left as they are.
    fireEvent.click(screen.getByRole('link', { name: 'Your racks' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    await waitFor(() => expect(usePlanStore.getState().planId).toBeNull())
    await act(() => usePlanStore.getState().load(plan.id))
    usePlanStore
      .getState()
      .applyOp((current) => ({ plan: addEquipment(current, device.id, false) }))
    expect(usePlanStore.getState().plan?.custom.devices).toEqual([])
  })
})

describe('EditorPage: below lg', () => {
  beforeEach(() => useLayout(false))

  it('fills the screen with the rack and opens the panels as sheets, one at a time', async () => {
    const plan = await storedSample()
    renderEditor(plan.id)
    await nameInput()
    expect(screen.getByTestId('panel-rack')).toBeInTheDocument()
    for (const panel of PANELS) expect(screen.queryByTestId(`panel-${panel}`)).toBeNull()

    const panels = screen.getByRole('group', { name: 'Panels' })
    expect(
      within(panels)
        .getAllByRole('button')
        .map((button) => button.getAttribute('data-testid')),
    ).toEqual([
      'toolbar-sheet-palette',
      'toolbar-sheet-equipment',
      'toolbar-sheet-inspector',
      'toolbar-checks',
      'toolbar-bom',
    ])
    expect(screen.getByTestId('toolbar-bom')).toHaveAccessibleName(
      /^BOM: bill of materials, \d+ lines? to get$/,
    )

    fireEvent.click(screen.getByTestId('toolbar-sheet-inspector'))
    const inspector = await screen.findByRole('dialog', { name: 'Inspector' })
    expect(within(inspector).getByTestId('panel-inspector')).toBeInTheDocument()
    expect(screen.getByTestId('toolbar-sheet-inspector')).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(within(inspector).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // B opens the BOM sheet below lg (the desktop drawer state is left alone).
    press('b')
    const bom = await screen.findByRole('dialog', { name: 'Bill of materials' })
    expect(within(bom).getByTestId('panel-bom')).toBeInTheDocument()
    expect(useUiStore.getState().panels.bom).toBe(false)
    // Opening another panel replaces the sheet: never two at once.
    fireEvent.click(screen.getByTestId('toolbar-checks'))
    const checks = await screen.findByRole('dialog', { name: 'Checks' })
    expect(within(checks).getByTestId('panel-checks')).toBeInTheDocument()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.queryByTestId('panel-bom')).toBeNull()
    press('b', {}, within(checks).getByRole('button', { name: 'Close' }))
    expect(screen.getByRole('dialog', { name: 'Checks' })).toBeInTheDocument()
    // Choosing a check selects its target on the rack: the sheet makes way.
    act(() => useUiStore.getState().select(['some-placement']))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('closes the sheet when placing starts, so the rack is in view', async () => {
    const plan = await storedSample()
    renderEditor(plan.id)
    await nameInput()
    fireEvent.click(screen.getByTestId('toolbar-sheet-palette'))
    await screen.findByRole('dialog', { name: 'Parts' })
    act(() => useEditorState.getState().startPlacing({ kind: 'item', itemId: 'generic-blank-1u' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByTestId('placing-banner')).toHaveTextContent('Placing ')
  })
})
