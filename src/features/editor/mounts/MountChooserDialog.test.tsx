import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDbForTests } from '@/db/db'
import { createPlan } from '@/db/plansRepo'
import type { Plan } from '@/domain/schema/plan'
import { EDITOR_IDS } from '@/domain/__fixtures__/editorFixtures'
import { canUndo, usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { useEditorState } from '../editorState'
import { clearAnnouncement, useEditorAnnouncer } from '../layout/announcer'
import { builtRack } from './__fixtures__/mountFixtures'
import { MountDialogs } from './MountDialogs'
import { useMountDialogs, type MountChooserRequest } from './mountDialogsStore'

vi.mock(import('@/state/catalogStore'), async (importOriginal) => {
  const actual = await importOriginal()
  const { mountCatalog } = await import('./__fixtures__/mountFixtures')
  const lookup = mountCatalog()
  return { ...actual, useCatalog: () => ({ lookup, revision: 0, problems: [] }) }
})

const M720Q = 'Lenovo ThinkCentre M720q Tiny'

async function open(plan: Plan): Promise<string> {
  const stored = await createPlan(plan)
  await act(async () => {
    await usePlanStore.getState().load(stored.id)
  })
  return stored.id
}

function current(): Plan {
  const plan = usePlanStore.getState().plan
  if (plan === null) throw new Error('no plan open')
  return plan
}

function said(): string {
  return useEditorAnnouncer.getState().message.trim()
}

function choose(request: MountChooserRequest): void {
  act(() => useMountDialogs.getState().openChooser(request))
}

/** Stand-in for the rack: one focusable node per placement, as the real drawing has. */
function FakeRack() {
  const placements = usePlanStore((state) => state.plan?.placements ?? [])
  return (
    <svg>
      {placements.map((placement) => (
        <g key={placement.id} data-placement-id={placement.id} tabIndex={-1} />
      ))}
    </svg>
  )
}

beforeEach(async () => {
  await resetDbForTests()
  clearAnnouncement()
  useEditorState.getState().reset()
  useUiStore.setState({ selection: [], face: 'front', recordingMode: {} })
})

afterEach(async () => {
  cleanup()
  act(() => useMountDialogs.getState().close())
  await act(async () => {
    await usePlanStore.getState().unload()
  })
})

describe('MountChooserDialog', () => {
  it('places a tray device on a mount that fits where it was dropped, in one undo step', async () => {
    await open(builtRack({ equipment: [{ id: 'eq-pc', deviceId: EDITOR_IDS.m720q, have: true }] }))
    render(
      <>
        <FakeRack />
        <MountDialogs />
      </>,
    )
    choose({ deviceId: EDITOR_IDS.m720q, equipmentId: 'eq-pc', face: 'front', y: 42 })
    const dialog = await screen.findByRole('dialog', { name: `Choose a mount for ${M720Q}` })
    expect(dialog).toHaveTextContent('179 × 183 × 34.5 mm (W × D × H), dropped at U8 on the front.')
    const tiny = within(dialog).getByTestId('mount-option-lenovo-tiny-mount')
    expect(tiny).toHaveAttribute('data-fits', 'true')
    expect(tiny).toHaveTextContent('Fits where you dropped it: U8.')
    // The generic shelf is offered as any shelf of its size.
    expect(within(dialog).getByTestId('mount-option-generic-shelf-1u')).toHaveTextContent(
      'Shelf 1U (any shelf of this size)',
    )
    // Focus starts on the first way to place it.
    const place = within(tiny).getByRole('button', { name: 'Place on Lenovo Tiny mount at U8' })
    await waitFor(() => expect(place).toHaveFocus())

    fireEvent.click(place)
    const added = current().placements.at(-1)
    expect(added).toMatchObject({ itemId: EDITOR_IDS.tinyMount, y: 42, face: 'front' })
    expect(added?.devices.map((device) => [device.deviceId, device.have])).toEqual([
      [EDITOR_IDS.m720q, true],
    ])
    expect(current().equipment).toEqual([])
    expect(said()).toBe(`Placed ${M720Q} on Lenovo Tiny mount at U8.`)
    expect(useUiStore.getState().selection).toEqual([added?.id])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The new part takes focus on the rack, so the arrow keys move it.
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-placement-id')).toBe(added?.id),
    )

    expect(canUndo()).toBe(true)
    act(() => usePlanStore.getState().undo())
    expect(current().equipment.map((entry) => entry.id)).toEqual(['eq-pc'])
    expect(current().placements).toHaveLength(7)
  })

  it('offers the nearest free spot when the dropped one is taken, for a device from the palette', async () => {
    await open(builtRack())
    render(<MountDialogs />)
    choose({ deviceId: EDITOR_IDS.m720q, face: 'front', y: 0 })
    const dialog = await screen.findByRole('dialog', { name: `Choose a mount for ${M720Q}` })
    const tiny = within(dialog).getByTestId('mount-option-lenovo-tiny-mount')
    expect(tiny).toHaveAttribute('data-fits', 'false')
    expect(tiny).toHaveTextContent('Not where you dropped it: It overlaps 1U blank (U1).')
    expect(tiny).toHaveTextContent('Nearest free spot: U8.')

    fireEvent.click(within(tiny).getByRole('button', { name: 'Place on Lenovo Tiny mount at U8' }))
    // Through the tray and out again in the same step: nothing is left waiting.
    expect(current().equipment).toEqual([])
    expect(
      current()
        .placements.at(-1)
        ?.devices.map((device) => device.have),
    ).toEqual([false])
    act(() => usePlanStore.getState().undo())
    expect(current().placements).toHaveLength(7)
    expect(current().equipment).toEqual([])
  })

  it('marks the new mount and the device In my rack in Recording mode', async () => {
    const planId = await open(builtRack())
    act(() => useUiStore.getState().setRecordingMode(planId, true))
    render(<MountDialogs />)
    choose({ deviceId: EDITOR_IDS.m720q, face: 'front', y: 48 })
    const dialog = await screen.findByRole('dialog', { name: `Choose a mount for ${M720Q}` })
    expect(dialog).toHaveTextContent('What you place now is marked In my rack.')
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Place on Lenovo Tiny mount at U9' }),
    )
    const added = current().placements.at(-1)
    expect(added?.have).toMatchObject({ itemId: EDITOR_IDS.tinyMount })
    expect(added?.devices.map((device) => device.have)).toEqual([true])
    expect(said()).toBe(`Placed ${M720Q} on Lenovo Tiny mount at U9, marked In my rack.`)
  })

  it('places ear-mounted gear with its own ears', async () => {
    await open(builtRack({ equipment: [{ id: 'eq-pdu', deviceId: EDITOR_IDS.pdu, have: false }] }))
    render(<MountDialogs />)
    choose({ deviceId: EDITOR_IDS.pdu, equipmentId: 'eq-pdu', face: 'front', y: 48 })
    const dialog = await screen.findByRole('dialog')
    const ears = within(dialog).getByTestId(`mount-option-${EDITOR_IDS.pdu}`)
    expect(ears).toHaveTextContent('With its own ears')
    fireEvent.click(within(ears).getByRole('button', { name: /^Place the .* PDU at U9$/ }))
    expect(current().placements.at(-1)).toMatchObject({ itemId: EDITOR_IDS.pdu, y: 48 })
    expect(said()).toBe('Placed Fixture 4-outlet 10" PDU with its own ears at U9.')
  })

  it('says when no mount has room, and hands over to “Needs a mount?” when nothing takes it', async () => {
    await open(
      builtRack({ equipment: [{ id: 'eq-ups', deviceId: EDITOR_IDS.towerUps, have: true }] }),
    )
    render(<MountDialogs />)
    choose({ deviceId: EDITOR_IDS.ds224, face: 'front', y: 42 })
    const full = await screen.findByRole('dialog', { name: /DS224\+/ })
    expect(full).toHaveTextContent('None of these has a free spot on the front.')
    expect(within(full).getByTestId('mount-option-kws-ds224-module-4u')).toHaveTextContent(
      'There is no free spot for it.',
    )
    expect(within(full).queryByRole('button', { name: /^Place on/ })).toBeNull()
    act(() => useMountDialogs.getState().close())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    choose({ deviceId: EDITOR_IDS.towerUps, equipmentId: 'eq-ups', face: 'front', y: 42 })
    const none = await screen.findByRole('dialog', { name: 'Choose a mount for Fixture Tower UPS' })
    expect(none).toHaveTextContent('No mount in the catalog takes the Fixture Tower UPS yet.')
    fireEvent.click(within(none).getByRole('button', { name: 'Needs a mount?' }))
    expect(await screen.findByRole('dialog', { name: 'Needs a mount?' })).toBeInTheDocument()
    expect(useMountDialogs.getState().needsAMount).toEqual({
      deviceId: EDITOR_IDS.towerUps,
      equipmentId: 'eq-ups',
    })
    expect(useMountDialogs.getState().chooser).toBeNull()
  })

  it('closes with Escape and leaves the plan alone', async () => {
    await open(builtRack())
    render(<MountDialogs />)
    choose({ deviceId: EDITOR_IDS.m720q, face: 'front', y: 42 })
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(useMountDialogs.getState().chooser).toBeNull())
    expect(current().placements).toHaveLength(7)
  })

  it('explains a device that is not in the catalog', async () => {
    await open(builtRack())
    render(<MountDialogs />)
    choose({ deviceId: 'mystery-box', face: 'front', y: 42 })
    const dialog = await screen.findByRole('dialog', { name: 'Choose a mount for mystery-box' })
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      '“mystery-box” is not in the catalog, so its size and mounts are unknown.',
    )
  })

  it('closes when the editor goes away', async () => {
    await open(builtRack())
    const { unmount } = render(<MountDialogs />)
    choose({ deviceId: EDITOR_IDS.m720q, face: 'front', y: 42 })
    await screen.findByRole('dialog')
    unmount()
    expect(useMountDialogs.getState().chooser).toBeNull()
  })
})
