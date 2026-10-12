import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDbForTests } from '@/db/db'
import { getLibraryEntry, listLibrary, putLibraryEntry } from '@/db/libraryRepo'
import { createPlan } from '@/db/plansRepo'
import { newCustomDevice, newCustomItem } from '@/domain/customParts'
import { ItemSchema, type CatalogEntry } from '@/domain/schema/catalog'
import { PlanSchema } from '@/domain/schema/plan'
import { useEditorState } from '@/features/editor/editorState'
import { stopLibrarySync } from '@/state/catalogStore'
import { usePlanStore } from '@/state/planStore'
// Loaded up front, so the host's lazy import resolves at once.
import './AddPartDialog'
import { AddPartHost, resetAddPartHostsForTests } from './AddPartHost'
import { useAddPart, type AddPartRequest, type AddPartTarget } from './addPartStore'

const AT = '2026-10-11T09:30:00.000Z'

/** The host loads the dialog lazily: generous under a busy full test run. */
const LOAD = { timeout: 10_000 }

async function openDialog(request: AddPartRequest & AddPartTarget): Promise<HTMLElement> {
  act(() => useAddPart.getState().open(request))
  return screen.findByRole('dialog', {}, LOAD)
}

function control(dialog: HTMLElement, field: string): HTMLInputElement | HTMLSelectElement {
  const element = dialog.querySelector(`[data-field="${field}"]`)
  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) return element
  throw new Error(`No control for "${field}"`)
}

function type(dialog: HTMLElement, field: string, value: string): void {
  const element = control(dialog, field)
  fireEvent.change(element, { target: { value } })
  fireEvent.blur(element)
}

function click(element: HTMLElement): void {
  fireEvent.click(element)
}

async function onlyEntry(): Promise<CatalogEntry> {
  let entries: CatalogEntry[] = []
  await waitFor(async () => {
    entries = (await listLibrary()).entries
    expect(entries).toHaveLength(1)
  })
  const [entry] = entries
  if (entry === undefined) throw new Error('Nothing saved')
  return entry
}

async function closed(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}

beforeEach(async () => {
  await resetDbForTests()
  resetAddPartHostsForTests()
  useAddPart.setState({ request: null })
  useEditorState.getState().reset()
})

afterEach(async () => {
  cleanup()
  await usePlanStore.getState().unload()
  stopLibrarySync()
})

