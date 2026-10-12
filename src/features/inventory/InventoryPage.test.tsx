import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster } from '@/components/ui/sonner'
import { resetDbForTests } from '@/db/db'
import { getInventory, setQty } from '@/db/inventoryRepo'
import { createPlan } from '@/db/plansRepo'
import { updateSettings } from '@/db/settingsRepo'
import { deviceKey, hardwareKey } from '@/domain/ids'
import { KWS_IDS, kwsPlan } from '@/domain/__fixtures__/kws'
import { InventoryPage } from './InventoryPage'

// The fixture catalog stands in for the bundled one (no pack sizes: buy = need), plus one
// hardware part of the user's own.
vi.mock(import('@/state/catalogStore'), async (importOriginal) => {
  const actual = await importOriginal()
  const { kwsCatalog, parseEntries } = await import('@/domain/__fixtures__/kws')
  const lookup = kwsCatalog(
    parseEntries([
      {
        kind: 'hardware',
        id: 'custom:m3-standoff',
        name: 'M3×10 brass standoff',
        category: 'standoff',
        packSizes: [20],
      },
    ]),
  )
  return { ...actual, useCatalog: () => ({ lookup, revision: 0, problems: [] }) }
})

const SLOW = { timeout: 4000 }
const INSERTS = hardwareKey(KWS_IDS.inserts)
const NYLOC = hardwareKey(KWS_IDS.nyloc)
const M6X8 = hardwareKey(KWS_IDS.m6x8)
const INSERT_NAME = 'M5 heat-set insert (M5x8x7)'

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/inventory', element: <InventoryPage /> },
      { path: '/plan/:planId', element: <h1>Plan page</h1> },
    ],
    { initialEntries: ['/inventory'] },
  )
  render(
    <>
      <RouterProvider router={router} />
      <Toaster />
    </>,
  )
  return router
}

