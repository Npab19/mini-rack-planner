import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster } from '@/components/ui/sonner'
import { resetDbForTests } from '@/db/db'
import { getInventory, setQty } from '@/db/inventoryRepo'
import { createPlan, getPlan, listPlanSummaries } from '@/db/plansRepo'
import { updateSettings } from '@/db/settingsRepo'
import type { FinishBuildResult } from '@/domain/build'
import { markSection } from '@/domain/frame'
import { hardwareKey, printKey } from '@/domain/ids'
import type { CatalogLookup, Frame } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import { FIXTURE_NOW, KWS_FRAME, KWS_FRAME_ID, KWS_IDS, kwsPlan } from '@/domain/__fixtures__/kws'
import { usePlanStore } from '@/state/planStore'
import { clearAnnouncement, useEditorAnnouncer } from '../layout/announcer'
import { BomPanel } from './BomPanel'

// The fixture catalog stands in for the bundled one (no pack sizes: buy = need).
vi.mock(import('@/state/catalogStore'), async (importOriginal) => {
  const actual = await importOriginal()
  const { kwsCatalog } = await import('@/domain/__fixtures__/kws')
  const lookup = kwsCatalog()
  return { ...actual, useCatalog: () => ({ lookup, revision: 0, problems: [] }) }
})

// The real finishBuild, watched.
const finishBuild = vi.hoisted(() =>
  vi.fn<(plan: Plan, frame: Frame, at: string, catalog?: CatalogLookup) => FinishBuildResult>(),
)
vi.mock(import('@/domain/build'), async (importOriginal) => {
  const actual = await importOriginal()
  finishBuild.mockImplementation(actual.finishBuild)
  return { ...actual, finishBuild }
})

const KEYS = {
  plate3: printKey(KWS_FRAME_ID, 'plate-3u'),
  connectors: printKey(KWS_FRAME_ID, 'frame-connectors'),
  inserts: hardwareKey(KWS_IDS.inserts),
  m6x8: hardwareKey(KWS_IDS.m6x8),
  m6x10: hardwareKey(KWS_IDS.m6x10),
  nyloc: hardwareKey(KWS_IDS.nyloc),
  magnets: hardwareKey(KWS_IDS.magnets),
}

/** The signed-off +3U shopping list (spares off): line key -> need. */
const GOLDEN: Record<string, number> = {
  [KEYS.plate3]: 1,
  [KEYS.connectors]: 1,
  [KEYS.inserts]: 36,
  [KEYS.m6x8]: 16,
  [KEYS.m6x10]: 24,
  [KEYS.nyloc]: 40,
  [KEYS.magnets]: 16,
}

const SLOW = { timeout: 4000 }

/** Have sections captured the way the wizard and the editor do (`markSection`). */
function recorded(plan: Plan): Plan {
  let next = plan
  for (const section of plan.frame.sections) {
    if (section.have !== undefined) {
      next = markSection(next, section.id, true, FIXTURE_NOW, KWS_FRAME).plan
    }
  }
  return next
}

async function open(plan: Plan): Promise<Plan> {
  const stored = await createPlan(recorded(plan))
  await act(async () => {
    await usePlanStore.getState().load(stored.id)
  })
  return stored
}

/** The user's KWS rack: 3U + 6U built, one more 3U planned on top. */
function openUserPlan(): Promise<Plan> {
  return open(kwsPlan({ sections: [{ u: 3, have: true }, { u: 6, have: true }, 3] }))
}

function renderPanel(planId: string) {
  const router = createMemoryRouter([{ path: '/plan/:planId', element: <BomPanel /> }], {
    initialEntries: [`/plan/${planId}`],
  })
  render(
    <>
      <RouterProvider router={router} />
      <Toaster />
    </>,
  )
  return router
}

function row(key: string): HTMLElement {
  return screen.getByTestId(`bom-line-${key}`)
}

