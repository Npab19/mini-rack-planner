import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb, resetDbForTests } from '@/db/db'
import { listLibrary, putLibraryEntry } from '@/db/libraryRepo'
import { createPlan } from '@/db/plansRepo'
import { newCustomDevice, newCustomFrame, newCustomItem } from '@/domain/customParts'
import type { CatalogEntry } from '@/domain/schema/catalog'
import { PlanSchema } from '@/domain/schema/plan'
// Loaded up front, so the page's lazy "Add a part" host resolves at once.
import '@/features/custom/AddPartDialog'
import { AddPartHost, resetAddPartHostsForTests } from '@/features/custom/AddPartHost'
import { useAddPart } from '@/features/custom/addPartStore'
import { stopLibrarySync } from '@/state/catalogStore'
import { LibraryPage } from './LibraryPage'

const downloads = vi.hoisted(() => [] as Array<{ name: string; blob: Blob }>)
vi.mock('@/lib/download', () => ({
  downloadBlob: vi.fn(async (name: string, blob: Blob) => {
    downloads.push({ name, blob })
    return 'downloaded' as const
  }),
}))

/** The dialog loads lazily: generous under a busy full test run. */
const LOAD = { timeout: 10_000 }
const TODAY = '2026-10-11'
const AT = '2026-10-11T09:30:00.000Z'
const NONE: ReadonlySet<string> = new Set()

const SWITCH = newCustomDevice(
  {
    brand: 'Zeta',
    model: 'Switch 8',
    category: 'switch',
    widthMm: 100,
    depthMm: 98,
    heightMm: 26,
    power: 'brick',
    sourceUrl: 'https://example.com/zeta-switch-8',
    verifiedMethod: 'vendor-spec',
    today: TODAY,
  },
  NONE,
)
const MOUNT = newCustomItem(
  {
    name: 'Tiny mount 1U',
    category: 'mount',
    heightSixths: 6,
    depthMm: 190,
    holds: { kind: 'device', maxW: 180, maxD: 184, maxH: 36 },
    prints: [{ plate: 'Mount', count: 1, gramsPerPrint: 85 }],
    sourceUrl: 'https://makerworld.com/en/models/1945283-tiny-mount',
    today: TODAY,
  },
  NONE,
)
const RACK = newCustomFrame(
  {
    name: 'RackMate T1',
    heightU: 8,
    innerWidthMm: 220,
    depthMm: 300,
    rearOpen: true,
    thread: 'M6',
    perHole: 'screw+cage-nut',
    today: TODAY,
  },
  NONE,
)

async function store(...entries: CatalogEntry[]): Promise<void> {
  for (const entry of entries) await putLibraryEntry(entry)
}

async function card(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 3, name })
  const article = heading.closest('article')
  if (article === null) throw new Error(`No card for ${name}`)
  return article
}

async function chooseMenuItem(name: string, item: RegExp | string): Promise<void> {
  const trigger = within(await card(name)).getByRole('button', {
    name: `More actions for ${name}`,
  })
  await act(async () => {
    fireEvent.click(trigger)
  })
  const menu = await screen.findByRole('menu')
  await act(async () => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: item }))
  })
}

async function planUsing(id: string, name: string, ownCopy: boolean): Promise<void> {
  await createPlan(
    PlanSchema.parse({
      schema: 1,
      id,
      rackId: `rack-${id}`,
      name,
      createdAt: AT,
      updatedAt: AT,
      frame: { frameId: 'kws-rack-v2', sections: [{ id: 'sec-1', typeId: 's6' }] },
      equipment: [{ id: 'eq-1', deviceId: SWITCH.id, have: false }],
      ...(ownCopy ? { custom: { devices: [SWITCH] } } : {}),
    }),
  )
}

/** The page with the app shell's "Add a part" host (AppLayout renders it for every page). */
function renderPage() {
  return render(
    <>
      <LibraryPage />
      <AddPartHost />
    </>,
  )
}

beforeEach(async () => {
  await resetDbForTests()
  resetAddPartHostsForTests()
  useAddPart.setState({ request: null })
  downloads.length = 0
})

afterEach(() => {
  cleanup()
  stopLibrarySync()
})

