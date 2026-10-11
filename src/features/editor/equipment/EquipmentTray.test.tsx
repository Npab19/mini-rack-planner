import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDbForTests } from '@/db/db'
import { createPlan } from '@/db/plansRepo'
import { markSection } from '@/domain/frame'
import type { Plan } from '@/domain/schema/plan'
import { FIXTURE_NOW, KWS_FRAME, kwsPlan } from '@/domain/__fixtures__/kws'
import { canUndo, usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { useEditorState } from '../editorState'
import { clearAnnouncement, useEditorAnnouncer } from '../layout/announcer'
import { EquipmentTray } from './EquipmentTray'

vi.mock(import('@/state/catalogStore'), async (importOriginal) => {
  const actual = await importOriginal()
  const { kwsCatalog } = await import('@/domain/__fixtures__/kws')
  const lookup = kwsCatalog()
  return { ...actual, useCatalog: () => ({ lookup, revision: 0, problems: [] }) }
})

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

/**
 * The user's 9U (3U + 6U, built) with 7U of blanks on the front, and a Lenovo M720q (1U on the
 * Tiny mount) and a Raspberry Pi 5 (2U on the shelf) waiting to be placed.
 */
function userPlan(equipment: Plan['equipment'] = defaultEquipment()): Plan {
  return recorded(
    kwsPlan({
      sections: [
        { u: 3, have: true },
        { u: 6, have: true },
      ],
      placements: Array.from({ length: 7 }, (_, index) => ({
        id: `pl-blank-${index + 1}`,
        itemId: 'blank-1u',
        y: index * 6,
      })),
      equipment,
    }),
  )
}

function defaultEquipment(): Plan['equipment'] {
  return [
    { id: 'eq-pc', deviceId: 'lenovo-m720q', have: false },
    { id: 'eq-pi', deviceId: 'rpi-5', have: false },
  ]
}

async function open(plan: Plan): Promise<string> {
  const stored = await createPlan(plan)
  await act(async () => {
    await usePlanStore.getState().load(stored.id)
  })
  return stored.id
}

function trayEntries(): Plan['equipment'] {
  return usePlanStore.getState().plan?.equipment ?? []
}

/** What the editor's live region says now. */
function said(): string {
  return useEditorAnnouncer.getState().message.trim()
}

beforeEach(async () => {
  await resetDbForTests()
  clearAnnouncement()
  useEditorState.getState().reset()
  useUiStore.setState({ recordingMode: {} })
})

afterEach(async () => {
  cleanup()
  await usePlanStore.getState().unload()
})

describe('EquipmentTray summary', () => {
  it('compares what the equipment needs with the free space and grows the rack in one step', async () => {
    await open(userPlan())
    render(<EquipmentTray />)
    expect(await screen.findByTestId('equipment-summary')).toHaveTextContent(
      'Needs ~10U · rack 9U, 2U free → add 3U',
    )
    expect(screen.getByText('The equipment waiting here needs ~3U.')).toBeInTheDocument()
    expect(screen.getByTestId('equipment-estimate-eq-pc')).toHaveTextContent(
      '~1U on Lenovo Tiny mount',
    )
    expect(screen.getByTestId('equipment-estimate-eq-pi')).toHaveTextContent('~2U on 2U shelf')

    fireEvent.click(screen.getByTestId('equipment-grow-top'))
    const sections = usePlanStore.getState().plan?.frame.sections ?? []
    expect(sections.map((section) => [section.typeId, section.have !== undefined])).toEqual([
      ['s3', true],
      ['s6', true],
      ['s3', false],
    ])
    // One undo step takes it back.
    expect(canUndo()).toBe(true)
    expect(screen.getByTestId('equipment-summary')).toHaveTextContent(
      'Needs ~10U · rack 12U, 5U free · it fits',
    )
    expect(screen.queryByTestId('equipment-grow-top')).toBeNull()
    expect(said()).toBe('Added 3U at the top: the rack is now 12U.')
    act(() => usePlanStore.getState().undo())
    expect(usePlanStore.getState().plan?.frame.sections).toHaveLength(2)
  })

  it('grows at the bottom too', async () => {
    await open(userPlan())
    render(<EquipmentTray />)
    fireEvent.click(await screen.findByTestId('equipment-grow-bottom'))
    const sections = usePlanStore.getState().plan?.frame.sections ?? []
    expect(sections.map((section) => section.have !== undefined)).toEqual([false, true, true])
    // What was mounted moved up with its sections.
    expect(usePlanStore.getState().plan?.placements[0]?.y).toBe(18)
  })
})

describe('EquipmentTray devices', () => {
  it('offers up to three mounts and starts placing the device on one', async () => {
    await open(userPlan())
    render(<EquipmentTray />)
    const row = await screen.findByTestId('equipment-item-eq-pc')
    expect(row).toHaveTextContent('Lenovo ThinkCentre M720q Tiny')
    expect(row).toHaveTextContent('179 × 183 × 34.5 mm')
    const place = within(row).getByTestId('equipment-place-eq-pc-lenovo-tiny-mount')
    expect(place).toHaveTextContent('Place on Lenovo Tiny mount (1U)')
    expect(within(row).getByTestId('equipment-place-eq-pc-shelf-2u')).toBeInTheDocument()

    fireEvent.click(place)
    expect(useEditorState.getState().placing).toEqual({
      kind: 'item',
      itemId: 'lenovo-tiny-mount',
      equipmentId: 'eq-pc',
    })
    expect(place).toHaveAttribute('aria-pressed', 'true')
    expect(row).toHaveTextContent(
      'Placing Lenovo ThinkCentre M720q Tiny on Lenovo Tiny mount: choose a spot in the rack.',
    )
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }))
    expect(useEditorState.getState().placing).toBeNull()
  })

  it('places ear-mounted gear directly', async () => {
    await open(userPlan([{ id: 'eq-pdu', deviceId: 'pdu-4', have: true }]))
    render(<EquipmentTray />)
    const place = await screen.findByTestId('equipment-place-eq-pdu-pdu-4')
    expect(place).toHaveTextContent('Place in the rack (1U)')
    expect(screen.getByTestId('equipment-estimate-eq-pdu')).toHaveTextContent(
      '1U, mounts directly with its own ears',
    )
    fireEvent.click(place)
    expect(useEditorState.getState().placing).toEqual({
      kind: 'device',
      deviceId: 'pdu-4',
      equipmentId: 'eq-pdu',
    })
  })

  it('switches a device between To get and In my rack, and removes it', async () => {
    await open(userPlan())
    render(<EquipmentTray />)
    const row = await screen.findByTestId('equipment-item-eq-pc')
    const group = within(row).getByRole('radiogroup', {
      name: 'Lenovo ThinkCentre M720q Tiny: in my rack or to get',
    })
    expect(within(group).getByRole('radio', { name: 'To get' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    fireEvent.click(within(group).getByRole('radio', { name: 'In my rack' }))
    await waitFor(() => expect(trayEntries().find((e) => e.id === 'eq-pc')?.have).toBe(true))
    expect(screen.getByTestId('equipment-item-eq-pc')).toHaveAttribute('data-have', 'true')
    expect(said()).toBe('Lenovo ThinkCentre M720q Tiny: In my rack.')

    fireEvent.click(screen.getByTestId('equipment-remove-eq-pc'))
    expect(trayEntries().map((entry) => entry.id)).toEqual(['eq-pi'])
    expect(screen.queryByTestId('equipment-item-eq-pc')).toBeNull()
  })

  it('adds a catalog device from the search, owned while recording', async () => {
    const planId = await open(userPlan([]))
    render(<EquipmentTray />)
    expect(await screen.findByTestId('equipment-summary')).toHaveTextContent(
      'Rack 9U · 7U used, 2U free',
    )
    const search = screen.getByRole('searchbox', { name: 'Add a device' })
    fireEvent.change(search, { target: { value: 'raspberry' } })
    expect(screen.getByText('1 device matches.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Add Raspberry Pi 5/ }))
    expect(trayEntries().map((entry) => [entry.deviceId, entry.have])).toEqual([['rpi-5', false]])
    expect(said()).toBe('Added Raspberry Pi 5 to the tray (To get).')

    act(() => useUiStore.getState().setRecordingMode(planId, true))
    fireEvent.change(search, { target: { value: 'poe switch' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(trayEntries().map((entry) => [entry.deviceId, entry.have])).toEqual([
      ['rpi-5', false],
      ['poe-switch-8', true],
    ])
  })

  it('moves between the search field and the matches with the arrow keys', async () => {
    await open(userPlan([]))
    render(<EquipmentTray />)
    const search = await screen.findByRole('searchbox', { name: 'Add a device' })
    fireEvent.change(search, { target: { value: 'fixture' } })
    const matches = within(screen.getByRole('list', { name: 'Matching devices' })).getAllByRole(
      'button',
    )
    expect(matches.length).toBeGreaterThan(1)
    search.focus()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(matches[0]).toHaveFocus()
    fireEvent.keyDown(matches[0] as HTMLElement, { key: 'ArrowDown' })
    expect(matches[1]).toHaveFocus()
    fireEvent.keyDown(matches[1] as HTMLElement, { key: 'Escape' })
    expect(search).toHaveFocus()
  })

  it('keeps unknown devices removable', async () => {
    await open(userPlan([{ id: 'eq-x', deviceId: 'mystery-box', have: true }]))
    render(<EquipmentTray />)
    const row = await screen.findByTestId('equipment-item-eq-x')
    expect(row).toHaveTextContent('Not in the catalog: its size and mounts are unknown.')
    fireEvent.click(within(row).getByRole('button', { name: 'Remove mystery-box from the tray' }))
    expect(trayEntries()).toEqual([])
  })
})
