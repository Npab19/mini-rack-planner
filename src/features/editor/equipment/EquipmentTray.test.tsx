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
import { panelDomId, resetEditorShell, useEditorShell } from '../layout/shellStore'
import { useMountDialogs } from '../mounts/mountDialogsStore'
import { selectInEditor } from '../selection'
import { EquipmentTray } from './EquipmentTray'
import { focusEquipmentEntry } from './focusEquipment'
import { TrayDragContext, type TrayDragSubject, type TrayDraggableComponent } from './trayDrag'

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
  useUiStore.setState({ recordingMode: {}, selection: [] })
  resetEditorShell()
  useMountDialogs.getState().close()
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

/** Kind and Have of each section, bottom to top. */
function stack(): Array<[string, boolean]> {
  return (usePlanStore.getState().plan?.frame.sections ?? []).map((section) => [
    section.typeId,
    section.have !== undefined,
  ])
}

/** The placements the fit added: [mount, y, device in it]. */
function added(): Array<[string, number, string | undefined]> {
  return (usePlanStore.getState().plan?.placements ?? [])
    .filter((placement) => placement.itemId !== 'blank-1u')
    .map((placement) => [placement.itemId, placement.y, placement.devices[0]?.deviceId])
}

describe('EquipmentTray: Fit it for me', () => {
  it('adds only the space it needs and places everything, in one undo step', async () => {
    await open(userPlan())
    render(<EquipmentTray />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fit it for me' }))

    expect(stack()).toEqual([
      ['s3', true],
      ['s6', true],
      ['s3', false],
    ])
    // The 2U shelf for the Pi first (largest first) in the 2U that was free, the M720q above it.
    expect(added()).toEqual([
      ['shelf-2u', 42, 'rpi-5'],
      ['lenovo-tiny-mount', 54, 'lenovo-m720q'],
    ])
    expect(trayEntries()).toEqual([])
    expect(said()).toBe('Placed all 2 devices and added 3U at the top.')
    const note = screen.getByTestId('equipment-fit-result')
    expect(note).toHaveTextContent('Placed all 2 devices and added 3U at the top.')
    // The new parts are selected, and with the tray empty the report takes focus.
    const newIds = (usePlanStore.getState().plan?.placements ?? []).slice(7).map((p) => p.id)
    expect([...useUiStore.getState().selection].toSorted()).toEqual(newIds.toSorted())
    await waitFor(() => expect(note).toHaveFocus())

    act(() => usePlanStore.getState().undo())
    expect(stack()).toHaveLength(2)
    expect(trayEntries().map((entry) => entry.id)).toEqual(['eq-pc', 'eq-pi'])
    // The report goes once the plan changes.
    expect(screen.queryByTestId('equipment-fit-result')).toBeNull()
  })

  it('puts new sections at the bottom when asked', async () => {
    await open(userPlan())
    render(<EquipmentTray />)
    const group = await screen.findByRole('radiogroup', { name: 'New sections go at the' })
    expect(within(group).getByRole('radio', { name: 'top' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    fireEvent.click(within(group).getByRole('radio', { name: 'bottom' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fit it for me' }))
    expect(stack()).toEqual([
      ['s3', false],
      ['s3', true],
      ['s6', true],
    ])
    // The blanks moved up with their sections; the devices took the new bottom section.
    expect(usePlanStore.getState().plan?.placements[0]?.y).toBe(18)
    expect(added()).toEqual([
      ['shelf-2u', 0, 'rpi-5'],
      ['lenovo-tiny-mount', 12, 'lenovo-m720q'],
    ])
    expect(said()).toBe('Placed all 2 devices and added 3U at the bottom.')
  })

  it('marks what it builds In my rack while recording; devices keep their own mark', async () => {
    const planId = await open(userPlan())
    act(() => useUiStore.getState().setRecordingMode(planId, true))
    render(<EquipmentTray />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fit it for me' }))
    expect(stack()).toEqual([
      ['s3', true],
      ['s6', true],
      ['s3', true],
    ])
    const mounts = (usePlanStore.getState().plan?.placements ?? []).slice(7)
    expect(mounts.map((placement) => placement.have !== undefined)).toEqual([true, true])
    expect(mounts.map((placement) => placement.devices[0]?.have)).toEqual([false, false])
    expect(said()).toBe('Placed all 2 devices and added 3U at the top, marked In my rack.')
  })

  it('leaves what it cannot place in the tray, with the reason on its row', async () => {
    await open(
      userPlan([
        { id: 'eq-x', deviceId: 'mystery-box', have: false },
        { id: 'eq-pc', deviceId: 'lenovo-m720q', have: false },
        { id: 'eq-nas', deviceId: 'nas-2bay', have: false },
      ]),
    )
    render(<EquipmentTray />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fit it for me' }))
    expect(added()).toEqual([['lenovo-tiny-mount', 42, 'lenovo-m720q']])
    expect(trayEntries().map((entry) => entry.id)).toEqual(['eq-x', 'eq-nas'])
    const note = screen.getByTestId('equipment-fit-result')
    expect(note).toHaveTextContent('Placed 1 device of 3.')
    expect(note).toHaveTextContent(
      'Fixture 2-bay NAS: No mount in the catalog takes the Fixture 2-bay NAS yet.',
    )
    expect(screen.getByTestId('equipment-left-over-eq-x')).toHaveTextContent(
      'Fit it for me left it here: "mystery-box" is not in the catalog, so its size is unknown.',
    )
    expect(said()).toBe(
      'Placed 1 device of 3. mystery-box is still waiting: "mystery-box" is not in the catalog, so its size is unknown. Fixture 2-bay NAS is still waiting: No mount in the catalog takes the Fixture 2-bay NAS yet.',
    )
    // The button stays while devices are still waiting.
    expect(screen.getByRole('button', { name: 'Fit it for me' })).toBeInTheDocument()
  })
})

describe('EquipmentTray: Needs a mount? and checks', () => {
  it('offers “Needs a mount?” for a device no catalog mount takes', async () => {
    await open(userPlan([{ id: 'eq-nas', deviceId: 'nas-2bay', have: true }]))
    render(<EquipmentTray />)
    const row = await screen.findByTestId('equipment-item-eq-nas')
    expect(row).toHaveTextContent('No mount in the catalog takes it yet.')
    fireEvent.click(within(row).getByRole('button', { name: 'Needs a mount?' }))
    expect(useMountDialogs.getState().needsAMount).toEqual({
      deviceId: 'nas-2bay',
      equipmentId: 'eq-nas',
    })
  })

  it('shows a tray entry chosen from a check as selected and focuses it', async () => {
    await open(userPlan([{ id: 'eq-x', deviceId: 'mystery-box', have: true }]))
    render(
      <div id={panelDomId('equipment')}>
        <EquipmentTray />
      </div>,
    )
    const row = await screen.findByTestId('equipment-item-eq-x')
    expect(row).toHaveAttribute('data-equipment-id', 'eq-x')
    act(() => selectInEditor(['eq-x']))
    expect(row).toHaveAttribute('aria-current', 'true')
    expect(row).toHaveTextContent('Selected')
    expect(focusEquipmentEntry('eq-x')).toBe(true)
    expect(row).toHaveFocus()
    // Ids that are not tray entries are left to the rest of the editor.
    expect(focusEquipmentEntry('pl-blank-1')).toBe(false)
  })

  it('opens the tray sheet first when the tray is not on screen', async () => {
    await open(userPlan([{ id: 'eq-x', deviceId: 'mystery-box', have: true }]))
    expect(focusEquipmentEntry('eq-x')).toBe(true)
    expect(useEditorShell.getState()).toMatchObject({ sheet: 'equipment', sheetOpen: true })
    // The sheet shows the tray: its row takes focus once it is there.
    render(
      <div id={panelDomId('equipment')}>
        <EquipmentTray />
      </div>,
    )
    const row = await screen.findByTestId('equipment-item-eq-x')
    await waitFor(() => expect(row).toHaveFocus())
  })
})

describe('EquipmentTray: dragging onto the rack', () => {
  it('turns each name into a grab handle when the rack provides drags', async () => {
    const subjects: TrayDragSubject[] = []
    const handles = new Map<string, HTMLElement | null>()
    const FakeDraggable: TrayDraggableComponent = ({ subject, disabled, children }) => {
      subjects.push(subject)
      return children({
        ref: (element) => {
          handles.set(subject.equipmentId, element)
        },
        isDragging: subject.equipmentId === 'eq-pi' && !disabled,
      })
    }
    await open(userPlan())
    render(
      <TrayDragContext value={FakeDraggable}>
        <EquipmentTray />
      </TrayDragContext>,
    )
    const handle = await screen.findByTestId('equipment-drag-eq-pc')
    expect(handle).toHaveTextContent('Lenovo ThinkCentre M720q Tiny')
    expect(handles.get('eq-pc')).toBe(handle)
    expect(subjects).toContainEqual({ equipmentId: 'eq-pc', deviceId: 'lenovo-m720q' })
    const dragged = screen.getByTestId('equipment-drag-eq-pi')
    expect(dragged).toHaveAttribute('data-dragging', 'true')
    expect(dragged).toHaveTextContent('(drop it on the rack)')
  })

  it('keeps plain names without it', async () => {
    await open(userPlan())
    render(<EquipmentTray />)
    await screen.findByTestId('equipment-item-eq-pc')
    expect(screen.queryByTestId('equipment-drag-eq-pc')).toBeNull()
  })
})
