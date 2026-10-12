import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDbForTests } from '@/db/db'
import { getInventory } from '@/db/inventoryRepo'
import { ItemSchema, type Item } from '@/domain/schema/catalog'
import type { Plan, RetiredEntry } from '@/domain/schema/plan'
import { stopLibrarySync } from '@/state/catalogStore'
import { resetDbStatusForTests } from '@/state/dbStatus'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { useEditorState } from '../editorState'
import { buildPlan, currentPlan, openPlan, ZETA } from '../inspector/__fixtures__/editorPlans'
import { Inspector } from '../inspector/Inspector'

const AT = '2026-10-11T12:00:00.000Z'
const CLIPS = 'custom:zeta-cable-clips'

const CLIPS_ITEM: Item = ItemSchema.parse({
  kind: 'extra',
  id: CLIPS,
  name: 'Zeta cable clips',
  category: 'accessory',
  verified: { by: 'test', date: '2026-10-11', method: 'page' },
  heightSixths: 0,
  depthMm: 0,
})

/** The PC mount the user deleted (built with vent slots), with the Tiny PC they own in it. */
const OLD_MOUNT: RetiredEntry = {
  id: 'rt-mount',
  kind: 'placement',
  snapshot: { at: AT, itemId: ZETA.pcMount, options: { vents: true } },
  sourceId: 'pl-old',
  devices: [ZETA.tinyPc],
}

const OLD_SECTION: RetiredEntry = {
  id: 'rt-section',
  kind: 'section',
  snapshot: { at: AT, typeId: 's3', heightU: 3, options: { magnets: true } },
  sourceId: 'sec-old',
}

const OLD_CLIPS: RetiredEntry = {
  id: 'rt-clips',
  kind: 'extra',
  snapshot: { at: AT, itemId: CLIPS, options: {} },
  qty: 2,
}

/** The built 3U + 6U, a blank in my rack at U1, and the three removed parts. */
function planWithRemoved(retired: RetiredEntry[] = [OLD_MOUNT, OLD_SECTION, OLD_CLIPS]): Plan {
  const base = buildPlan(
    [
      { typeId: 's3', have: true },
      { typeId: 's6', have: true },
    ],
    [{ id: 'pl-blank', itemId: ZETA.blank1u, y: 0, have: true }],
  )
  return {
    ...base,
    custom: { ...base.custom, items: [...base.custom.items, CLIPS_ITEM] },
    retired,
  }
}

function removed(): HTMLElement {
  return screen.getByTestId('rack-removed')
}

function announced(): string {
  return screen
    .getAllByRole('status')
    .map((region) => region.textContent ?? '')
    .join(' | ')
}

beforeEach(async () => {
  await resetDbForTests()
  resetDbStatusForTests()
  useUiStore.setState({ recordingMode: {}, selection: [] })
  useEditorState.getState().reset()
})

afterEach(async () => {
  cleanup()
  await usePlanStore.getState().unload()
  stopLibrarySync()
})

