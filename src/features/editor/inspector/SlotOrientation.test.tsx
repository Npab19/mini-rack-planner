import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDbForTests } from '@/db/db'
import { ItemSchema, type Item } from '@/domain/schema/catalog'
import type { PlacedDevice, Plan } from '@/domain/schema/plan'
import { stopLibrarySync } from '@/state/catalogStore'
import { resetDbStatusForTests } from '@/state/dbStatus'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { useEditorState } from '../editorState'
import { buildPlan, currentPlan, openPlan, ZETA } from './__fixtures__/editorPlans'
import { Inspector } from './Inspector'

const SHELF = 'custom:zeta-shelf-2u'

/** A 2U shelf whose deck takes devices flat, turned or on their side (up to 80 mm tall). */
const SHELF_ITEM: Item = ItemSchema.parse({
  kind: 'item',
  id: SHELF,
  name: 'Zeta shelf 2U',
  category: 'shelf',
  verified: { by: 'test', date: '2026-10-11', method: 'page' },
  heightSixths: 12,
  depthMm: 245,
  mount: { front: 4, holeOffsetsMm: [6.35, 82.55] },
  slots: [
    {
      id: 'deck',
      label: 'Deck',
      kind: 'area',
      maxW: 215,
      maxD: 240,
      maxH: 80,
      orientations: ['flat', 'flat-rotated', 'on-side'],
      layout: { xMm: 3, yMm: 5, zMm: 0 },
    },
  ],
})

function switchAt(id: string, xMm: number): PlacedDevice {
  return { id, deviceId: ZETA.switch, slotId: 'deck', xMm, orientation: 'flat', have: false }
}

/** The built 3U + 6U with the shelf at U1–U2 holding two 8-port switches side by side. */
function shelfPlan(): Plan {
  const base = buildPlan([
    { typeId: 's3', have: true },
    { typeId: 's6', have: true },
  ])
  return {
    ...base,
    custom: { ...base.custom, items: [...base.custom.items, SHELF_ITEM] },
    placements: [
      {
        id: 'pl-shelf',
        itemId: SHELF,
        y: 0,
        face: 'front',
        bay: 'full',
        devices: [switchAt('dv-a', 0), switchAt('dv-b', 105)],
      },
    ],
  }
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

describe('Inspector: how a device sits in its slot', () => {
  it('turns a device, re-packs the slot, and says why the other ways do not work', async () => {
    await openPlan(shelfPlan())
    act(() => useUiStore.getState().select(['pl-shelf']))
    render(<Inspector />)

    const picker = screen.getByTestId('inspector-orientation-dv-a')
    expect(picker).toHaveAccessibleName('Zeta Switch 8: how it sits')
    expect(within(picker).getByRole('radio', { name: 'Flat' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(within(picker).getByRole('radio', { name: 'On its side' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    // The reason is in words, next to it and in the group's description.
    expect(picker).toHaveAccessibleDescription(
      'On its side: The Zeta Switch 8 on its side (26 × 98 × 100 mm) does not fit Deck (215 × 240 × 80 mm).',
    )

    fireEvent.click(within(picker).getByRole('radio', { name: 'Turned 90°' }))
    expect(
      currentPlan().placements[0]?.devices.map(({ id, xMm, orientation }) => ({
        id,
        xMm,
        orientation,
      })),
    ).toEqual([
      { id: 'dv-a', xMm: 0, orientation: 'flat-rotated' },
      { id: 'dv-b', xMm: 103, orientation: 'flat' },
    ])
    expect(
      within(screen.getByTestId('inspector-orientation-dv-a')).getByRole('radio', {
        name: 'Turned 90°',
      }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(
      within(screen.getByTestId('inspector-device-dv-a')).getByText('Fits, turned 90°'),
    ).toBeInTheDocument()
    expect(announced()).toContain('The Zeta Switch 8 now sits turned 90°.')

    // One undo step brings it back.
    act(() => usePlanStore.getState().undo())
    expect(currentPlan().placements[0]?.devices[0]?.orientation).toBe('flat')
  })

  it('offers no choice when the slot takes devices one way only', async () => {
    await openPlan(
      buildPlan(
        [{ typeId: 's3', have: true }],
        [
          {
            id: 'pl-mount',
            itemId: ZETA.pcMount,
            y: 0,
            devices: [{ id: 'dv-pc', deviceId: ZETA.tinyPc, slotId: 'pc', have: true }],
          },
        ],
      ),
    )
    act(() => useUiStore.getState().select(['pl-mount']))
    render(<Inspector />)
    expect(screen.getByTestId('inspector-device-dv-pc')).toHaveTextContent('Fits, lying flat')
    expect(screen.queryByTestId('inspector-orientation-dv-pc')).toBeNull()
  })

  it('cannot be changed on a read-only plan', async () => {
    await openPlan(shelfPlan())
    usePlanStore.setState({ readOnly: true })
    act(() => useUiStore.getState().select(['pl-shelf']))
    render(<Inspector />)
    const picker = screen.getByTestId('inspector-orientation-dv-a')
    fireEvent.click(within(picker).getByRole('radio', { name: 'Turned 90°' }))
    expect(currentPlan().placements[0]?.devices[0]?.orientation).toBe('flat')
  })
})