describe('LibraryPage', () => {
  it('explains your own parts while there are none, and Add a part opens the wizard', async () => {
    renderPage()
    expect(screen.getByRole('heading', { level: 1, name: 'My parts' })).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: 'You have no parts of your own yet' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add a part' }))
    expect(useAddPart.getState().request).toEqual({ kind: 'wizard' })
    const dialog = await screen.findByRole('dialog', {}, LOAD)
    expect(within(dialog).getByRole('heading', { name: 'Add a part' })).toBeInTheDocument()
  })

  it('lists your parts by kind with their facts, links and a search', async () => {
    await store(SWITCH, MOUNT, RACK)
    renderPage()
    const devices = await screen.findByRole('region', { name: 'Devices (1)' })
    expect(within(devices).getByText('100 × 98 × 26 mm · Switch')).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'Mounts, panels and shelves (1)' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Rack frames (1)' })).toBeInTheDocument()

    const mount = await card('Tiny mount 1U')
    expect(
      within(mount).getByText('1U · Mount · holds a device up to 180 × 184 × 36 mm · 1 print'),
    ).toBeInTheDocument()
    expect(within(mount).getByText('Unverified')).toBeInTheDocument()
    const link = within(mount).getByRole('link', {
      name: 'Open page for Tiny mount 1U (opens in a new tab)',
    })
    expect(link).toHaveAttribute('href', 'https://makerworld.com/en/models/1945283-tiny-mount')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    // Checked from the maker's specifications: no Unverified badge.
    expect(within(await card('Zeta Switch 8')).queryByText('Unverified')).toBeNull()

    const search = screen.getByRole('searchbox', { name: 'Search your parts' })
    fireEvent.change(search, { target: { value: 'switch' } })
    expect(await screen.findByText('1 of 3 parts matches “switch”')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 3, name: 'Tiny mount 1U' })).toBeNull()
    fireEvent.change(search, { target: { value: 'nas' } })
    expect(await screen.findByText('No part matches “nas”.')).toBeInTheDocument()
  })

  it('reports parts this version cannot read, and keeps them', async () => {
    await store(SWITCH)
    await getDb()
      .table('library')
      .put({
        id: 'custom:from-the-future',
        kind: 'device',
        updatedAt: '2030-01-01T00:00:00.000Z',
        entry: { kind: 'device', id: 'custom:from-the-future', category: 'quantum-computer' },
      })
    renderPage()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('1 part could not be read')
    expect(alert).toHaveTextContent('custom:from-the-future: This part is not valid.')
    expect(await card('Zeta Switch 8')).toBeInTheDocument()
  })

  it('edits and duplicates a part', async () => {
    await store(SWITCH)
    renderPage()
    fireEvent.click(
      within(await card('Zeta Switch 8')).getByRole('button', { name: 'Edit Zeta Switch 8' }),
    )
    expect(useAddPart.getState().request).toEqual({ kind: 'device', editId: SWITCH.id })
    const dialog = await screen.findByRole('dialog', {}, LOAD)
    expect(
      await within(dialog).findByRole('heading', { name: 'Edit “Zeta Switch 8”' }),
    ).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(
      within(await card('Zeta Switch 8')).getByRole('button', {
        name: 'Duplicate Zeta Switch 8',
      }),
    )
    expect(await card('Zeta Switch 8 (copy)')).toBeInTheDocument()
    const ids = (await listLibrary()).entries.map((entry) => entry.id).toSorted()
    expect(ids).toEqual(['custom:zeta-switch-8', 'custom:zeta-switch-8-copy'])
  })

  it('says which plans use a part before deleting it', async () => {
    await store(SWITCH)
    await planUsing('plan-alpha', 'Alpha', true)
    await planUsing('plan-beta', 'Beta', false)
    renderPage()
    await chooseMenuItem('Zeta Switch 8', 'Delete…')
    const dialog = await screen.findByRole('dialog', {}, LOAD)
    expect(
      within(dialog).getByRole('heading', { name: 'Delete “Zeta Switch 8”?' }),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(await within(dialog).findByText('2 plans use it:')).toBeInTheDocument()
    expect(within(dialog).getByText('Alpha')).toHaveTextContent('Alpha (keeps its own copy)')
    expect(within(dialog).getByText('Beta')).toHaveTextContent(
      'Beta (will show it as an unknown part)',
    )

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete part' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((await listLibrary()).entries).toEqual([])
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'My parts' })).toHaveFocus(),
    )
    expect(
      await screen.findByRole('heading', { name: 'You have no parts of your own yet' }),
    ).toBeInTheDocument()
  })

  it('exports a catalog entry file and opens the catalog submission form', async () => {
    await store(MOUNT)
    renderPage()
    await chooseMenuItem('Tiny mount 1U', /^Export as catalog entry/)
    await waitFor(() => expect(downloads).toHaveLength(1))
    const [file] = downloads
    expect(file?.name).toBe('tiny-mount-1u.json')
    const json = JSON.parse((await file?.blob.text()) ?? '{}') as { id?: string }
    expect(json.id).toBe('tiny-mount-1u')

    await chooseMenuItem('Tiny mount 1U', 'Share with everyone…')
    const dialog = await screen.findByRole('dialog', {}, LOAD)
    expect(
      within(dialog).getByRole('heading', { name: 'Share “Tiny mount 1U” with everyone' }),
    ).toBeInTheDocument()
    expect(within(dialog).getByText('Good to add:')).toBeInTheDocument()
    expect(
      within(dialog).getByText('The designer’s name, as the page shows it.'),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText('The form opens with this part’s facts filled in.'),
    ).toBeInTheDocument()
    const form = within(dialog).getByRole('link', {
      name: 'Open the form on GitHub (opens in a new tab)',
    })
    expect(form.getAttribute('href')).toMatch(
      /^https:\/\/github\.com\/Npab19\/mini-rack-planner\/issues\/new\?template=catalog-submission\.yml&/,
    )
    expect(new URL(form.getAttribute('href') ?? '').searchParams.get('entry')).toContain(
      '"id": "tiny-mount-1u"',
    )
    expect(form).toHaveAttribute('target', '_blank')
    expect(form).toHaveAttribute('rel', 'noopener noreferrer')
  })
})
