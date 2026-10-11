import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadBundledCatalog } from '@/catalog/loader'
import { getDb, resetDbForTests } from '@/db/db'
import { createPlan, getPlan, listPlanSummaries, savePlan } from '@/db/plansRepo'
import type { Plan } from '@/domain/schema/plan'
import { buildSamplePlan } from '@/features/plans/sample'
import { stopLibrarySync } from '@/state/catalogStore'
import { resetDbStatusForTests } from '@/state/dbStatus'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { EditorPage } from './EditorPage'

/** Autosave runs 400 ms after the last change; allow for a slow machine. */
const SAVED = { timeout: 4000 }

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

beforeEach(async () => {
  await resetDbForTests()
  resetDbStatusForTests()
  useUiStore.setState({ recordingMode: {} })
})

afterEach(async () => {
  cleanup()
  await usePlanStore.getState().unload()
  stopLibrarySync()
})

describe('EditorPage (M2 stub)', () => {
  it('says when the plan is not in this browser', async () => {
    renderEditor('plan-missing')
    expect(screen.getByRole('heading', { level: 1, name: 'Rack editor' })).toBeInTheDocument()
    expect(await screen.findByText('Plan not found')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to your racks' })).toHaveAttribute('href', '/')
  })

  it('shows the plan: editable name, sections top to bottom with Have/Need, save state', async () => {
    const plan = await storedSample()
    renderEditor(plan.id)
    const input = await nameInput()
    expect(input).toHaveValue('Sample: KWS 9U → 12U')
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus()
    expect(screen.getByText('KWS Rack v2 · 3U + 6U + 3U · 12U')).toBeInTheDocument()
    const rows = screen.getAllByTestId('section-row').map((row) => row.textContent)
    expect(rows).toEqual([
      '3U section U10–U12To get',
      '6U section U4–U9In my rack',
      '3U section U1–U3In my rack',
    ])
    expect(saveState()).toBe('Saved')
    expect(screen.getByText(/The full editor arrives in v0\.1 \(M3a\)/)).toBeInTheDocument()
    expect(screen.queryByText('Recording what you have')).toBeNull()
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
    expect(undo).toBeEnabled()
    fireEvent.click(undo)
    expect(input).toHaveValue('Sample: KWS 9U → 12U')
    expect(screen.getByText('Undone.')).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(input).toHaveValue('Garage rack')
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(input).toHaveValue('Sample: KWS 9U → 12U')
    await waitFor(() => expect(saveState()).toBe('Saved'), SAVED)
    expect((await getPlan(plan.id)).plan.name).toBe('Sample: KWS 9U → 12U')
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
    expect(screen.getByText('Planning: new things you add are marked To get.')).toBeInTheDocument()
  })

  it('opens a plan from a newer app version read-only', async () => {
    const plan = await storedSample()
    await getDb().plans.update(plan.id, { schema: 2, plan: { ...plan, schema: 2 } })
    renderEditor(plan.id)
    const input = await nameInput()
    expect(input).toHaveAttribute('readonly')
    expect(saveState()).toBe('Read-only')
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
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
