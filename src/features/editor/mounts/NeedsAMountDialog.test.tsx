import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDbForTests } from '@/db/db'
import { createPlan } from '@/db/plansRepo'
import type { Plan } from '@/domain/schema/plan'
import { EDITOR_IDS } from '@/domain/__fixtures__/editorFixtures'
import { useAddPart } from '@/features/custom/addPartStore'
import { copyText } from '@/lib/clipboard'
import { usePlanStore } from '@/state/planStore'
import { builtRack } from './__fixtures__/mountFixtures'
import { MountDialogs } from './MountDialogs'
import { useMountDialogs } from './mountDialogsStore'

vi.mock(import('@/state/catalogStore'), async (importOriginal) => {
  const actual = await importOriginal()
  const { mountCatalog } = await import('./__fixtures__/mountFixtures')
  const lookup = mountCatalog()
  return { ...actual, useCatalog: () => ({ lookup, revision: 0, problems: [] }) }
})

vi.mock(import('@/lib/clipboard'), () => ({ copyText: vi.fn(async () => true) }))

const SPUDER = '10 Inch Mini Rack Generator'

async function open(plan: Plan): Promise<void> {
  const stored = await createPlan(plan)
  await act(async () => {
    await usePlanStore.getState().load(stored.id)
  })
}

async function needsAMount(deviceId: string, equipmentId?: string): Promise<HTMLElement> {
  render(<MountDialogs />)
  act(() =>
    useMountDialogs
      .getState()
      .openNeedsAMount({ deviceId, ...(equipmentId === undefined ? {} : { equipmentId }) }),
  )
  return screen.findByRole('dialog', { name: 'Needs a mount?' })
}

/** A generator card's settings as name → value. */
function settings(card: HTMLElement): Record<string, string> {
  const list = card.querySelector('dl')
  if (list === null) throw new Error('no settings list')
  const entries: Array<[string, string]> = []
  for (const term of list.querySelectorAll('dt')) {
    const name = term.querySelector('code')?.textContent ?? ''
    const value = term.nextElementSibling?.textContent ?? ''
    entries.push([name, value])
  }
  return Object.fromEntries(entries)
}

beforeEach(async () => {
  await resetDbForTests()
  vi.mocked(copyText).mockClear()
  useAddPart.getState().close()
})

afterEach(async () => {
  cleanup()
  act(() => useMountDialogs.getState().close())
  await act(async () => {
    await usePlanStore.getState().unload()
  })
})