/** The page once the stored counts have arrived (the filter switch is enabled then). */
async function loaded(): Promise<void> {
  await waitFor(
    () =>
      expect(screen.getByRole('switch', { name: 'Only what I have' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    SLOW,
  )
}

function row(key: string): HTMLElement {
  return screen.getByTestId(`on-hand-row-${key}`)
}

function field(name: string): HTMLInputElement {
  const input = screen.getByRole('textbox', { name: `On hand: ${name}` })
  if (!(input instanceof HTMLInputElement)) throw new Error(`${name} has no field`)
  return input
}

function type(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

function shownKeys(): string[] {
  return screen
    .queryAllByTestId(/^on-hand-row-hw:/)
    .map((element) => element.dataset.testid?.slice('on-hand-row-'.length) ?? '')
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
  vi.restoreAllMocks()
})

describe('InventoryPage', () => {
  it('starts empty: every hardware part by category, and how to begin', async () => {
    renderPage()
    expect(screen.getByRole('heading', { level: 1, name: 'Hardware on hand' })).toBeInTheDocument()
    await loaded()
    expect(screen.getByRole('switch', { name: 'Only what I have' })).not.toBeChecked()
    expect(screen.getByRole('region', { name: 'Count what you already have' })).toHaveTextContent(
      /tick Got it on a plan’s shopping list/,
    )
    expect(screen.getByTestId('on-hand-totals')).toHaveTextContent('No hardware on hand yet')
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual([
      'Count what you already have',
      'Screws (5)',
      'Nuts (2)',
      'Heat-set inserts (1)',
      'Cage nuts (1)',
      'Magnets (1)',
      'Feet (1)',
      'Standoffs (1)',
    ])
    expect(within(row('hw:custom:m3-standoff')).getByText('My part')).toBeInTheDocument()
    expect(within(row('hw:custom:m3-standoff')).getByText('Packs of 20')).toBeInTheDocument()
    expect(field(INSERT_NAME)).toHaveValue('0')
  })

  it('saves a typed count and the − / + steps, and says so', async () => {
    renderPage()
    await loaded()
    type(field(INSERT_NAME), '20')
    await waitFor(async () => expect(await getInventory()).toEqual({ [INSERTS]: 20 }), SLOW)
    const status = screen.getByTestId('on-hand-status')
    await waitFor(() => expect(status).toHaveTextContent(`Saved: ${INSERT_NAME}, 20 pcs on hand.`))
    await waitFor(() =>
      expect(screen.getByTestId('on-hand-totals')).toHaveTextContent('1 kind, 20 pieces'),
    )
    await waitFor(() => expect(row(INSERTS)).toHaveAttribute('data-qty', '20'))

    fireEvent.click(screen.getByRole('button', { name: `Add 1: ${INSERT_NAME}` }))
    await waitFor(async () => expect(await getInventory()).toEqual({ [INSERTS]: 21 }), SLOW)
    await waitFor(() => expect(field(INSERT_NAME)).toHaveValue('21'))
    await waitFor(() => expect(status).toHaveTextContent(`${INSERT_NAME}, 21 pcs on hand`))

    const minus = screen.getByRole('button', { name: `Take away 1: ${INSERT_NAME}` })
    fireEvent.click(minus)
    await waitFor(async () => expect(await getInventory()).toEqual({ [INSERTS]: 20 }), SLOW)

    // A typo is not saved; it explains itself instead.
    type(field(INSERT_NAME), '2.5')
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a whole number, like 20.')
    expect(await getInventory()).toEqual({ [INSERTS]: 20 })
    // An empty field is none: the part leaves what is on hand.
    type(field(INSERT_NAME), '')
    await waitFor(async () => expect(await getInventory()).toEqual({}), SLOW)
    // The minus button stays focusable at 0, but does nothing.
    await waitFor(() => expect(minus).toHaveAttribute('aria-disabled', 'true'))
  })

  it('shows only what you have when something is on hand, and searches', async () => {
    await setQty(INSERTS, 20)
    await setQty(NYLOC, 8)
    renderPage()
    await loaded()
    const only = screen.getByRole('switch', { name: 'Only what I have' })
    expect(only).toBeChecked()
    expect(shownKeys()).toEqual([NYLOC, INSERTS])
    expect(screen.queryByRole('region', { name: 'Count what you already have' })).toBeNull()
    expect(screen.getByTestId('on-hand-totals')).toHaveTextContent('2 kinds, 28 pieces')
    expect(screen.getByText('Showing 2 of 12 parts')).toBeInTheDocument()

    // A row set to 0 stays until the filter changes, so it never jumps away.
    type(field('M6 nyloc nut'), '0')
    await waitFor(async () => expect(await getInventory()).toEqual({ [INSERTS]: 20 }), SLOW)
    expect(shownKeys()).toEqual([NYLOC, INSERTS])

    fireEvent.click(only)
    await waitFor(() => expect(shownKeys()).toHaveLength(12))
    fireEvent.click(only)
    await waitFor(() => expect(shownKeys()).toEqual([INSERTS]))

    const search = screen.getByRole('searchbox', { name: 'Search hardware' })
    fireEvent.change(search, { target: { value: 'magnet' } })
    expect(await screen.findByText('No hardware on hand matches “magnet”.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show all hardware' }))
    await waitFor(() => expect(shownKeys()).toEqual([hardwareKey(KWS_IDS.magnets)]))
    expect(screen.getByText('Showing 1 of 12 parts')).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'm6 screw' } })
    await waitFor(() => expect(shownKeys()).toEqual([M6X8, hardwareKey(KWS_IDS.m6x10)]))
  })

  it('shows what saved plans need and buy after what is on hand, and links to them', async () => {
    await updateSettings({ sparePct: { default: 0 } })
    const plan = await createPlan(
      kwsPlan({ sections: [{ u: 3, have: true }, { u: 6, have: true }, 3] }),
    )
    await setQty(INSERTS, 20)
    const router = renderPage()
    await loaded()
    const plans = await screen.findByRole('list', { name: `Plans that use ${INSERT_NAME}` }, SLOW)
    // 36 to install, 20 on hand: 16 to buy (no packs in the fixture).
    await waitFor(() => expect(plans).toHaveTextContent('KWS fixture plan needs 36, buy 16'))

    type(field(INSERT_NAME), '40')
    await waitFor(() => expect(plans).toHaveTextContent('KWS fixture plan needs 36, covered'), SLOW)

    await act(async () => {
      fireEvent.click(within(plans).getByRole('link', { name: 'KWS fixture plan' }))
    })
    expect(router.state.location.pathname).toBe(`/plan/${plan.id}`)
  })

  it('lists printed parts and equipment on hand, and removes them with an undo', async () => {
    const pi = deviceKey('rpi-5')
    await setQty(pi, 2)
    renderPage()
    await loaded()
    const other = await screen.findByRole('region', { name: /^Printed parts and equipment/ })
    expect(within(other).getByText('Raspberry Pi 5')).toBeInTheDocument()
    expect(within(other).getByText('Equipment')).toBeInTheDocument()
    expect(within(other).getByRole('textbox', { name: 'On hand: Raspberry Pi 5' })).toHaveValue('2')

    fireEvent.click(
      within(other).getByRole('button', { name: 'Remove from on hand: Raspberry Pi 5' }),
    )
    await waitFor(async () => expect(await getInventory()).toEqual({}), SLOW)
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /^Printed parts and equipment/ })).toBeNull(),
    )
    const toast = await screen.findByText('Removed Raspberry Pi 5 from on hand.')
    const undo = within(toast.closest('li') ?? document.body).getByRole('button', { name: 'Undo' })
    fireEvent.click(undo)
    await waitFor(async () => expect(await getInventory()).toEqual({ [pi]: 2 }), SLOW)
  })
})
