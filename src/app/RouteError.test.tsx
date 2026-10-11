import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, data, Outlet, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as diagnostics from '@/lib/diagnostics'
import { RouteError } from './RouteError'

const update = vi.hoisted(() => ({
  pending: false,
  notifyNewVersion: vi.fn(),
  reloadApp: vi.fn(() => Promise.resolve()),
}))

vi.mock(import('./updatePrompt'), async (importOriginal) => ({
  ...(await importOriginal()),
  isUpdatePending: () => update.pending,
  notifyNewVersion: update.notifyNewVersion,
  reloadApp: update.reloadApp,
}))

const STALE = new TypeError(
  'Failed to fetch dynamically imported module: /assets/LibraryPage-x1.js',
)

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: Outlet,
        ErrorBoundary: RouteError,
        HydrateFallback: () => null,
        children: [
          { path: 'stale', lazy: () => Promise.reject(STALE) },
          {
            path: 'crash',
            Component: () => {
              throw new Error('Cannot read properties of undefined')
            },
          },
          {
            // What a prevented vite:preloadError leaves: the import resolved to undefined.
            path: 'undefined-module',
            lazy: async () => {
              const module = (await Promise.resolve(undefined)) as unknown as { Page: () => null }
              return { Component: module.Page }
            },
          },
          {
            path: 'missing',
            loader: () => {
              throw data('Not here', { status: 404, statusText: 'Not Found' })
            },
            Component: () => null,
          },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
}

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  await diagnostics.clear()
  update.pending = false
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  update.notifyNewVersion.mockClear()
  update.reloadApp.mockClear()
})

describe('RouteError', () => {
  it('offers the new version when a lazy route chunk is gone', async () => {
    renderAt('/stale')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'A new version is available' }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(update.notifyNewVersion).toHaveBeenCalledWith({ source: 'route', error: STALE }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(update.reloadApp).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Copy diagnostics' })).toBeInTheDocument()
  })

  it('treats any route error as the stale build once an update is pending', async () => {
    update.pending = true
    renderAt('/undefined-module')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'A new version is available' }),
    ).toBeInTheDocument()
    await waitFor(() => expect(update.notifyNewVersion).toHaveBeenCalled())
  })

  it('shows other errors and records them', async () => {
    renderAt('/crash')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Something went wrong' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Cannot read properties of undefined')).toBeInTheDocument()
    expect(update.notifyNewVersion).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(diagnostics.getEntries().at(-1)).toMatchObject({
        kind: 'error',
        message: 'Error: Cannot read properties of undefined',
        source: 'route',
      }),
    )
  })

  it('shows error responses by status and records them as warnings', async () => {
    renderAt('/missing')
    expect(
      await screen.findByRole('heading', { level: 1, name: '404 Not Found' }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(diagnostics.getEntries().at(-1)).toMatchObject({
        kind: 'warning',
        message: 'Route error response 404 Not Found',
        source: 'route',
      }),
    )
  })
})