describe('NeedsAMountDialog', () => {
  it('suggests a height and the settings for three generators, with links to their pages', async () => {
    await open(builtRack())
    const dialog = await needsAMount(EDITOR_IDS.bigMiniPc)
    expect(dialog).toHaveTextContent(
      'No mount in the catalog holds the Fixture Big mini PC (190 × 190 × 40 mm, W × D × H) yet.',
    )
    expect(within(dialog).getByTestId('needs-a-mount-size')).toHaveTextContent(
      'A 1½U mount would hold it: it is 40 mm tall, plus 6 mm of room, rounded up to half-U steps.',
    )
    const spuder = within(dialog).getByTestId('generator-spuder-10-inch-rack')
    expect(within(spuder).getByRole('heading', { name: SPUDER })).toBeInTheDocument()
    expect(spuder).toHaveTextContent(
      'by spuder · Standard Digital File License · 1½U for this device',
    )
    expect(settings(spuder)).toEqual({
      rack_width: '254',
      rack_height: '1.5',
      component_width: '192',
      component_height: '42',
      component_depth: '192',
      air_holes: 'true',
    })
    const page = within(spuder).getByRole('link', {
      name: `Open on MakerWorld: ${SPUDER} (opens in a new tab)`,
    })
    expect(page).toHaveAttribute('href', 'https://makerworld.com/en/models/1765102')
    expect(page).toHaveAttribute('target', '_blank')
    expect(page).toHaveAttribute('rel', 'noopener noreferrer')
    expect(within(spuder).getByRole('link', { name: /^Source code \(MIT\)/ })).toHaveAttribute(
      'href',
      'https://github.com/spuder/10-Inch-Rack-OpenSCAD',
    )

    const keller = within(dialog).getByTestId('generator-kellerlab-unimount')
    expect(settings(keller)).toMatchObject({ 'rack size': '10in', U: '2' })
    const merkle = within(dialog).getByTestId('generator-merkle-parametric-mount')
    expect(settings(merkle)).toMatchObject({ 'rack units': '2', 'rail holes': 'M6' })
    // KWS takes M5 screws.
    expect(merkle).toHaveTextContent('Your frame takes M5 screws: M6 holes let them through.')
    expect(dialog).toHaveTextContent(
      'you can drop the 3MF or STL you downloaded on the part to see it in 3D',
    )
  })

  it('copies a generator’s settings and says so', async () => {
    await open(builtRack())
    const dialog = await needsAMount(EDITOR_IDS.bigMiniPc)
    const spuder = within(dialog).getByTestId('generator-spuder-10-inch-rack')
    fireEvent.click(within(spuder).getByRole('button', { name: `Copy settings for ${SPUDER}` }))
    await waitFor(() =>
      expect(
        within(spuder).getByRole('button', { name: `Copied the settings for ${SPUDER}` }),
      ).toBeInTheDocument(),
    )
    expect(copyText).toHaveBeenCalledWith(
      [
        `${SPUDER} (spuder)`,
        'rack_width = 254',
        'rack_height = 1.5',
        'component_width = 192',
        'component_height = 42',
        'component_depth = 192',
        'air_holes = true',
      ].join('\n'),
    )
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      `Copied the settings for ${SPUDER}.`,
    )
  })

  it('selects the settings to copy by hand when copying is blocked', async () => {
    vi.mocked(copyText).mockResolvedValueOnce(false)
    await open(builtRack())
    const dialog = await needsAMount(EDITOR_IDS.bigMiniPc)
    const keller = within(dialog).getByTestId('generator-kellerlab-unimount')
    fireEvent.click(within(keller).getByRole('button', { name: /^Copy settings for/ }))
    const box = await within(keller).findByRole('textbox', {
      name: 'Settings for Customizable Rackmount [ANY RACKSIZE]',
    })
    expect(box).toHaveValue(
      [
        'Customizable Rackmount [ANY RACKSIZE] (KellerLab)',
        'device width = 192',
        'device height = 42',
        'device depth = 192',
        'rack size = 10in',
        'U = 2',
      ].join('\n'),
    )
    await waitFor(() => expect(box).toHaveFocus())
  })

  it('warns when the device is wider than the opening', async () => {
    await open(builtRack())
    const dialog = await needsAMount(EDITOR_IDS.wideBox)
    expect(dialog).toHaveTextContent(
      'Warning: The Fixture Wide box is 230 mm wide, wider than the 222 mm opening of the KWS Rack v2',
    )
  })

  it('creates a custom mount sized for the device once the dialog has closed', async () => {
    await open(builtRack())
    const dialog = await needsAMount(EDITOR_IDS.m720q, 'eq-pc')
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Create a custom mount sized for it' }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(useAddPart.getState().request).not.toBeNull())
    expect(useAddPart.getState().request).toEqual({
      kind: 'item',
      prefill: {
        name: 'Lenovo ThinkCentre M720q Tiny mount',
        category: 'mini-pc-mount',
        heightSixths: 6,
        depthMm: 185,
        faces: ['front'],
        holds: { kind: 'device', maxW: 181, maxD: 185, maxH: 36.5, categories: ['mini-pc'] },
      },
      addToOpenPlan: true,
      placeAfterSave: true,
      // Placing the new mount puts the tray device in it.
      placeEquipmentId: 'eq-pc',
    })
    expect(useMountDialogs.getState().needsAMount).toBeNull()
  })

  it('explains a device whose size is unknown', async () => {
    await open(builtRack())
    const dialog = await needsAMount('mystery-box')
    expect(dialog).toHaveTextContent('“mystery-box” is not in the catalog, so its size is unknown.')
    expect(
      within(dialog).getByRole('button', { name: 'Create a custom mount sized for it' }),
    ).toBeDisabled()
  })
})
