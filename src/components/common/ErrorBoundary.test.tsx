import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as diagnostics from '@/lib/diagnostics'
import { ErrorBoundary, PanelErrorBoundary } from './ErrorBoundary'

const update = vi.hoisted(() => ({
  pending: false,
  notifyNewVersion: vi.fn(),
  reloadApp: vi.fn(() => Promise.resolve()),
}))

vi.mock(import('@/app/updatePrompt'), async (importOriginal) => ({
  ...(await importOriginal()),
  isUpdatePending: () => update.pending,
  notifyNewVersion: update.notifyNewVersion,
  reloadApp: update.reloadApp,
}))

function Bomb({ explode, error }: { explode: boolean; error?: unknown }) {
  if (explode) throw error ?? new Error('boom')
  return <p>All good</p>
}

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
}

/** The report is built asynchronously; on a busy machine that can take a while. */
const ASYNC = { timeout: 5000 }

beforeAll(() => {
  // Skips loading the plan schema on demand (covered in collect.test.ts): keeps these tests quick.
  diagnostics.setReportContext({ planSchema: 1 })
})

beforeEach(async () => {
  // React logs every caught render error; the assertions below cover them.
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await diagnostics.clear()
  update.pending = false
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  update.notifyNewVersion.mockClear()
  update.reloadApp.mockClear()
  setClipboard(undefined)
})

describe('ErrorBoundary', () => {
  it('renders its children while nothing throws', () => {
    render(
      <ErrorBoundary name="test">
        <Bomb explode={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('All good')).toBeInTheDocument()
  })

  it('shows the error card, records the error with its component stack and takes focus', () => {
    render(
      <ErrorBoundary name="bom">
        <Bomb explode />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('This panel hit an error')
    expect(screen.getByRole('heading', { name: 'This panel hit an error' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy diagnostics' })).toBeInTheDocument()

    const entry = diagnostics.getEntries().at(-1)
    expect(entry).toMatchObject({ kind: 'error', message: 'Error: boom', source: 'boundary:bom' })
    expect(entry?.stack).toContain('Component stack:')
    expect(entry?.stack).toContain('Bomb')
    expect(update.notifyNewVersion).not.toHaveBeenCalled()
  })

  it('leaves focus alone when the user is working elsewhere', () => {
    const { rerender } = render(
      <>
        <input aria-label="Elsewhere" />
        <ErrorBoundary name="side">
          <Bomb explode={false} />
        </ErrorBoundary>
      </>,
    )
    screen.getByRole('textbox', { name: 'Elsewhere' }).focus()
    rerender(
      <>
        <input aria-label="Elsewhere" />
        <ErrorBoundary name="side">
          <Bomb explode />
        </ErrorBoundary>
      </>,
    )
    expect(screen.getByRole('textbox', { name: 'Elsewhere' })).toHaveFocus()
  })

  it('Try again runs onReset and renders the children again', () => {
    const onReset = vi.fn()
    const { rerender } = render(
      <ErrorBoundary name="test" onReset={onReset}>
        <Bomb explode />
      </ErrorBoundary>,
    )
    rerender(
      <ErrorBoundary name="test" onReset={onReset}>
        <Bomb explode={false} />
      </ErrorBoundary>,
    )
    expect(screen.queryByText('All good')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(screen.getByText('All good')).toBeInTheDocument()
  })

  it('resets itself when a reset key changes', () => {
    const { rerender } = render(
      <ErrorBoundary name="route" resetKeys={['/plan/a']}>
        <Bomb explode />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    rerender(
      <ErrorBoundary name="route" resetKeys={['/about']}>
        <Bomb explode={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('All good')).toBeInTheDocument()
  })

  it('Reload saves pending work and reloads by default, or calls onReload', () => {
    const { unmount } = render(
      <ErrorBoundary name="test">
        <Bomb explode />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(update.reloadApp).toHaveBeenCalledTimes(1)
    unmount()

    const onReload = vi.fn()
    render(
      <ErrorBoundary name="test" onReload={onReload}>
        <Bomb explode />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(update.reloadApp).toHaveBeenCalledTimes(1)
  })

  it('treats a missing chunk as a new version: Reload only, and the update prompt', () => {
    const stale = new TypeError('Failed to fetch dynamically imported module: /assets/Bom-x.js')
    render(
      <ErrorBoundary name="bom">
        <Bomb explode error={stale} />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('A new version is available')
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(update.notifyNewVersion).toHaveBeenCalledWith({ source: 'boundary:bom', error: stale })
  })

  it('shows the update message for any crash once an update is pending', () => {
    update.pending = true
    render(
      <ErrorBoundary name="viewer">
        <Bomb explode error={new TypeError('Element type is invalid')} />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('A new version is available')
  })

  it('renders a custom fallback with the error and a reset callback', () => {
    render(
      <ErrorBoundary
        name="custom"
        fallback={({ error, reset }) => (
          <button type="button" onClick={reset}>
            {error instanceof Error ? error.message : 'unknown'}
          </button>
        )}
      >
        <Bomb explode />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('button', { name: 'boom' })).toBeInTheDocument()
  })

  it('PanelErrorBoundary shows the compact card inside the panel', () => {
    render(
      <PanelErrorBoundary name="inspector">
        <Bomb explode />
      </PanelErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('This panel hit an error')
    expect(diagnostics.getEntries().at(-1)?.source).toBe('boundary:inspector')
  })
})

describe('Copy diagnostics', () => {
  it('copies the redacted report and announces it', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve())
    setClipboard({ writeText })
    render(
      <ErrorBoundary name="plans">
        <Bomb explode error={new Error('Cannot rename "Garage rack"')} />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))

    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument(),
      ASYNC,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Diagnostics copied to the clipboard.')
    const report = writeText.mock.calls[0]?.[0] ?? ''
    expect(report).toContain('Mini Rack Planner diagnostics')
    expect(report).toContain('Error: Cannot rename "…"')
    expect(report).toContain('source: boundary:plans')
    expect(report).not.toContain('Garage')
  })

  it('shows the report for copying by hand when the clipboard is unavailable', async () => {
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true })
    render(
      <ErrorBoundary name="plans">
        <Bomb explode />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))

    const textbox = await screen.findByRole(
      'textbox',
      { name: /Select the text and copy it/ },
      ASYNC,
    )
    expect((textbox as HTMLTextAreaElement).value).toContain('Mini Rack Planner diagnostics')
    // Focus moves in an effect after the text box renders: under load that can be a moment later.
    await waitFor(() => expect(textbox).toHaveFocus(), ASYNC)
    expect(screen.getByRole('status')).toHaveTextContent(/Copying is not available here/)
    Object.defineProperty(document, 'execCommand', { value: undefined, configurable: true })
  })
})
