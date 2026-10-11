import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as diagnostics from '@/lib/diagnostics'
import { DiagnosticsSection } from './DiagnosticsSection'

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
}

function setExecCommand(implementation: ((command: string) => boolean) | undefined): void {
  Object.defineProperty(document, 'execCommand', { value: implementation, configurable: true })
}

function renderSection(): HTMLElement {
  render(<DiagnosticsSection />)
  return screen.getByRole('region', { name: 'Diagnostics' })
}

beforeEach(async () => {
  await diagnostics.clear()
})

afterEach(async () => {
  cleanup()
  setClipboard(undefined)
  setExecCommand(undefined)
  await diagnostics.clear()
})

describe('DiagnosticsSection', () => {
  it('counts recorded problems as they happen', () => {
    const section = renderSection()
    expect(section).toHaveTextContent('No problems recorded.')
    expect(within(section).getByRole('button', { name: 'Clear' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    act(() => {
      diagnostics.record({ kind: 'error', message: 'Bom panel failed', source: 'boundary:bom' })
      diagnostics.record({ kind: 'warning', message: 'Slow save' })
    })
    expect(section).toHaveTextContent(/2 problems recorded, the latest on /)
  })

  it('copies the redacted report', async () => {
    diagnostics.record({ kind: 'error', message: 'Bom panel failed' })
    const writeText = vi.fn(async (_text: string) => {})
    setClipboard({ writeText })
    const section = renderSection()

    fireEvent.click(within(section).getByRole('button', { name: 'Copy diagnostics' }))
    expect(await within(section).findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    const report = writeText.mock.calls[0]?.[0] ?? ''
    expect(report).toContain('Mini Rack Planner diagnostics')
    expect(report).toContain('Bom panel failed')
    expect(report).toContain('no plan contents, names, notes or file names')
    expect(within(section).getAllByRole('status').at(-1)).toHaveTextContent(
      'Diagnostics copied to the clipboard.',
    )
  })

  it('shows the report selected in a dialog when copying is blocked', async () => {
    diagnostics.record({ kind: 'error', message: 'Bom panel failed' })
    const section = renderSection()
    const copy = within(section).getByRole('button', { name: 'Copy diagnostics' })
    copy.focus()
    fireEvent.click(copy)

    const dialog = await screen.findByRole('dialog', { name: 'Copy the diagnostics' })
    const text = within(dialog).getByRole('textbox', { name: 'Diagnostics report' })
    expect(text).toHaveAttribute('readonly')
    expect((text as HTMLTextAreaElement).value).toContain('Bom panel failed')
    await waitFor(() => expect(text).toHaveFocus())

    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[0] as HTMLElement)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('links "Report a problem" to a prefilled GitHub issue in a new tab', async () => {
    diagnostics.record({ kind: 'error', message: 'Bom panel failed' })
    const section = renderSection()
    const link = within(section).getByRole('link', { name: /Report a problem/ })
    expect(link).toHaveAccessibleName('Report a problem (opens GitHub in a new tab)')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    await waitFor(() => {
      const url = new URL(link.getAttribute('href') ?? '')
      expect(url.origin + url.pathname).toBe(diagnostics.ISSUE_NEW_URL)
      expect(url.searchParams.get('template')).toBe(diagnostics.ISSUE_TEMPLATE)
      expect(url.searchParams.get('diagnostics')).toContain('Bom panel failed')
    })
  })

  it('clears the recorded problems and keeps focus on the button', async () => {
    diagnostics.record({ kind: 'error', message: 'Bom panel failed' })
    const section = renderSection()
    const clear = within(section).getByRole('button', { name: 'Clear' })
    clear.focus()
    fireEvent.click(clear)
    await waitFor(() => expect(section).toHaveTextContent('No problems recorded.'))
    expect(diagnostics.getEntries()).toHaveLength(0)
    expect(clear).toHaveFocus()
    expect(clear).toHaveAttribute('aria-disabled', 'true')
    expect(within(section).getAllByRole('status').at(-1)).toHaveTextContent(
      'Recorded problems cleared.',
    )
  })
})
