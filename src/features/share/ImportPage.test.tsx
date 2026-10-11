import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BACKUP_FORMAT } from '@/db/backup'
import { resetDbForTests } from '@/db/db'
import { createPlan, getPlan, listPlanSummaries } from '@/db/plansRepo'
import { samplePlan } from '@/domain/__fixtures__/samplePlan'
import { ImportPage } from './ImportPage'

function renderImport(path = '/import') {
  const router = createMemoryRouter(
    [
      { path: '/import', element: <ImportPage /> },
      { path: '/plan/:planId', element: <h1>Editor</h1> },
      { path: '/', element: <h1>Your racks</h1> },
    ],
    { initialEntries: [path] },
  )
  const view = render(<RouterProvider router={router} />)
  return { router, container: view.container }
}

function backupText(plans: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: 1,
    app: { version: '0.1.0', sha: 'abc' },
    exportedAt: '2026-10-11T10:00:00.000Z',
    plans,
    library: [],
    ...extra,
  })
}

async function pick(container: HTMLElement, name: string, text: string): Promise<void> {
  const input = container.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('no file input')
  const file = new File([text], name, { type: 'application/json' })
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } })
  })
}

beforeEach(async () => {
  await resetDbForTests()
})

afterEach(() => {
  cleanup()
})

describe('ImportPage', () => {
  it('previews a backup, merges it and links to the imported plan', async () => {
    const { container } = renderImport()
    expect(screen.getByRole('heading', { level: 1, name: 'Import' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose a file…' })).toBeEnabled()

    await pick(container, 'backup.json', backupText([samplePlan()]))
    const heading = await screen.findByRole('heading', { name: 'In backup.json' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(
      screen.getByText(/1 plan, 0 custom parts, no settings, no inventory/),
    ).toBeInTheDocument()
    const plans = screen.getByRole('list', { name: 'Plans in the file' })
    expect(within(plans).getByText('KWS 9U → 12U')).toBeInTheDocument()
    expect(within(plans).getByText('New')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Merge (recommended)' })).toHaveAttribute(
      'aria-checked',
      'true',
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    })
    const result = await screen.findByRole('heading', { name: 'Imported backup.json' })
    await waitFor(() => expect(result).toHaveFocus())
    expect(screen.getByText('Plans: 1 added, 0 updated.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'KWS 9U → 12U' })).toHaveAttribute(
      'href',
      '/plan/plan-kws-sample',
    )
    expect((await getPlan('plan-kws-sample')).plan.name).toBe('KWS 9U → 12U')
  })

  it('imports copies with fresh ids and nothing owned', async () => {
    await createPlan(samplePlan())
    const { container } = renderImport()
    await pick(container, 'plan.rackplan.json', backupText([samplePlan()]))
    expect(await screen.findByText('Already in this browser')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Copy' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Import as copies' }))
    })
    expect(await screen.findByText('1 plan added as new plans.')).toBeInTheDocument()
    const summaries = await listPlanSummaries()
    expect(summaries).toHaveLength(2)
    const copy = summaries.find((summary) => summary.id !== 'plan-kws-sample')
    expect(copy?.name).toBe('KWS 9U → 12U (copy)')
    expect(copy?.haveSectionCount).toBe(0)
  })

  it('replaces everything only after REPLACE is typed', async () => {
    await createPlan({ ...samplePlan(), id: 'plan-local', name: 'Only here' })
    const { container } = renderImport()
    await pick(container, 'backup.json', backupText([samplePlan()]))
    await screen.findByRole('heading', { name: 'In backup.json' })
    fireEvent.click(screen.getByRole('radio', { name: 'Replace everything' }))
    const replace = screen.getByRole('button', { name: 'Replace everything' })
    await act(async () => {
      fireEvent.click(replace)
    })
    const confirm = screen.getByLabelText('Type REPLACE to confirm')
    expect(confirm).toHaveFocus()
    expect(confirm).toHaveAttribute('aria-invalid', 'true')
    expect((await listPlanSummaries()).map((summary) => summary.id)).toEqual(['plan-local'])

    fireEvent.change(confirm, { target: { value: 'REPLACE' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Replace everything' }))
    })
    expect(
      await screen.findByText('1 plan that only this browser had were removed.'),
    ).toBeInTheDocument()
    expect((await listPlanSummaries()).map((summary) => summary.id)).toEqual(['plan-kws-sample'])
  })

  it('offers no Replace for a file with unreadable entries', async () => {
    const { container } = renderImport()
    const broken = { ...samplePlan(), id: 'plan-broken', name: 'Broken', frame: 'nope' }
    await pick(container, 'mixed.json', backupText([samplePlan(), broken]))
    expect(await screen.findByText('Some of the file will be left out')).toBeInTheDocument()
    expect(screen.getByText('Cannot be imported')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Replace everything' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('explains files it cannot read', async () => {
    const { container } = renderImport()
    await pick(container, 'notes.json', 'this is not json')
    expect(await screen.findByText('notes.json cannot be imported')).toBeInTheDocument()
    expect(screen.getByText(/not valid JSON/)).toBeInTheDocument()
    await pick(container, 'other.json', JSON.stringify({ format: 'other-app' }))
    expect(await screen.findByText('other.json cannot be imported')).toBeInTheDocument()
    expect(screen.getByText(/"other-app" file/)).toBeInTheDocument()
  })

  it('points share links to the viewer that is coming', () => {
    renderImport('/import#p=1.abc')
    expect(screen.getByRole('status')).toHaveTextContent('Share links open in the read-only viewer')
  })
})
