import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportDbStatus, resetDbStatusForTests } from '@/state/dbStatus'
import { AppLayout } from './AppLayout'

function Crash(): never {
  throw new Error('page crashed')
}

function renderApp(path = '/') {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: AppLayout,
        children: [
          { index: true, Component: () => <h1>Your racks</h1> },
          { path: 'library', Component: () => <h1>My parts</h1> },
          { path: 'settings', Component: () => <h1>Settings</h1> },
          { path: 'about', Component: () => <h1>About</h1> },
          { path: 'broken', Component: Crash },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

beforeEach(() => {
  // The toaster follows the colour scheme; jsdom has no matchMedia.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AppLayout', () => {
  it('has the title, the inline nav (sm and up), the theme toggle and the menu button', async () => {
    renderApp()
    expect(await screen.findByRole('heading', { level: 1, name: 'Your racks' })).toBeInTheDocument()
    const header = screen.getByRole('banner')
    expect(within(header).getByRole('link', { name: 'Mini Rack Planner' })).toHaveAttribute(
      'href',
      '/',
    )
    const nav = within(header).getByRole('navigation', { name: 'Main' })
    expect(nav).toHaveClass('hidden', 'sm:flex')
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Plans', 'My parts', 'Settings', 'About'])
    expect(within(nav).getByRole('link', { name: 'Plans' })).toHaveAttribute('aria-current', 'page')
    expect(within(header).getByRole('button', { name: /^Theme: / })).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: 'Menu' })).toHaveClass('sm:hidden')
  })

  it('puts the status slot first in main, right under the header', async () => {
    renderApp()
    await screen.findByRole('heading', { name: 'Your racks' })
    const main = screen.getByRole('main')
    expect(main.firstElementChild).toHaveAttribute('id', 'app-status-slot')
    expect(screen.getByRole('banner').nextElementSibling).toBe(main)
  })

  it('shows the app-wide status banners in the status slot, above every page', async () => {
    renderApp('/about')
    await screen.findByRole('heading', { level: 1, name: 'About' })
    act(() => reportDbStatus({ type: 'storage-full' }))
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('Browser storage is full')
    expect(document.getElementById('app-status-slot')).toContainElement(banner)
    act(() => resetDbStatusForTests())
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('keeps the header when a page crashes, and clears the error on navigation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderApp('/broken')
    expect(await screen.findByRole('alert')).toHaveTextContent('This page hit an error')
    const nav = within(screen.getByRole('banner')).getByRole('navigation', { name: 'Main' })
    fireEvent.click(within(nav).getByRole('link', { name: 'About' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'About' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('opens the menu as a dialog on small screens and closes it after navigating', async () => {
    const router = renderApp()
    await screen.findByRole('heading', { name: 'Your racks' })
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    const dialog = await screen.findByRole('dialog', { name: 'Menu' })
    const links = within(within(dialog).getByRole('navigation', { name: 'Main' })).getAllByRole(
      'link',
    )
    expect(links.map((link) => link.textContent)).toEqual([
      'Plans',
      'My parts',
      'Settings',
      'About',
    ])

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('link', { name: 'Settings' }))
    })
    expect(router.state.location.pathname).toBe('/settings')
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
