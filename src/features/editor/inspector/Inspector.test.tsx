import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDbForTests } from '@/db/db'
import { markPlacement, markSectionContents } from '@/domain/build'
import { stopLibrarySync } from '@/state/catalogStore'
import { resetDbStatusForTests } from '@/state/dbStatus'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { useEditorState } from '../editorState'
import { buildPlan, currentPlan, openPlan, ZETA } from './__fixtures__/editorPlans'
import { Inspector } from './Inspector'

// Spy on the domain marks while keeping their real behaviour.
vi.mock(import('@/domain/build'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    markPlacement: vi.fn(actual.markPlacement),
    markSectionContents: vi.fn(actual.markSectionContents),
  }
})

function select(ids: string[]): void {
  act(() => useUiStore.getState().select(ids))
}

/** The polite live region's text (the inspector's own). */
function announced(): string {
  const regions = screen.getAllByRole('status')
  return regions.map((region) => region.textContent ?? '').join(' | ')
}

beforeEach(async () => {
  await resetDbForTests()
  resetDbStatusForTests()
  useUiStore.setState({ recordingMode: {}, selection: [] })
  useEditorState.getState().reset()
  vi.mocked(markPlacement).mockClear()
  vi.mocked(markSectionContents).mockClear()
})

afterEach(async () => {
  cleanup()
  await usePlanStore.getState().unload()
  stopLibrarySync()
})

