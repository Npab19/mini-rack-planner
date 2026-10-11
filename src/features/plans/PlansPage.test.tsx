import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, useParams } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster } from '@/components/ui/sonner'
import { loadBundledCatalog } from '@/catalog/loader'
import { getDb, resetDbForTests } from '@/db/db'
import { createPlan, getPlan, listPlanSummaries } from '@/db/plansRepo'
import type { Plan } from '@/domain/schema/plan'
import { stopLibrarySync } from '@/state/catalogStore'
import { PlansPage } from './PlansPage'
import { buildSamplePlan } from './sample'

const NOW = new Date().toISOString()

function PlanRoute() {
  const { planId } = useParams()
  return <h1>Editor for {planId}</h1>
}

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/', element: <PlansPage /> },
      { path: '/plan/:planId', element: <PlanRoute /> },
      { path: '/import', element: <h1>Import page</h1> },
    ],
    { initialEntries: ['/'] },
  )
  render(
    <>
      <RouterProvider router={router} />
      <Toaster />
    </>,
  )
  return router
}

/** The KWS 9U -> 12U sample, stored. */
async function storeSample(name?: string): Promise<Plan> {
  const { plan } = buildSamplePlan(loadBundledCatalog().lookup, NOW)
  return createPlan(name === undefined ? plan : { ...plan, name })
}

async function card(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 3, name })
  const article = heading.closest('article')
  if (article === null) throw new Error(`no card for ${name}`)
  return article
}

async function openMenu(name: string): Promise<HTMLElement> {
  const trigger = within(await card(name)).getByRole('button', { name: `Actions for ${name}` })
  await act(async () => {
    fireEvent.click(trigger)
  })
  return screen.findByRole('menu')
}

async function chooseMenuItem(planName: string, item: RegExp | string): Promise<void> {
  const menu = await openMenu(planName)
  await act(async () => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: item }))
  })
}

beforeEach(async () => {
  await resetDbForTests()
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
  stopLibrarySync()
  vi.restoreAllMocks()
})

describe('PlansPage without plans', () => {
  it('offers the three ways to start and an import link', async () => {
    renderPage()
    expect(screen.getByRole('heading', { level: 1, name: 'Your racks' })).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Start your first plan' }),
    ).toBeInTheDocument()
    for (const name of [
      'Record my rack and plan an upgrade',
      'Plan a new rack',
      'Open the sample',
    ]) {
      expect(screen.getByRole('button', { name })).toBeEnabled()
    }
    expect(screen.getByRole('link', { name: 'Import a backup' })).toHaveAttribute('href', '/import')
    expect(screen.queryByRole('button', { name: 'New plan' })).toBeNull()
  })

  it('opens the wizard in Recording mode from its start card', async () => {
    renderPage()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Record my rack and plan an upgrade' }),
    )
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Record my rack' })).toBeInTheDocument()
    expect(
      within(dialog).getByRole('heading', { name: 'Which frame is your rack?' }),
    ).toBeInTheDocument()
  })

  it('creates the sample and opens it', async () => {
    const router = renderPage()
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Open the sample' }))
    })
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/plan\/plan-/))
    const plans = await listPlanSummaries()
    expect(plans.map((plan) => plan.name)).toEqual(['Sample: KWS 9U → 12U'])
    expect(router.state.location.pathname).toBe(`/plan/${plans[0]?.id ?? ''}`)
  })
})