describe('Rack tab: Removed but owned', () => {
  it('lists what was removed and what can be done with each', async () => {
    await openPlan(planWithRemoved())
    render(<Inspector />)
    const section = removed()
    expect(within(section).getByRole('heading', { name: 'Removed but owned (3)' })).toBeVisible()
    const mount = screen.getByTestId('retired-row-rt-mount')
    expect(mount).toHaveTextContent('Zeta PC mount 1U')
    expect(mount).toHaveTextContent('With the Zeta Tiny PC')
    expect(screen.getByTestId('retired-row-rt-section')).toHaveTextContent('3U section')
    expect(screen.getByTestId('retired-row-rt-clips')).toHaveTextContent('Zeta cable clips × 2')
    for (const name of ['Zeta PC mount 1U', '3U section', 'Zeta cable clips × 2']) {
      expect(within(section).getByRole('button', { name: `Reuse ${name}` })).toBeEnabled()
      expect(within(section).getByRole('button', { name: `Keep as spare: ${name}` })).toBeEnabled()
      expect(within(section).getByRole('button', { name: `Discard ${name}` })).toBeEnabled()
    }
  })

  it('reuses a part at the lowest free spot, In my rack with its device, and selects it', async () => {
    await openPlan(planWithRemoved())
    render(<Inspector />)
    fireEvent.click(within(removed()).getByRole('button', { name: 'Reuse Zeta PC mount 1U' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reuse Zeta PC mount 1U' })
    expect(within(dialog).getByRole('combobox', { name: 'Position' })).toHaveDisplayValue('U2')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Put back at U2' }))

    const plan = currentPlan()
    const back = plan.placements.find((placement) => placement.itemId === ZETA.pcMount)
    expect(back).toMatchObject({
      y: 6,
      face: 'front',
      options: { vents: true },
      have: { itemId: ZETA.pcMount, options: { vents: true } },
      devices: [expect.objectContaining({ deviceId: ZETA.tinyPc, slotId: 'pc', have: true })],
    })
    expect(plan.retired.map((entry) => entry.id)).toEqual(['rt-section', 'rt-clips'])
    expect(useUiStore.getState().selection).toEqual([back?.id])
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Zeta PC mount 1U' })).toHaveFocus(),
    )
    expect(announced()).toContain(
      'Put Zeta PC mount 1U back at U2 on the front, In my rack, with the Zeta Tiny PC.',
    )
  })

  it('puts a section back at the bottom of the stack', async () => {
    await openPlan(planWithRemoved())
    render(<Inspector />)
    fireEvent.click(within(removed()).getByRole('button', { name: 'Reuse 3U section' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reuse 3U section' })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'At the bottom of the stack' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Put back at the bottom' }))

    const sections = currentPlan().frame.sections
    expect(sections.map((section) => [section.typeId, section.have?.at])).toEqual([
      ['s3', AT],
      ['s3', expect.any(String)],
      ['s6', expect.any(String)],
    ])
    // What was on the stack moved up with it.
    expect(currentPlan().placements[0]?.y).toBe(18)
    expect(useUiStore.getState().selection).toEqual([sections[0]?.id])
    expect(announced()).toContain(
      'Put the 3U section back at the bottom, In my rack. Stack, bottom to top: 3U + 3U + 6U · 12U.',
    )
  })

  it('puts accessories straight back on their line, In my rack', async () => {
    await openPlan(planWithRemoved())
    render(<Inspector />)
    fireEvent.click(within(removed()).getByRole('button', { name: 'Reuse Zeta cable clips × 2' }))
    expect(currentPlan().extras).toEqual([
      { id: expect.stringMatching(/^ex-/) as unknown as string, itemId: CLIPS, qty: 2, haveQty: 2 },
    ])
    expect(currentPlan().retired.map((entry) => entry.id)).toEqual(['rt-mount', 'rt-section'])
    expect(announced()).toContain(
      'Put Zeta cable clips × 2 back on the accessories list, In my rack.',
    )
    await waitFor(() =>
      expect(
        within(removed()).getByRole('heading', { name: 'Removed but owned (2)' }),
      ).toHaveFocus(),
    )
  })

  it('keeps a part as spare: its parts go into the spares, and Undo takes them out again', async () => {
    await openPlan(planWithRemoved())
    render(<Inspector />)
    fireEvent.click(
      within(removed()).getByRole('button', { name: 'Keep as spare: Zeta PC mount 1U' }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'Keep Zeta PC mount 1U as spare?' })
    const spares = within(dialog).getByRole('list', { name: 'Goes into your spares' })
    expect(
      within(spares)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['4 × M5×10 socket head cap screw', '1 × Zeta Tiny PC'])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep as spare' }))

    expect(currentPlan().retired.map((entry) => entry.id)).toEqual(['rt-section', 'rt-clips'])
    await waitFor(async () =>
      expect(await getInventory()).toEqual({
        'hw:screw-m5x10-shcs': 4,
        [`device:${ZETA.tinyPc}`]: 1,
      }),
    )
    await waitFor(() =>
      expect(announced()).toContain(
        'Kept Zeta PC mount 1U as spare: its parts are in your spares now.',
      ),
    )
    const kept = screen.getByTestId('retired-kept')
    expect(kept).toHaveTextContent('Kept Zeta PC mount 1U as spare.')

    fireEvent.click(within(kept).getByRole('button', { name: 'Undo' }))
    expect(currentPlan().retired.map((entry) => entry.id)).toEqual([
      'rt-mount',
      'rt-section',
      'rt-clips',
    ])
    await waitFor(async () => expect(await getInventory()).toEqual({}))
    expect(screen.queryByTestId('retired-kept')).toBeNull()
  })

  it('discards a part only after asking', async () => {
    await openPlan(planWithRemoved())
    render(<Inspector />)
    fireEvent.click(within(removed()).getByRole('button', { name: 'Discard 3U section' }))
    let dialog = await screen.findByRole('dialog', { name: 'Discard 3U section?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(currentPlan().retired).toHaveLength(3)

    fireEvent.click(within(removed()).getByRole('button', { name: 'Discard 3U section' }))
    dialog = await screen.findByRole('dialog', { name: 'Discard 3U section?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(currentPlan().retired.map((entry) => entry.id)).toEqual(['rt-mount', 'rt-clips'])
    expect(announced()).toContain(
      'Discarded 3U section: it no longer counts as yours. Undo brings it back.',
    )
    await waitFor(() =>
      expect(
        within(removed()).getByRole('heading', { name: 'Removed but owned (2)' }),
      ).toHaveFocus(),
    )
  })

  it('explains what cannot go back, and says when nothing was removed', async () => {
    const ghost: RetiredEntry = {
      id: 'rt-ghost',
      kind: 'placement',
      snapshot: { at: AT, itemId: 'custom:zeta-gone', options: {} },
    }
    await openPlan(planWithRemoved([ghost]))
    render(<Inspector />)
    const row = screen.getByTestId('retired-row-rt-ghost')
    expect(within(row).queryByRole('button', { name: /^Reuse/ })).toBeNull()
    expect(row).toHaveTextContent(
      'It is not in your catalog any more, so it cannot go back on the rack.',
    )

    fireEvent.click(within(row).getByRole('button', { name: /^Discard/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }))
    await waitFor(() =>
      expect(removed()).toHaveTextContent(
        'Nothing here. When you delete or retire something you own, it waits here',
      ),
    )
  })
})
