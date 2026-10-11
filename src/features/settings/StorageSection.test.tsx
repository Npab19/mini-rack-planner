import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StorageSection } from './StorageSection'

function setStorage(storage: Partial<StorageManager> | undefined): void {
  Object.defineProperty(navigator, 'storage', { value: storage, configurable: true })
}

function renderSection(): HTMLElement {
  render(<StorageSection />)
  return screen.getByRole('region', { name: 'Storage' })
}

afterEach(() => {
  cleanup()
  setStorage(undefined)
  vi.unstubAllGlobals()
})

describe('StorageSection', () => {
  it('explains a plain-HTTP origin without navigator.storage instead of failing', async () => {
    setStorage(undefined)
    vi.stubGlobal('isSecureContext', false)
    const section = renderSection()

    expect(await within(section).findAllByText('Not available on this address.')).toHaveLength(2)
    expect(within(section).queryByRole('button', { name: 'Keep my data' })).toBeNull()
    expect(within(section).getByText(location.origin)).toBeInTheDocument()
    const note = within(section).getByRole('note')
    expect(note).toHaveTextContent('This address uses plain HTTP, so some features are limited')
    expect(note).toHaveTextContent('export a backup regularly')
    // Each address keeps its own data, and backups move it.
    expect(section).toHaveTextContent(/Each address keeps its own, separate data/)
    expect(within(section).getByRole('link', { name: 'Backup' })).toHaveAttribute('href', '#backup')
  })

  it('shows usage and asks the browser to keep the data', async () => {
    let persisted = false
    const persist = vi.fn(async () => {
      persisted = true
      return true
    })
    setStorage({
      persisted: async () => persisted,
      estimate: async () => ({ usage: 1_234_567, quota: 2_000_000_000 }),
      persist,
    })
    vi.stubGlobal('isSecureContext', true)
    const section = renderSection()

    expect(await within(section).findByText(/^Not yet\./)).toBeInTheDocument()
    expect(within(section).getByText(/1\.2 MB of 2 GB \(under 0\.1%\)/)).toBeInTheDocument()
    expect(within(section).queryByRole('note')).toBeNull()
    expect(section).toHaveTextContent('Firefox asks you')

    fireEvent.click(within(section).getByRole('button', { name: 'Keep my data' }))
    expect(await within(section).findByText(/^Yes\./)).toBeInTheDocument()
    expect(persist).toHaveBeenCalledTimes(1)
    expect(within(section).getByRole('status')).toHaveTextContent(
      'Done: this browser will keep your data.',
    )
    expect(within(section).queryByRole('button', { name: 'Keep my data' })).toBeNull()
    // The button went away: focus waits on the section heading, not on <body>.
    expect(within(section).getByRole('heading', { name: 'Storage' })).toHaveFocus()
  })

  it('says so when the browser refuses', async () => {
    setStorage({ persisted: async () => false, persist: async () => false })
    vi.stubGlobal('isSecureContext', true)
    const section = renderSection()

    fireEvent.click(await within(section).findByRole('button', { name: 'Keep my data' }))
    await waitFor(() =>
      expect(within(section).getByRole('status')).toHaveTextContent('The browser said no for now'),
    )
    expect(within(section).getByRole('button', { name: 'Keep my data' })).toBeEnabled()
    expect(within(section).getByText('Unknown.')).toBeInTheDocument()
  })
})