/** Waits until the BOM reflects the stored settings (spares) for a line. */
async function waitForLine(key: string, attributes: Record<string, string>): Promise<HTMLElement> {
  await waitFor(() => {
    const element = row(key)
    for (const [name, value] of Object.entries(attributes)) {
      expect(element).toHaveAttribute(name, value)
    }
  }, SLOW)
  return row(key)
}

/** What the editor's live region says now. */
function said(): string {
  return useEditorAnnouncer.getState().message.trim()
}

beforeEach(async () => {
  await resetDbForTests()
  clearAnnouncement()
  finishBuild.mockClear()
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

afterEach(async () => {
  cleanup()
  await usePlanStore.getState().unload()
  vi.restoreAllMocks()
})

describe('BomPanel shopping list', () => {
  it('shows the golden +3U list (spares off): 2 plates and 36/16/24/40/16 hardware', async () => {
    await updateSettings({ sparePct: { default: 0 } })
    const plan = await openUserPlan()
    renderPanel(plan.id)
    await waitForLine(KEYS.inserts, { 'data-install': '36', 'data-spare': '0' })

    expect(screen.getByTestId('bom-tab-shopping')).toHaveAttribute('aria-selected', 'true')
    const shown = Object.fromEntries(
      screen
        .getAllByTestId(/^bom-line-/)
        .map((element) => [
          element.dataset.testid?.slice('bom-line-'.length),
          Number(element.dataset.need),
        ]),
    )
    expect(shown).toEqual(GOLDEN)
    for (const [key, need] of Object.entries(GOLDEN)) {
      expect(row(key)).toHaveAttribute('data-buy', String(need))
    }
    expect(within(row(KEYS.plate3)).getByText('3U leg plate (4 legs)')).toBeInTheDocument()
    expect(within(row(KEYS.plate3)).getByText('1 plate')).toBeInTheDocument()
    expect(within(row(KEYS.plate3)).getByText('8 h 48 min')).toBeInTheDocument()
    expect(
      within(row(KEYS.plate3)).getByText('[Optional] - Magnetic frame - 3U'),
    ).toBeInTheDocument()
    // Need 40, buy 40 (the fixture has no pack sizes).
    expect(within(row(KEYS.nyloc)).getAllByText('40')).toHaveLength(2)

    const groups = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(groups).toEqual(['Prints to make(2)', 'Hardware to buy(5)'])
    expect(screen.getByTestId('bom-summary')).toHaveTextContent(
      /^To get: 7 lines · ~.+ · 282 g · 12 h$/,
    )
    // 3U + 6U + 3U is not the designer's 6U-first 12U row.
    expect(
      screen.getByText("The designer's 12U row assumes 6U+6U; this rack has 3 sections."),
    ).toBeInTheDocument()
  })

  it('shows spares apart from what the build needs', async () => {
    const plan = await openUserPlan()
    renderPanel(plan.id)
    const inserts = await waitForLine(KEYS.inserts, {
      'data-install': '36',
      'data-spare': '4',
      'data-need': '40',
      'data-buy': '40',
    })
    expect(within(inserts).getByText('36 + 4 spare')).toBeInTheDocument()
  })

  it('ticks a line off with Got it (added to on hand) and back on when unticked', async () => {
    const plan = await openUserPlan()
    renderPanel(plan.id)
    await waitForLine(KEYS.inserts, { 'data-need': '40' })
    const checkbox = screen.getByTestId(`bom-got-it-${KEYS.inserts}`)
    expect(checkbox).toHaveAccessibleName('Got it: M5 heat-set insert (M5x8x7)')
    expect(checkbox).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(checkbox)
    await waitForLine(KEYS.inserts, { 'data-need': '0', 'data-buy': '0', 'data-got-it': 'true' })
    expect(await getInventory()).toEqual({ [KEYS.inserts]: 40 })
    expect(screen.getByTestId(`bom-got-it-${KEYS.inserts}`)).toHaveAttribute('aria-checked', 'true')
    expect(
      within(row(KEYS.inserts)).getByText('Covered by what you have on hand'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('bom-summary')).toHaveTextContent(/^To get: 6 lines/)
    expect(said()).toBe('Got it: M5 heat-set insert (M5x8x7). 40 more on hand.')

    fireEvent.click(screen.getByTestId(`bom-got-it-${KEYS.inserts}`))
    await waitForLine(KEYS.inserts, { 'data-need': '40', 'data-got-it': 'false' })
    expect(await getInventory()).toEqual({})
  })

  it('only takes back what Got it added when some were on hand before', async () => {
    await setQty(KEYS.m6x8, 100)
    const plan = await openUserPlan()
    renderPanel(plan.id)
    // 100 on hand cover 16 + 2: already ticked.
    await waitForLine(KEYS.m6x8, { 'data-need': '0', 'data-got-it': 'true' })
    fireEvent.click(screen.getByTestId(`bom-got-it-${KEYS.m6x8}`))
    await waitFor(async () => expect(await getInventory()).toEqual({ [KEYS.m6x8]: 82 }), SLOW)
    await waitFor(() =>
      expect(said()).toBe(
        'M6×8 socket head cap screw: 18 fewer on hand; the 82 left still cover it.',
      ),
    )
  })
})

describe('BomPanel on hand', () => {
  it('shows what is on hand on every hardware line, and the sum subtracts it', async () => {
    await updateSettings({ sparePct: { default: 0 } })
    await setQty(KEYS.inserts, 20)
    const plan = await openUserPlan()
    renderPanel(plan.id)
    const inserts = await waitForLine(KEYS.inserts, { 'data-need': '16', 'data-buy': '16' })
    expect(screen.getByTestId(`bom-on-hand-${KEYS.inserts}`)).toHaveTextContent('20')
    expect(screen.getByTestId(`bom-on-hand-${KEYS.inserts}`)).toHaveAccessibleName(
      'On hand: 20. Change it for M5 heat-set insert (M5x8x7)',
    )
    expect(within(inserts).getByText('On hand')).toBeInTheDocument()
    expect(screen.getByTestId(`bom-on-hand-${KEYS.nyloc}`)).toHaveTextContent('0')
    // Prints have no on-hand field of their own.
    expect(screen.queryByTestId(`bom-on-hand-${KEYS.plate3}`)).toBeNull()
    expect(screen.getByTestId('bom-on-hand-link')).toHaveAttribute('href', '/inventory')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Why: M5 heat-set insert (M5x8x7)' }))
    })
    const popover = await screen.findByRole('dialog')
    expect(
      within(popover).getByText('16 = 144 in plan − 108 in your rack − 20 on hand'),
    ).toBeInTheDocument()
    fireEvent.keyDown(popover, { key: 'Escape' })

    fireEvent.click(screen.getByTestId('bom-tab-full'))
    await waitFor(() =>
      expect(
        within(row(KEYS.inserts)).getByTestId(`bom-on-hand-${KEYS.inserts}`),
      ).toHaveTextContent('20'),
    )
  })

  it('changes what is on hand in place, and the line follows live', async () => {
    await updateSettings({ sparePct: { default: 0 } })
    const plan = await openUserPlan()
    renderPanel(plan.id)
    await waitForLine(KEYS.inserts, { 'data-need': '36' })
    await act(async () => {
      fireEvent.click(screen.getByTestId(`bom-on-hand-${KEYS.inserts}`))
    })
    const popover = await screen.findByRole('dialog')
    expect(within(popover).getByRole('link', { name: 'All hardware on hand' })).toHaveAttribute(
      'href',
      '/inventory',
    )
    const field = within(popover).getByRole('textbox', {
      name: 'On hand: M5 heat-set insert (M5x8x7)',
    })
    await waitFor(() => expect(field).toHaveFocus())
    fireEvent.change(field, { target: { value: '30' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitForLine(KEYS.inserts, { 'data-need': '6', 'data-buy': '6', 'data-got-it': 'false' })
    expect(await getInventory()).toEqual({ [KEYS.inserts]: 30 })
    await waitFor(() => expect(said()).toBe('M5 heat-set insert (M5x8x7): 30 pcs on hand.'))

    // Enough on hand: the line is ticked off as Got it.
    fireEvent.click(
      within(popover).getByRole('button', { name: 'Add 1: M5 heat-set insert (M5x8x7)' }),
    )
    await waitFor(async () => expect(await getInventory()).toEqual({ [KEYS.inserts]: 31 }), SLOW)
    fireEvent.change(field, { target: { value: '36' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitForLine(KEYS.inserts, { 'data-need': '0', 'data-buy': '0', 'data-got-it': 'true' })
    expect(screen.getByTestId(`bom-got-it-${KEYS.inserts}`)).toHaveAttribute('aria-checked', 'true')
  })
})

describe('BomPanel tabs and details', () => {
  it('switches to the full BOM and the leftovers', async () => {
    await updateSettings({ sparePct: { default: 0 } })
    const plan = await openUserPlan()
    renderPanel(plan.id)
    await waitForLine(KEYS.inserts, { 'data-spare': '0' })

    fireEvent.click(screen.getByTestId('bom-tab-full'))
    await waitFor(() =>
      expect(screen.getByTestId('bom-tab-full')).toHaveAttribute('aria-selected', 'true'),
    )
    const inserts = row(KEYS.inserts)
    expect(within(inserts).getByText('144')).toBeInTheDocument()
    expect(within(inserts).getByText('108')).toBeInTheDocument()
    // Owned parts still show in the full BOM.
    expect(row(printKey(KWS_FRAME_ID, 'leg-6u'))).toHaveAttribute('data-need', '0')
    expect(screen.queryByTestId(`bom-got-it-${KEYS.inserts}`)).toBeNull()

    fireEvent.click(screen.getByTestId('bom-tab-leftovers'))
    expect(
      await screen.findByText('No leftovers: everything you own is still used by this plan.'),
    ).toBeInTheDocument()
  })

  it('explains a number in the Why popover', async () => {
    await updateSettings({ sparePct: { default: 0 } })
    const plan = await openUserPlan()
    renderPanel(plan.id)
    await waitForLine(KEYS.inserts, { 'data-spare': '0' })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Why: M5 heat-set insert (M5x8x7)' }))
    })
    const popover = await screen.findByRole('dialog')
    expect(
      within(popover).getByText('36 = 144 in plan − 108 in your rack − 0 on hand'),
    ).toBeInTheDocument()
    expect(within(popover).getByText('In the plan')).toBeInTheDocument()
    expect(within(popover).getByText('In my rack')).toBeInTheDocument()
    expect(within(popover).getAllByText('3U section #3').length).toBeGreaterThan(0)
  })

  it('exports the shopping list as an injection-safe CSV with a byte order mark', async () => {
    await updateSettings({ sparePct: { default: 0 } })
    const plan = await openUserPlan()
    const blobs: Blob[] = []
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: (blob: Blob) => {
        blobs.push(blob)
        return 'blob:http://localhost/bom'
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
    renderPanel(plan.id)
    await waitForLine(KEYS.inserts, { 'data-spare': '0' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('bom-export-csv'))
    })
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(downloads[0]).toMatch(/^kws-fixture-plan-shopping-list-\d{4}-\d{2}-\d{2}\.csv$/)
    const bytes = new Uint8Array(await (blobs[0] as Blob).arrayBuffer())
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    const text = new TextDecoder().decode(bytes.slice(3))
    expect(text.split('\r\n').slice(0, 4)).toEqual([
      'Shopping list,KWS fixture plan,KWS Rack v2',
      '',
      'Section,Item,Spec/material,Need,Spare,Buy,Unit,Grams,Print time,Source,Done',
      'Prints to make,3U leg plate (4 legs),PETG,1,,1,plates,214,8 h 48 min,3U section #3,',
    ])
  })
})

describe('BomPanel Finish build', () => {
  it('lists what is still to get, finishes the build and uses up what was ticked', async () => {
    const plan = await openUserPlan()
    const router = renderPanel(plan.id)
    await waitForLine(KEYS.inserts, { 'data-need': '40' })
    // Got it for the inserts (36 + 4 spare) and the 3U plate.
    fireEvent.click(screen.getByTestId(`bom-got-it-${KEYS.inserts}`))
    await waitForLine(KEYS.inserts, { 'data-got-it': 'true' })
    fireEvent.click(screen.getByTestId(`bom-got-it-${KEYS.plate3}`))
    await waitForLine(KEYS.plate3, { 'data-got-it': 'true' })
    expect(await getInventory()).toEqual({ [KEYS.inserts]: 40, [KEYS.plate3]: 1 })

    await act(async () => {
      fireEvent.click(screen.getByTestId('bom-finish-build'))
    })
    const dialog = await screen.findByRole('dialog', { name: 'Finish build?' })
    expect(within(dialog).getByText('Section 3 (3U)')).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        /marks these as In my rack and uses up the parts on hand they need, such as those you ticked as Got it/,
      ),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(/5 lines on the shopping list are not ticked/),
    ).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('bom-finish-confirm'))
    })
    // A dry run for the dialog, then the real thing.
    expect(finishBuild).toHaveBeenCalledTimes(2)
    const [input, frame, at, catalog] = finishBuild.mock.lastCall ?? []
    expect(input?.id).toBe(plan.id)
    expect(frame?.id).toBe(KWS_FRAME_ID)
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(catalog?.item('lenovo-tiny-mount')).toBeDefined()

    // Everything is in the rack now; what went in is used up from on hand, the extra 4 stay.
    expect(usePlanStore.getState().plan?.frame.sections.every((s) => s.have !== undefined)).toBe(
      true,
    )
    await waitFor(async () => expect(await getInventory()).toEqual({ [KEYS.inserts]: 4 }), SLOW)
    expect(await screen.findByText('Nothing to get')).toBeInTheDocument()
    expect(screen.getByTestId('bom-finished')).toHaveTextContent(
      'Build finished: 1 item marked In my rack.',
    )

    // Start the next idea from the finished rack: same rack, Have kept.
    await act(async () => {
      fireEvent.click(screen.getByTestId('bom-next-idea'))
    })
    await waitFor(() => expect(router.state.location.pathname).not.toBe(`/plan/${plan.id}`), SLOW)
    const copyId = router.state.location.pathname.split('/').at(-1) ?? ''
    const copy = (await getPlan(copyId)).plan
    expect(copy.rackId).toBe(plan.rackId)
    expect(copy.frame.sections.map((section) => section.have !== undefined)).toEqual([
      true,
      true,
      true,
    ])
    expect((await listPlanSummaries()).length).toBe(2)
  })

  it('undoes a finished build together with what on hand it used', async () => {
    await setQty(KEYS.inserts, 40)
    const plan = await openUserPlan()
    renderPanel(plan.id)
    await waitForLine(KEYS.inserts, { 'data-got-it': 'true' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('bom-finish-build'))
    })
    await act(async () => {
      fireEvent.click(await screen.findByTestId('bom-finish-confirm'))
    })
    await waitFor(async () => expect(await getInventory()).toEqual({ [KEYS.inserts]: 4 }), SLOW)

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('bom-finished')).getByRole('button', { name: 'Undo' }),
      )
    })
    await waitFor(async () => expect(await getInventory()).toEqual({ [KEYS.inserts]: 40 }), SLOW)
    expect(usePlanStore.getState().plan?.frame.sections[2]?.have).toBeUndefined()
    await waitForLine(KEYS.inserts, { 'data-got-it': 'true' })
  })

  it('says so when everything is already in the rack', async () => {
    const stored = await open(kwsPlan({ sections: [{ u: 3, have: true }] }))
    renderPanel(stored.id)
    await act(async () => {
      fireEvent.click(await screen.findByTestId('bom-finish-build'))
    })
    const dialog = await screen.findByRole('dialog', { name: 'Finish build?' })
    expect(
      within(dialog).getByText('Everything in this plan is already in your rack.'),
    ).toBeInTheDocument()
    expect(within(dialog).queryByTestId('bom-finish-confirm')).toBeNull()
  })
})