describe('PlansPage with plans', () => {
  it('shows a card per plan with its frame, sections, Have/Need and age', async () => {
    await storeSample('Home rack')
    renderPage()
    const home = await card('Home rack')
    expect(within(home).getByRole('link', { name: 'Home rack' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/plan\/plan-/),
    )
    expect(await within(home).findByText('3U + 6U + 3U · 12U')).toBeInTheDocument()
    expect(within(home).getByText('KWS Rack v2')).toBeInTheDocument()
    // 2 sections + 3 mounts + 1 PC owned; 1 section + 1 drive rack + 2 drives to get.
    expect(within(home).getByText('6 in my rack')).toBeInTheDocument()
    expect(within(home).getByText('4 to get')).toBeInTheDocument()
    expect(within(home).getByText('just now')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New plan' })).toBeEnabled()
    expect(screen.getByRole('link', { name: 'Import' })).toHaveAttribute('href', '/import')
  })

  it('marks plans from a newer app version read-only and cannot rename them', async () => {
    const plan = await storeSample('From the future')
    await getDb().plans.update(plan.id, { schema: 2, plan: { ...plan, schema: 2 } })
    renderPage()
    const future = await card('From the future')
    expect(within(future).getByText('Read-only')).toBeInTheDocument()
    const menu = await openMenu('From the future')
    expect(within(menu).getByRole('menuitem', { name: 'Rename…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('renames a plan from its menu', async () => {
    const plan = await storeSample('Old name')
    renderPage()
    await chooseMenuItem('Old name', 'Rename…')
    const dialog = await screen.findByRole('dialog', { name: 'Rename “Old name”' })
    const input = within(dialog).getByLabelText('Plan name')
    fireEvent.change(input, { target: { value: '   ' } })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }))
    })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Give the plan a name.')
    fireEvent.change(input, { target: { value: 'New name' } })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }))
    })
    expect(await card('New name')).toBeInTheDocument()
    const stored = await getPlan(plan.id)
    expect(stored.plan.name).toBe('New name')
    expect(stored.rev).toBe(2)
  })

  it('duplicates as a new idea (same rack, Have kept) or from scratch', async () => {
    const plan = await storeSample('Rack A')
    renderPage()
    await chooseMenuItem('Rack A', /Duplicate as new idea/)
    expect(await card('Rack A (copy)')).toBeInTheDocument()
    await chooseMenuItem('Rack A', /Duplicate from scratch/)
    await waitFor(async () => expect(await listPlanSummaries()).toHaveLength(3))

    const copies = (await listPlanSummaries()).filter((summary) => summary.id !== plan.id)
    const loaded = await Promise.all(
      copies.map(async (summary) => (await getPlan(summary.id)).plan),
    )
    const idea = loaded.find((copy) => copy.rackId === plan.rackId)
    const scratch = loaded.find((copy) => copy.rackId !== plan.rackId)
    expect(idea?.frame.sections.map((section) => section.have !== undefined)).toEqual([
      true,
      true,
      false,
    ])
    expect(scratch?.frame.sections.every((section) => section.have === undefined)).toBe(true)
    expect(scratch?.placements.every((placement) => placement.have === undefined)).toBe(true)
  })

  it('deletes a plan after a confirmation that names it', async () => {
    await storeSample('Keep me')
    await storeSample('Delete me')
    renderPage()
    await chooseMenuItem('Delete me', 'Delete…')
    const dialog = await screen.findByRole('dialog', { name: 'Delete “Delete me”?' })
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus(),
    )
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete plan' }))
    })
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 3, name: 'Delete me' })).toBeNull(),
    )
    expect((await listPlanSummaries()).map((summary) => summary.name)).toEqual(['Keep me'])
    expect(await screen.findByText('Deleted “Delete me”.')).toBeInTheDocument()
  })

  it('exports one plan as a backup file named after it', async () => {
    const plan = await storeSample('KWS 9U → 12U')
    const blobs: Blob[] = []
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: (blob: Blob) => {
        blobs.push(blob)
        return 'blob:http://localhost/export'
      },
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: () => undefined,
    })
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download)
    })
    renderPage()
    await chooseMenuItem('KWS 9U → 12U', 'Export as file')
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(downloads[0]).toMatch(/^kws-9u-12u-\d{4}-\d{2}-\d{2}\.rackplan\.json$/)
    const file: unknown = JSON.parse(await (blobs[0] as Blob).text())
    expect(file).toMatchObject({ format: 'mini-rack-planner-backup', version: 1 })
    expect((file as { plans: Array<{ id: string }> }).plans.map((entry) => entry.id)).toEqual([
      plan.id,
    ])
  })

  it('keeps the three ways to start behind New plan', async () => {
    await storeSample()
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'New plan' }))
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByRole('heading', { name: 'How do you want to start?' }),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Plan a new rack' })).toBeInTheDocument()
  })
})
