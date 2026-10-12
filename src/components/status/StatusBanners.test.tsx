import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { samplePlan } from '@/domain/__fixtures__/samplePlan'
import { getDbStatus, reportDbStatus, resetDbStatusForTests } from '@/state/dbStatus'
import { usePlanStore, type PlanStoreState } from '@/state/planStore'
import { StatusBanners } from './StatusBanners'

const initialPlanState = usePlanStore.getState()

function renderBanners() {
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <main>
          <StatusBanners />
        </main>
      ),
    },
    { path: '/plan/:planId', element: <main>Copy opened</main> },
  ])
  render(<RouterProvider router={router} />)
  return router
}

/** Puts an open plan (and replacement actions) into the app's plan store. */
function openPlan(data: Partial<PlanStoreState>): void {
  const plan = samplePlan()
  usePlanStore.setState({ planId: plan.id, plan, status: 'ready', rev: 2, ...data })
}

beforeEach(() => {
  resetDbStatusForTests()
})

afterEach(() => {
  cleanup()
  usePlanStore.setState(initialPlanState, true)
})

describe('StatusBanners', () => {
  it('renders nothing while all is well', () => {
    renderBanners()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('asks to reload when a newer version is open in another tab', () => {
    renderBanners()
    act(() => reportDbStatus({ type: 'version-change' }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('A newer version of the app is open in another tab')
    // An update to take, not a failure: the info tone.
    expect(alert).toHaveClass('bg-info-soft')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled()
  })

  it('offers Reload and Save as a copy for a conflict, and opens the copy', async () => {
    const reloadFromDb = vi.fn(async () => {})
    const saveAsCopy = vi.fn(async () => 'plan-copy')
    openPlan({ conflict: { theirRev: 3 }, saveState: 'error', reloadFromDb, saveAsCopy })
    const router = renderBanners()

    expect(screen.getByRole('alert')).toHaveTextContent('This plan changed in another tab')
    expect(screen.getByRole('alert')).toHaveTextContent('Your latest changes here are not saved')
    expect(screen.getByRole('alert')).toHaveClass('text-destructive')
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(reloadFromDb).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Save as a copy' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/plan/plan-copy'))
    expect(saveAsCopy).toHaveBeenCalledTimes(1)
  })

  it('says when the plan was deleted elsewhere', () => {
    openPlan({ conflict: { theirRev: null } })
    renderBanners()
    expect(screen.getByRole('alert')).toHaveTextContent('This plan was deleted in another tab')
    expect(screen.getByRole('link', { name: 'Back to plans' })).toHaveAttribute('href', '/')
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
  })

  it('explains a read-only plan politely', () => {
    openPlan({ readOnly: true })
    renderBanners()
    expect(screen.getByRole('status')).toHaveTextContent('opened read-only')
    expect(screen.getByRole('status')).toHaveClass('bg-warning-soft')
    expect(screen.getByRole('button', { name: 'Save an editable copy' })).toBeEnabled()
  })

  it('links a full disk to Settings > Storage and can be dismissed', () => {
    renderBanners()
    act(() => reportDbStatus({ type: 'storage-full' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Browser storage is full')
    expect(screen.getByRole('alert')).toHaveClass('bg-warning-soft')
    expect(screen.getByRole('link', { name: /Settings > Storage/ })).toHaveAttribute(
      'href',
      '/settings#storage',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Browser storage is full' }))
    expect(getDbStatus().storageFull).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement?.tagName).toBe('MAIN')
  })

  it('offers to retry a failed save', async () => {
    const flushSave = vi.fn(async () => true)
    openPlan({ saveState: 'error', flushSave })
    renderBanners()
    act(() => reportDbStatus({ type: 'write-error', message: 'The disk said no.' }))
    expect(screen.getByRole('alert')).toHaveTextContent('The disk said no.')
    expect(screen.getByRole('alert')).toHaveClass('text-destructive')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(getDbStatus().writeError).toBeNull())
    expect(flushSave).toHaveBeenCalledTimes(1)
  })
})
