import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadBundledCatalog } from '@/catalog/loader'
import { resetDbForTests } from '@/db/db'
import { createPlan } from '@/db/plansRepo'
import { ItemSchema } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import { buildSamplePlan } from '@/features/plans/sample'
import { stopLibrarySync } from '@/state/catalogStore'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { useEditorState, type PlaceSource } from '../editorState'
import { AddAtUDialog } from './AddAtUDialog'

const lookup = loadBundledCatalog().lookup
const BLANK: PlaceSource = { kind: 'item', itemId: 'generic-blank-1u' }

/** The user's own panel, mountable on either face (the bundled parts are front only). */
const EITHER_FACE = ItemSchema.parse({
  kind: 'item',
  id: 'custom:either-face-blank',
  name: 'My two-sided blank 1U',
  category: 'panel',
  verified: { by: 'me', date: '2026-10-11', method: 'calipers' },
  heightSixths: 6,
  faces: ['front', 'rear'],
  depthMm: 3,
  mount: { front: 4, holeOffsetsMm: [6.35, 38.1] },
})

async function openSample(): Promise<void> {
  const sample = buildSamplePlan(lookup, '2026-10-11T09:30:00.000Z').plan
  const plan: Plan = { ...sample, custom: { ...sample.custom, items: [EITHER_FACE] } }
  const stored = await createPlan(plan)
  await act(async () => {
    await usePlanStore.getState().load(stored.id)
  })
}

function current(): Plan {
  const plan = usePlanStore.getState().plan
  if (plan === null) throw new Error('no plan open')
  return plan
}

function positions(dialog: HTMLElement): string[] {
  const group = within(dialog).getByRole('radiogroup', { name: 'Position' })
  return within(group)
    .getAllByRole('radio')
    .map((radio) => radio.getAttribute('aria-label') ?? '')
}

beforeEach(async () => {
  await resetDbForTests()
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    await usePlanStore.getState().unload()
  })
  stopLibrarySync()
  useEditorState.getState().reset()
  useUiStore.setState({ selection: [], face: 'front', zoom: 1, recordingMode: {} })
})

describe('AddAtUDialog', () => {
  it('lists every free start and places at the chosen one', async () => {
    await openSample()
    const onOpenChange = vi.fn()
    const onPlaced = vi.fn()
    render(<AddAtUDialog open source={BLANK} onOpenChange={onOpenChange} onPlaced={onPlaced} />)
    const dialog = await screen.findByRole('dialog', { name: 'Add Blank panel 1U at…' })
    // U1–U4 and U10 are taken in the sample.
    expect(positions(dialog)).toEqual(['U5', 'U6', 'U7', 'U8', 'U9', 'U11', 'U12'])
    expect(within(dialog).getByText(/7 free spots on the front/)).toBeInTheDocument()
    // Front-only parts get no face choice.
    expect(within(dialog).queryByRole('radiogroup', { name: 'Face' })).toBeNull()
    // The lowest is chosen to start with.
    expect(within(dialog).getByRole('button', { name: 'Add at U5' })).toBeEnabled()

    fireEvent.click(within(dialog).getByRole('radio', { name: 'U11' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add at U11' }))
    const added = current().placements.at(-1)
    expect(added).toMatchObject({ itemId: 'generic-blank-1u', y: 60, face: 'front' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onPlaced).toHaveBeenCalledWith(added?.id)
    expect(screen.getByText('Placed Blank panel 1U at U11.')).toBeInTheDocument()
  })

  it('switches faces for parts that mount on either', async () => {
    await openSample()
    render(
      <AddAtUDialog
        open
        source={{ kind: 'item', itemId: EITHER_FACE.id }}
        onOpenChange={() => undefined}
      />,
    )
    const dialog = await screen.findByRole('dialog', { name: 'Add My two-sided blank 1U at…' })
    expect(positions(dialog)).toHaveLength(7)
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Rear' }))
    // Nothing is mounted on the rear yet, and nothing in front reaches back that far.
    expect(positions(dialog)).toHaveLength(12)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add at U1' }))
    expect(current().placements.at(-1)).toMatchObject({ y: 0, face: 'rear' })
  })

  it('marks the new part In my rack in Recording mode', async () => {
    await openSample()
    useUiStore.getState().setRecordingMode(current().id, true)
    render(<AddAtUDialog open source={BLANK} onOpenChange={() => undefined} />)
    const dialog = await screen.findByRole('dialog', { name: 'Add Blank panel 1U at…' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add at U5' }))
    expect(current().placements.at(-1)?.have).toMatchObject({ itemId: 'generic-blank-1u' })
  })

  it('uses what is being placed when no source is given, and explains what cannot go on the rails', async () => {
    await openSample()
    act(() =>
      useEditorState
        .getState()
        .startPlacing({ kind: 'device', deviceId: 'lenovo-thinkcentre-m920q-tiny' }),
    )
    render(<AddAtUDialog open onOpenChange={() => undefined} />)
    const dialog = await screen.findByRole('dialog', {
      name: 'Add Lenovo ThinkCentre M920q Tiny at…',
    })
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'does not mount on the rails by itself',
    )
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled()
  })

  it('says when no spot is free', async () => {
    await openSample()
    render(
      <AddAtUDialog
        open
        source={{ kind: 'item', itemId: 'synology-4bay-kws-module-4u' }}
        onOpenChange={() => undefined}
      />,
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Add Synology 4-bay KWS module 4U at…',
    })
    // 4U: U5–U8 or U6–U9 fit in the 6U section's free space.
    expect(positions(dialog)).toEqual(['U5–U8', 'U6–U9'])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add at U5–U8' }))
    cleanup()
    render(
      <AddAtUDialog
        open
        source={{ kind: 'item', itemId: 'synology-4bay-kws-module-4u' }}
        onOpenChange={() => undefined}
      />,
    )
    const again = await screen.findByRole('dialog')
    expect(within(again).getByText('No free spot fits it on the front.')).toBeInTheDocument()
    expect(within(again).getByRole('button', { name: 'Add' })).toBeDisabled()
  })
})