describe('Inspector: a placement', () => {
  it('marks it In my rack through markPlacement, with text and icon', async () => {
    const plan = await openPlan(
      buildPlan(
        [
          { typeId: 's3', have: true },
          { typeId: 's6', have: true },
        ],
        [{ id: 'pl-mount', itemId: ZETA.pcMount, y: 0 }],
      ),
    )
    select(['pl-mount'])
    render(<Inspector />)

    expect(screen.getByRole('heading', { name: 'Zeta PC mount 1U' })).toBeInTheDocument()
    expect(screen.getByText('U1 · front')).toBeInTheDocument()
    const toggle = screen.getByTestId('inspector-have-toggle')
    expect(toggle).toHaveAccessibleName('Zeta PC mount 1U: in my rack or to get')
    expect(within(toggle).getByRole('radio', { name: 'To get' })).toHaveAttribute(
      'aria-checked',
      'true',
    )

    fireEvent.click(within(toggle).getByRole('radio', { name: 'In my rack' }))
    expect(markPlacement).toHaveBeenCalledTimes(1)
    expect(markPlacement).toHaveBeenCalledWith(
      expect.objectContaining({ id: plan.id }),
      'pl-mount',
      true,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    )
    expect(currentPlan().placements[0]?.have).toMatchObject({ itemId: ZETA.pcMount })
    expect(within(toggle).getByRole('radio', { name: 'In my rack' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(announced()).toContain('Zeta PC mount 1U: In my rack.')

    // One undo step brings it back.
    act(() => usePlanStore.getState().undo())
    expect(currentPlan().placements[0]?.have).toBeUndefined()
  })

  it('adds a device that fits, and shows why one that does not cannot go in', async () => {
    await openPlan(
      buildPlan([{ typeId: 's3', have: true }], [{ id: 'pl-mount', itemId: ZETA.pcMount, y: 0 }]),
    )
    select(['pl-mount'])
    render(<Inspector />)

    fireEvent.click(screen.getByTestId('inspector-add-device'))
    const search = screen.getByRole('searchbox', { name: 'Search devices for Mini PC' })
    expect(search).toHaveFocus()

    // Blocked: the domain's reason, and nothing changes.
    fireEvent.click(screen.getByTestId(`inspector-device-option-${ZETA.bigPc}`))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The Zeta Big PC (200 × 200 × 50 mm) does not fit Mini PC',
    )
    expect(currentPlan().placements[0]?.devices).toEqual([])

    // Happy path: it goes in, as To get (not recording).
    fireEvent.click(screen.getByTestId(`inspector-device-option-${ZETA.tinyPc}`))
    expect(currentPlan().placements[0]?.devices).toEqual([
      expect.objectContaining({ deviceId: ZETA.tinyPc, slotId: 'pc', have: false }),
    ])
    const devices = screen.getByRole('list', { name: 'Devices in Mini PC' })
    expect(within(devices).getByText('Zeta Tiny PC')).toBeInTheDocument()
    expect(within(devices).getByText('Fits, lying flat')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    // A fixed slot holds one device: no more "Add device".
    expect(screen.queryByTestId('inspector-add-device')).toBeNull()
    expect(announced()).toContain('Added the Zeta Tiny PC to Mini PC.')
  })

  it('offers devices waiting in Equipment to fit first, and moves one in', async () => {
    const base = buildPlan(
      [{ typeId: 's3', have: true }],
      [{ id: 'pl-mount', itemId: ZETA.pcMount, y: 0 }],
    )
    await openPlan({
      ...base,
      equipment: [
        { id: 'eq-tiny', deviceId: ZETA.tinyPc, have: true },
        // Too big for the slot: not offered from the tray.
        { id: 'eq-big', deviceId: ZETA.bigPc, have: false },
      ],
    })
    select(['pl-mount'])
    render(<Inspector />)

    fireEvent.click(screen.getByTestId('inspector-add-device'))
    expect(screen.getByTestId('inspector-tray-option-eq-tiny')).toHaveAccessibleName(
      'From Equipment to fit: Zeta Tiny PC, 179 × 183 × 34.5 mm, In my rack',
    )
    expect(screen.getByTestId(`inspector-device-option-${ZETA.bigPc}`)).toHaveAccessibleName(
      'Zeta Big PC, 200 × 200 × 50 mm, Too big for this slot',
    )
    expect(screen.queryByTestId('inspector-tray-option-eq-big')).toBeNull()
    fireEvent.click(screen.getByTestId('inspector-tray-option-eq-tiny'))
    // It keeps its In my rack and leaves the tray.
    expect(currentPlan().placements[0]?.devices).toEqual([
      expect.objectContaining({ deviceId: ZETA.tinyPc, slotId: 'pc', have: true }),
    ])
    expect(currentPlan().equipment.map((entry) => entry.id)).toEqual(['eq-big'])
    expect(announced()).toContain(
      'Moved the Zeta Tiny PC from Equipment to fit into Mini PC (In my rack).',
    )
  })

  it('adds devices as In my rack while recording, and removes them', async () => {
    const plan = await openPlan(
      buildPlan([{ typeId: 's3', have: true }], [{ id: 'pl-mount', itemId: ZETA.pcMount, y: 0 }]),
    )
    useUiStore.getState().setRecordingMode(plan.id, true)
    select(['pl-mount'])
    render(<Inspector />)

    fireEvent.click(screen.getByTestId('inspector-add-device'))
    fireEvent.click(screen.getByTestId(`inspector-device-option-${ZETA.tinyPc}`))
    expect(currentPlan().placements[0]?.devices).toEqual([
      expect.objectContaining({ deviceId: ZETA.tinyPc, have: true }),
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Remove the Zeta Tiny PC from Mini PC' }))
    expect(currentPlan().placements[0]?.devices).toEqual([])
    // Owned devices go back to the tray instead of disappearing.
    expect(currentPlan().equipment).toEqual([
      expect.objectContaining({ deviceId: ZETA.tinyPc, have: true }),
    ])
  })

  it('moves to a free U, duplicates next to it, and asks before deleting an owned part', async () => {
    await openPlan(
      buildPlan(
        [
          { typeId: 's3', have: true },
          { typeId: 's6', have: true },
        ],
        [{ id: 'pl-blank', itemId: ZETA.blank1u, y: 0, have: true }],
      ),
    )
    select(['pl-blank'])
    render(<Inspector />)

    const move = screen.getByTestId('inspector-move-to-u')
    fireEvent.change(move, { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(currentPlan().placements[0]?.y).toBe(12)
    expect(screen.getByText('U3 · front')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    const placements = currentPlan().placements
    expect(placements).toHaveLength(2)
    expect(placements[1]).toMatchObject({ itemId: ZETA.blank1u, y: 18 })
    expect(placements[1]?.have).toBeUndefined()
    // The copy is selected.
    expect(useUiStore.getState().selection).toEqual([placements[1]?.id])

    select(['pl-blank'])
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete Zeta blank 1U?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(currentPlan().placements.map((placement) => placement.id)).toEqual([placements[1]?.id])
    expect(currentPlan().retired).toEqual([expect.objectContaining({ kind: 'placement' })])
    // Nothing selected any more: the Rack tab shows, and keyboard focus lands on its heading.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'KWS Rack v2' })).toHaveFocus())
  })
})

describe('Inspector: picking from its own lists', () => {
  it('opens a section from the stack list and a part from the section, focus following', async () => {
    await openPlan(
      buildPlan(
        [
          { typeId: 's3', have: true },
          { id: 'sec-top', typeId: 's6' },
        ],
        [{ id: 'pl-mount', itemId: ZETA.pcMount, y: 18 }],
      ),
    )
    render(<Inspector />)

    fireEvent.click(screen.getByRole('button', { name: 'Select 6U section, U4–U9' }))
    expect(useUiStore.getState().selection).toEqual(['sec-top'])
    const sectionHeading = await screen.findByRole('heading', { name: '6U section' })
    await waitFor(() => expect(sectionHeading).toHaveFocus())
    expect(screen.getByRole('tab', { name: 'Selection' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('button', { name: /^Zeta PC mount 1U U4 · front/ }))
    expect(useUiStore.getState().selection).toEqual(['pl-mount'])
    const partHeading = await screen.findByRole('heading', { name: 'Zeta PC mount 1U' })
    await waitFor(() => expect(partHeading).toHaveFocus())
  })
})

describe('Inspector: a section', () => {
  it('marks everything in the section as In my rack', async () => {
    await openPlan(
      buildPlan(
        [
          { typeId: 's3', have: true },
          { id: 'sec-new', typeId: 's6' },
        ],
        [{ id: 'pl-mount', itemId: ZETA.pcMount, y: 18 }],
      ),
    )
    select(['sec-new'])
    render(<Inspector />)

    expect(screen.getByRole('heading', { name: '6U section' })).toBeInTheDocument()
    expect(screen.getByText('Section 2 (6U) · U4–U9 · top')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Mark everything in this section as In my rack' }),
    )
    expect(markSectionContents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'kws-rack-v2' }),
      'sec-new',
      true,
      expect.any(String),
    )
    const plan = currentPlan()
    expect(plan.frame.sections[1]?.have).toMatchObject({ typeId: 's6' })
    expect(plan.placements[0]?.have).toBeDefined()
    expect(announced()).toContain('Marked 6U section, U4–U9 and 1 part on it as In my rack.')
  })

  it('shows the Rack tab when nothing is selected', async () => {
    await openPlan(buildPlan([{ typeId: 's3', have: true }]))
    render(<Inspector />)
    expect(screen.getByRole('tab', { name: 'Rack' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Selection' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('heading', { name: 'KWS Rack v2' })).toBeInTheDocument()
  })

  it('marks several selected things at once', async () => {
    await openPlan(
      buildPlan(
        [{ typeId: 's3' }, { typeId: 's6' }],
        [{ id: 'pl-blank', itemId: ZETA.blank1u, y: 0 }],
      ),
    )
    select(['sec-1', 'pl-blank'])
    render(<Inspector />)
    expect(screen.getByRole('heading', { name: '2 selected' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mark all as In my rack' }))
    const plan = currentPlan()
    expect(plan.frame.sections[0]?.have).toBeDefined()
    expect(plan.frame.sections[1]?.have).toBeUndefined()
    expect(plan.placements[0]?.have).toBeDefined()
  })
})

describe('Inspector: Rack tab', () => {
  it('sets the height to 12U on top: a 3U [have] + 6U [have] rack gets a planned 3U', async () => {
    await openPlan(
      buildPlan([
        { typeId: 's3', have: true },
        { typeId: 's6', have: true },
      ]),
    )
    render(<Inspector />)

    const height = screen.getByTestId('rack-tab-set-height')
    expect(height).toHaveValue('12')
    fireEvent.change(height, { target: { value: '12' } })
    expect(screen.getByRole('radio', { name: 'At the top' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByText('9U → 12U: adds 1 section (3U) on top.')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('rack-tab-apply-height'))

    const sections = currentPlan().frame.sections
    expect(sections.map((section) => [section.typeId, section.have !== undefined])).toEqual([
      ['s3', true],
      ['s6', true],
      ['s3', false],
    ])
    const added = sections[2]?.id ?? ''
    expect(screen.getByTestId(`stack-row-${added}`)).toHaveTextContent('3U sectionU10–U12 · top')
    expect(screen.getByTestId('stack-summary')).toHaveTextContent('3U + 6U + 3U · 12U')
    expect(announced()).toContain('The rack is now 12U.')
  })

  it('adds the new section at the bottom when asked', async () => {
    await openPlan(
      buildPlan([
        { typeId: 's3', have: true },
        { typeId: 's6', have: true },
      ]),
    )
    render(<Inspector />)
    fireEvent.click(screen.getByRole('radio', { name: 'At the bottom' }))
    expect(screen.getByText('9U → 12U: adds 1 section (3U) at the bottom.')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('rack-tab-apply-height'))
    expect(
      currentPlan().frame.sections.map((section) => [section.typeId, section.have !== undefined]),
    ).toEqual([
      ['s3', false],
      ['s3', true],
      ['s6', true],
    ])
  })

  it('marks a stack row and adds a section on top in Recording mode as In my rack', async () => {
    const plan = await openPlan(buildPlan([{ id: 'sec-a', typeId: 's3' }]))
    useUiStore.getState().setRecordingMode(plan.id, true)
    render(<Inspector />)

    const row = screen.getByTestId('stack-row-sec-a')
    fireEvent.click(within(row).getByRole('radio', { name: 'In my rack' }))
    expect(currentPlan().frame.sections[0]?.have).toMatchObject({ typeId: 's3', heightU: 3 })

    fireEvent.click(screen.getByRole('button', { name: '6U on top' }))
    expect(currentPlan().frame.sections.map((section) => section.have?.typeId)).toEqual([
      's3',
      's6',
    ])
  })

  it('re-runs a blocked move with the policy chosen in the conflict dialog', async () => {
    await openPlan(
      buildPlan(
        [
          { id: 'sec-a', typeId: 's3' },
          { id: 'sec-b', typeId: 's3' },
          { id: 'sec-c', typeId: 's3' },
        ],
        // 2U across the joint between the first two sections (U3–U4).
        [{ id: 'pl-blank', itemId: ZETA.blank2u, y: 12 }],
      ),
    )
    render(<Inspector />)

    fireEvent.click(screen.getByRole('button', { name: 'Move 3U section, U7–U9 down' }))
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText(/^Zeta blank 2U spans Section 1 \(3U\) and Section 2/),
    ).toBeInTheDocument()
    // Nothing changed yet.
    expect(currentPlan().frame.sections.map((section) => section.id)).toEqual([
      'sec-a',
      'sec-b',
      'sec-c',
    ])

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Move them with the upper section' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(currentPlan().frame.sections.map((section) => section.id)).toEqual([
      'sec-a',
      'sec-c',
      'sec-b',
    ])
    // It moved with the section above the joint (sec-b, now U7–U9): U6–U7.
    expect(currentPlan().placements[0]?.y).toBe(30)
  })

  it('removes a planned section with what is on it once the dialog says so', async () => {
    await openPlan(
      buildPlan(
        [{ typeId: 's3', have: true }, { typeId: 's6', have: true }, { typeId: 's3' }],
        [{ id: 'pl-top', itemId: ZETA.blank1u, y: 54 }],
      ),
    )
    render(<Inspector />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove 3U section, U10–U12' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Section 3 (3U) still holds Zeta blank 1U.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(currentPlan().frame.sections).toHaveLength(3)

    fireEvent.click(screen.getByRole('button', { name: 'Remove 3U section, U10–U12' }))
    const again = await screen.findByRole('dialog')
    fireEvent.click(within(again).getByRole('button', { name: 'Remove them too' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(currentPlan().frame.sections).toHaveLength(2)
    expect(currentPlan().placements).toEqual([])
  })

  it('explains an owned section cannot be removed, and offers Retire instead', async () => {
    await openPlan(
      buildPlan([
        { typeId: 's3', have: true },
        { typeId: 's6', have: true },
      ]),
    )
    render(<Inspector />)
    expect(screen.queryByRole('button', { name: 'Remove 6U section, U4–U9' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retire 6U section, U4–U9' }))
    expect(currentPlan().frame.sections).toHaveLength(1)
    expect(currentPlan().retired).toEqual([expect.objectContaining({ kind: 'section' })])
  })
})
