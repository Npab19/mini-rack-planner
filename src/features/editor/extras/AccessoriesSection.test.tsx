import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDbForTests } from '@/db/db'
import { ItemSchema, type Item } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import { stopLibrarySync } from '@/state/catalogStore'
import { resetDbStatusForTests } from '@/state/dbStatus'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { useEditorState } from '../editorState'
import { buildPlan, currentPlan, openPlan } from '../inspector/__fixtures__/editorPlans'
import { Inspector } from '../inspector/Inspector'

const CLIPS = 'custom:zeta-cable-clips'

/** A printed accessory of the plan's own: one clip set per print. */
const CLIPS_ITEM: Item = ItemSchema.parse({
  kind: 'extra',
  id: CLIPS,
  name: 'Zeta cable clips',
  category: 'accessory',
  source: { platform: 'makerworld', url: 'https://makerworld.com/en/models/2' },
  verified: { by: 'test', date: '2026-10-11', method: 'page' },
  heightSixths: 0,
  depthMm: 0,
  prints: [
    {
      id: 'clips',
      plate: 'Clips',
      label: 'Cable clip set',
      material: 'PLA',
      gramsPerPrint: 12,
      minutesPerPrint: 30,
    },
  ],
  recipe: [{ id: 'clips', unit: 'item', ref: { print: 'clips' }, count: 1 }],
})

function withClips(extras: Plan['extras'] = []): Plan {
  const base = buildPlan([{ typeId: 's3', have: true }])
  return {
    ...base,
    custom: { ...base.custom, items: [...base.custom.items, CLIPS_ITEM] },
    extras,
  }
}

function accessories(): HTMLElement {
  return screen.getByTestId('rack-accessories')
}

function row(): HTMLElement {
  return within(accessories()).getByRole('group', { name: 'Zeta cable clips' })
}