describe('AddPartDialog', () => {
  it('builds a mount from a MakerWorld link, with prints and hardware', async () => {
    render(<AddPartHost />)
    const dialog = await openDialog({ kind: 'wizard' })
    expect(within(dialog).getByRole('heading', { name: 'Add a part' })).toBeInTheDocument()
    const steps = within(dialog).getByRole('list', { name: 'Steps' })
    expect(within(steps).getAllByRole('listitem')[0]).toHaveAttribute('aria-current', 'step')
    expect(within(dialog).getByText(/never uploaded/)).toBeInTheDocument()

    const link = within(dialog).getByRole('textbox', { name: 'Link to its page (optional)' })
    fireEvent.change(link, {
      target: {
        value: 'https://makerworld.com/en/models/1945283-lenovo-tiny-mount#profileId-2087424',
      },
    })
    expect(
      within(dialog).getByText(
        'MakerWorld model 1945283, print profile 2087424. Name from the link: “Lenovo tiny mount”.',
      ),
    ).toBeInTheDocument()

    click(within(dialog).getByRole('button', { name: /^Next/ }))
    const kindHeading = await within(dialog).findByRole('heading', { name: 'What is it?' })
    await waitFor(() => expect(kindHeading).toHaveFocus())
    // A design page: most likely a printed part.
    expect(within(dialog).getByRole('radio', { name: 'A mount, panel or shelf' })).toBeChecked()

    click(within(dialog).getByRole('button', { name: /^Next/ }))
    await within(dialog).findByRole('heading', { name: 'About the mount, panel or shelf' })
    expect(control(dialog, 'name')).toHaveValue('Lenovo tiny mount')
    expect(control(dialog, 'link')).toHaveValue(
      'https://makerworld.com/en/models/1945283-lenovo-tiny-mount#profileId-2087424',
    )

    type(dialog, 'depth', '190')
    type(dialog, 'slotW', '180')
    type(dialog, 'slotD', '184')
    type(dialog, 'slotH', '36')
    type(dialog, 'designer', 'Tim')

    click(within(dialog).getByRole('button', { name: 'Add a print' }))
    await waitFor(() => expect(control(dialog, 'prints.0.plate')).toHaveFocus())
    expect(screen.getByText('Added print 1.')).toBeInTheDocument()
    type(dialog, 'prints.0.plate', 'Mount')
    type(dialog, 'prints.0.grams', '85,5')
    type(dialog, 'prints.0.time', '2:30')
    type(dialog, 'prints.0.material', 'PETG')

    const search = within(dialog).getByRole('searchbox', { name: 'Find hardware to add' })
    fireEvent.change(search, { target: { value: 'm3' } })
    // Escape clears the search; the dialog (and what was typed) stays.
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(search).toHaveValue('')
    expect(screen.getByRole('dialog')).toBe(dialog)
    fireEvent.change(search, { target: { value: 'm3x8' } })
    click(within(dialog).getByRole('button', { name: 'Add M3×8 socket head cap screw' }))
    await waitFor(() => expect(control(dialog, 'hardware.0.count')).toHaveFocus())
    type(dialog, 'hardware.0.count', '4')

    click(within(dialog).getByRole('button', { name: 'Save to My parts' }))
    const entry = await onlyEntry()
    await closed()
    expect(entry).toMatchObject({
      kind: 'item',
      id: 'custom:lenovo-tiny-mount',
      name: 'Lenovo tiny mount',
      depthMm: 190,
      source: {
        platform: 'makerworld',
        modelId: '1945283',
        profileId: '2087424',
        designer: 'Tim',
      },
      prints: [
        {
          id: 'mount',
          plate: 'Mount',
          gramsPerPrint: 85.5,
          minutesPerPrint: 150,
          material: 'PETG',
        },
      ],
      recipe: [
        { ref: { print: 'mount' }, count: 1, unit: 'item' },
        { ref: { hardware: 'screw-m3x8-shcs' }, count: 4, unit: 'item' },
      ],
      slots: [{ kind: 'fixed', maxW: 180, maxD: 184, maxH: 36 }],
      verified: { by: 'you', method: 'unverified' },
    })
  })

  it('shows what to fix, moves focus there and updates the messages as you type', async () => {
    render(<AddPartHost />)
    const dialog = await openDialog({ kind: 'device' })
    expect(within(dialog).getByRole('heading', { name: 'Add a device' })).toBeInTheDocument()

    click(within(dialog).getByRole('button', { name: 'Save to My parts' }))
    const brand = control(dialog, 'brand')
    await waitFor(() => expect(brand).toHaveFocus())
    expect(brand).toHaveAttribute('aria-invalid', 'true')
    expect(within(dialog).getByText('Enter the brand, like Lenovo.')).toBeInTheDocument()
    expect(within(dialog).getByText('Enter the width in mm.')).toBeInTheDocument()
    expect(screen.getByText('6 things need fixing before saving.')).toBeInTheDocument()
    // The message is tied to the field.
    const describedBy = brand.getAttribute('aria-describedby') ?? ''
    expect(describedBy.split(' ').map((id) => document.getElementById(id)?.textContent)).toContain(
      'Enter the brand, like Lenovo.',
    )

    type(dialog, 'brand', 'Zeta')
    expect(within(dialog).queryByText('Enter the brand, like Lenovo.')).toBeNull()
    expect(brand).not.toHaveAttribute('aria-invalid')
    type(dialog, 'model', 'PDU 4')
    fireEvent.change(control(dialog, 'category'), { target: { value: 'pdu' } })
    type(dialog, 'width', '250')
    expect(
      within(dialog).getByText('It is wider than the 222.25 mm opening of a 10-inch rack.'),
    ).toBeInTheDocument()
    type(dialog, 'depth', '100')
    type(dialog, 'height', '40')
    fireEvent.change(control(dialog, 'power'), { target: { value: 'ac' } })
    type(dialog, 'typicalW', '3')
    click(within(dialog).getByRole('checkbox', { name: 'It has its own 10-inch rack ears' }))
    fireEvent.change(control(dialog, 'rackSixths'), { target: { value: '6' } })
    fireEvent.change(control(dialog, 'checked'), { target: { value: 'vendor-spec' } })

    click(within(dialog).getByRole('button', { name: 'Save to My parts' }))
    const entry = await onlyEntry()
    await closed()
    expect(entry).toMatchObject({
      kind: 'device',
      id: 'custom:zeta-pdu-4',
      category: 'pdu',
      dims: { w: 250, d: 100, h: 40 },
      power: { typW: 3, input: { kind: 'ac' } },
      rackmount: { heightSixths: 6, face: 'front', depthMm: 100 },
      verified: { by: 'you', method: 'vendor-spec' },
    })
  })

  it('edits a part of yours under the same id', async () => {
    const device = await putLibraryEntry(
      newCustomDevice(
        {
          brand: 'Zeta',
          model: 'Switch 8',
          category: 'switch',
          widthMm: 100,
          depthMm: 98,
          heightMm: 26,
          power: 'brick',
          today: '2026-10-01',
        },
        new Set(),
      ),
    )
    render(<AddPartHost />)
    const dialog = await openDialog({ kind: 'device', editId: device.id })
    expect(
      await within(dialog).findByRole('heading', { name: 'Edit “Zeta Switch 8”' }),
    ).toBeInTheDocument()
    expect(control(dialog, 'model')).toHaveValue('Switch 8')
    expect(control(dialog, 'height')).toHaveValue('26')
    type(dialog, 'model', 'Switch 8 PoE')
    click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await closed()
    const { entries } = await listLibrary()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: device.id, model: 'Switch 8 PoE' })
  })

  it('keeps what the form does not show when editing a part', async () => {
    const base = newCustomItem(
      {
        name: 'Zeta blank',
        category: 'panel',
        heightSixths: 6,
        depthMm: 10,
        holds: { kind: 'nothing' },
        today: '2026-10-01',
      },
      new Set(),
    )
    const item = await putLibraryEntry(
      ItemSchema.parse({
        ...base,
        options: [{ id: 'vents', label: 'Vents', scope: 'item', kind: 'boolean', default: false }],
      }),
    )
    render(<AddPartHost />)
    const dialog = await openDialog({ kind: 'item', editId: item.id })
    expect(
      await within(dialog).findByText(
        'This part also has 1 option. This form does not show it; saving keeps it as it is.',
      ),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('radio', { name: 'Nothing' })).toBeChecked()
    type(dialog, 'name', 'Zeta blank 1U')
    click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await closed()
    expect(await getLibraryEntry(item.id)).toMatchObject({
      name: 'Zeta blank 1U',
      options: [{ id: 'vents' }],
    })
  })

  it('opens prefilled, as "Needs a mount?" asks, and keeps unusual values', async () => {
    render(<AddPartHost />)
    const dialog = await openDialog({
      kind: 'item',
      prefill: {
        name: 'Zeta Tiny PC mount',
        category: 'mini-pc-mount',
        heightSixths: 5,
        depthMm: 190,
        faces: ['front'],
        holds: { kind: 'device', maxW: 181, maxD: 185, maxH: 36.5, categories: ['mini-pc'] },
      },
    })
    expect(control(dialog, 'name')).toHaveValue('Zeta Tiny PC mount')
    const category = control(dialog, 'category')
    expect(category).toHaveValue('mini-pc-mount')
    expect(within(category).getByRole('option', { name: 'Mini PC mount' })).toBeInTheDocument()
    expect(control(dialog, 'heightSixths')).toHaveValue('5')
    expect(
      within(control(dialog, 'heightSixths')).getByRole('option', { name: '⅚U' }),
    ).toBeInTheDocument()
    expect(control(dialog, 'slotH')).toHaveValue('36.5')
    expect(control(dialog, 'slotCategories.mini-pc')).toBeChecked()

    click(within(dialog).getByRole('button', { name: 'Save to My parts' }))
    const entry = await onlyEntry()
    expect(entry).toMatchObject({
      category: 'mini-pc-mount',
      heightSixths: 5,
      slots: [{ maxW: 181, maxD: 185, maxH: 36.5, accepts: { categories: ['mini-pc'] } }],
    })
  })

  it('saves into the open plan and starts placing the new part', async () => {
    const plan = await createPlan(
      PlanSchema.parse({
        schema: 1,
        id: 'plan-add-part',
        rackId: 'rack-add-part',
        name: 'Add part',
        createdAt: AT,
        updatedAt: AT,
        frame: { frameId: 'kws-rack-v2', sections: [{ id: 'sec-1', typeId: 's6' }] },
      }),
    )
    await usePlanStore.getState().load(plan.id)
    render(<AddPartHost />)
    const dialog = await openDialog({ kind: 'item', addToOpenPlan: true, placeAfterSave: true })
    expect(
      within(dialog).getByRole('heading', { name: 'Add a mount, panel or shelf' }),
    ).toBeInTheDocument()
    type(dialog, 'name', 'Vent 1U')
    click(within(dialog).getByRole('radio', { name: 'Nothing' }))
    expect(control(dialog, 'category')).toHaveValue('panel')
    fireEvent.change(control(dialog, 'look'), { target: { value: 'vent' } })
    type(dialog, 'depth', '12')

    click(within(dialog).getByRole('button', { name: 'Save and place' }))
    await closed()
    const entry = await getLibraryEntry('custom:vent-1u')
    expect(entry).toMatchObject({ category: 'panel', render: { style: 'vent' }, slots: [] })
    expect(usePlanStore.getState().plan?.custom.items.map((item) => item.id)).toEqual([
      'custom:vent-1u',
    ])
    expect(useEditorState.getState().placing).toEqual({ kind: 'item', itemId: 'custom:vent-1u' })
  })

  it('adds a rack frame with its screws and notes hardware the catalog lacks', async () => {
    render(<AddPartHost />)
    const dialog = await openDialog({ kind: 'frame' })
    type(dialog, 'name', 'RackMate T1')
    type(dialog, 'heightU', '8')
    type(dialog, 'depth', '300')
    fireEvent.change(control(dialog, 'thread'), { target: { value: '10-32' } })
    expect(
      within(dialog).getByText(
        'The catalog has no 10-32 cage nuts yet, so the shopping list will not count them.',
      ),
    ).toBeInTheDocument()
    fireEvent.change(control(dialog, 'perHole'), { target: { value: 'screw' } })
    click(within(dialog).getByRole('button', { name: 'Save to My parts' }))
    const entry = await onlyEntry()
    expect(entry).toMatchObject({
      kind: 'frame',
      id: 'custom:rackmate-t1',
      standard: { innerWidthMm: 222.25, depthMm: 300, rearOpen: true },
      equipmentFastener: {
        thread: '10-32',
        perHole: 'screw',
        screwIds: ['screw-10-32x5-16in', 'screw-10-32x1-2in'],
      },
      stack: { minU: 8, maxU: 8 },
    })
  })

  it('opens once with two hosts, checks the link and asks what the part is', async () => {
    render(
      <>
        <AddPartHost />
        <AddPartHost />
      </>,
    )
    const dialog = await openDialog({ kind: 'wizard', url: 'not a link' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    click(within(dialog).getByRole('button', { name: /^Next/ }))
    expect(
      await within(dialog).findByText(/^Enter the full web address of the page/),
    ).toBeInTheDocument()
    await waitFor(() => expect(control(dialog, 'link')).toHaveFocus())

    fireEvent.change(control(dialog, 'link'), { target: { value: '' } })
    click(within(dialog).getByRole('button', { name: /^Next/ }))
    await within(dialog).findByRole('heading', { name: 'What is it?' })
    click(within(dialog).getByRole('button', { name: /^Next/ }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose what it is.')

    click(within(dialog).getByRole('radio', { name: 'A device' }))
    click(within(dialog).getByRole('button', { name: /^Next/ }))
    await within(dialog).findByRole('heading', { name: 'About the device' })
    click(within(dialog).getByRole('button', { name: 'Back' }))
    expect(within(dialog).getByRole('radio', { name: 'A device' })).toBeChecked()

    click(within(dialog).getByRole('button', { name: 'Close' }))
    await closed()
    expect(useAddPart.getState().request).toBeNull()
  })
})