/** Types into a count field and presses Enter. */
function enter(field: HTMLElement, value: string): void {
  fireEvent.change(field, { target: { value } })
  fireEvent.keyDown(field, { key: 'Enter' })
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

describe('Rack tab: Accessories', () => {
  it('adds an accessory with a quantity, then counts what is in my rack', async () => {
    await openPlan(withClips())
    render(<Inspector />)
    const section = accessories()
    expect(within(section).getByRole('heading', { name: 'Accessories' })).toBeInTheDocument()

    fireEvent.change(within(section).getByRole('combobox', { name: 'Accessory' }), {
      target: { value: CLIPS },
    })
    fireEvent.change(within(section).getByRole('spinbutton', { name: 'How many' }), {
      target: { value: '2' },
    })
    fireEvent.click(within(section).getByRole('button', { name: 'Add accessory' }))
    expect(currentPlan().extras).toEqual([
      { id: expect.stringMatching(/^ex-/) as unknown as string, itemId: CLIPS, qty: 2, haveQty: 0 },
    ])
    expect(announced()).toContain('Added 2 × Zeta cable clips to the plan.')

    // In words and icon, with a dashed outline while some are still to get.
    expect(within(row()).getByText('Each: 1 × Cable clip set (printed)')).toBeInTheDocument()
    expect(within(row()).getByText('2 to get')).toBeInTheDocument()
    const line = screen.getByTestId(`extra-row-${currentPlan().extras[0]?.id ?? ''}`)
    expect(line).toHaveAttribute('data-have', 'false')
    expect(
      within(row()).getByRole('link', { name: /Open page: Zeta cable clips/ }),
    ).toHaveAttribute('rel', 'noopener noreferrer')

    enter(within(row()).getByRole('spinbutton', { name: 'Quantity' }), '5')
    expect(currentPlan().extras[0]).toMatchObject({ qty: 5, haveQty: 0 })
    expect(announced()).toContain('Zeta cable clips: 5 in the plan.')

    const have = within(row()).getByRole('spinbutton', { name: 'In my rack' })
    expect(have).toHaveAccessibleDescription('of 5')
    enter(have, '9')
    // Never more than the plan uses.
    expect(currentPlan().extras[0]).toMatchObject({ qty: 5, haveQty: 5 })
    expect(within(row()).getByText('All 5 in my rack')).toBeInTheDocument()
    expect(line).toHaveAttribute('data-have', 'true')
    expect(announced()).toContain('Zeta cable clips: 5 of 5 in my rack.')

    // One undo step per change.
    act(() => usePlanStore.getState().undo())
    expect(currentPlan().extras[0]).toMatchObject({ qty: 5, haveQty: 0 })
  })

  it('keeps owned ones under Removed but owned when planning fewer or removing the line', async () => {
    await openPlan(withClips([{ id: 'ex-clips', itemId: CLIPS, qty: 4, haveQty: 4 }]))
    render(<Inspector />)

    const quantity = within(row()).getByRole('spinbutton', { name: 'Quantity' })
    // Escape reverts the typing; nothing changes.
    fireEvent.change(quantity, { target: { value: '1' } })
    fireEvent.keyDown(quantity, { key: 'Escape' })
    expect(quantity).toHaveValue(4)
    expect(currentPlan().extras[0]?.qty).toBe(4)

    enter(quantity, '3')
    expect(currentPlan().extras[0]).toMatchObject({ qty: 3, haveQty: 3 })
    expect(currentPlan().retired).toEqual([
      expect.objectContaining({ kind: 'extra', qty: 1, sourceId: 'ex-clips' }),
    ])
    expect(announced()).toContain(
      'Zeta cable clips: 3 in the plan. The other 1 you own is kept under Removed but owned.',
    )
    const removed = screen.getByTestId('rack-removed')
    expect(within(removed).getByText('Zeta cable clips × 1')).toBeInTheDocument()

    fireEvent.click(
      within(row()).getByRole('button', { name: 'Remove Zeta cable clips from the plan' }),
    )
    expect(currentPlan().extras).toEqual([])
    expect(currentPlan().retired).toEqual([expect.objectContaining({ kind: 'extra', qty: 4 })])
    expect(announced()).toContain(
      'Removed Zeta cable clips from the plan. The 3 you own are kept under Removed but owned.',
    )
    await waitFor(() =>
      expect(within(accessories()).getByRole('heading', { name: 'Accessories' })).toHaveFocus(),
    )
  })

  it('adds them as In my rack while recording, and explains a quantity it cannot take', async () => {
    const plan = await openPlan(withClips())
    useUiStore.getState().setRecordingMode(plan.id, true)
    render(<Inspector />)
    const section = accessories()
    expect(
      within(section).getByText('Recording: they are added as In my rack.'),
    ).toBeInTheDocument()

    const howMany = within(section).getByRole('spinbutton', { name: 'How many' })
    fireEvent.change(howMany, { target: { value: '0' } })
    fireEvent.click(within(section).getByRole('button', { name: 'Add accessory' }))
    expect(within(section).getByRole('alert')).toHaveTextContent('Enter how many, from 1 to 999.')
    expect(howMany).toHaveAttribute('aria-invalid', 'true')
    expect(currentPlan().extras).toEqual([])

    fireEvent.change(howMany, { target: { value: '3' } })
    fireEvent.click(within(section).getByRole('button', { name: 'Add accessory' }))
    expect(currentPlan().extras[0]).toMatchObject({ itemId: CLIPS, qty: 3, haveQty: 3 })
    expect(announced()).toContain('Added 3 × Zeta cable clips to the plan, marked In my rack.')

    // Raising the quantity while recording: the added ones are owned too, in one undo step.
    enter(within(row()).getByRole('spinbutton', { name: 'Quantity' }), '5')
    expect(currentPlan().extras[0]).toMatchObject({ qty: 5, haveQty: 5 })
    expect(announced()).toContain(
      'Zeta cable clips: 5 in the plan, the added ones marked In my rack.',
    )
    act(() => usePlanStore.getState().undo())
    expect(currentPlan().extras[0]).toMatchObject({ qty: 3, haveQty: 3 })
  })

  it('cannot be changed on a read-only plan', async () => {
    await openPlan(withClips([{ id: 'ex-clips', itemId: CLIPS, qty: 2, haveQty: 0 }]))
    usePlanStore.setState({ readOnly: true })
    render(<Inspector />)
    expect(within(row()).getByRole('spinbutton', { name: 'Quantity' })).toBeDisabled()
    expect(
      within(row()).getByRole('button', { name: 'Remove Zeta cable clips from the plan' }),
    ).toBeDisabled()
    expect(within(accessories()).getByRole('button', { name: 'Add accessory' })).toBeDisabled()
  })
})
