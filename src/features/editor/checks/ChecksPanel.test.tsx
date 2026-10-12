import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDbForTests } from '@/db/db'
import { createPlan } from '@/db/plansRepo'
import type { Plan } from '@/domain/schema/plan'
import { kwsPlan } from '@/domain/__fixtures__/kws'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { useEditorState } from '../editorState'
import { clearAnnouncement, useEditorAnnouncer } from '../layout/announcer'
import { resetEditorShell, useEditorShell } from '../layout/shellStore'
import { ChecksPanel } from './ChecksPanel'

vi.mock(import('@/state/catalogStore'), async (importOriginal) => {
  const actual = await importOriginal()
  const { kwsCatalog } = await import('@/domain/__fixtures__/kws')
  const lookup = kwsCatalog()
  return { ...actual, useCatalog: () => ({ lookup, revision: 0, problems: [] }) }
})

async function open(plan: Plan): Promise<void> {
  const stored = await createPlan(plan)
  await act(async () => {
    await usePlanStore.getState().load(stored.id)
  })
}

/** What the editor's live region says now. */
function said(): string {
  return useEditorAnnouncer.getState().message.trim()
}

beforeEach(async () => {
  await resetDbForTests()
  clearAnnouncement()
  useUiStore.getState().clearSelection()
  useEditorState.getState().reset()
  resetEditorShell()
})

afterEach(async () => {
  cleanup()
  await usePlanStore.getState().unload()
})

describe('ChecksPanel', () => {
  it('says "No problems found" for a clean plan and still shows the power summary', async () => {
    await open(kwsPlan({ sections: [3, 6] }))
    render(<ChecksPanel />)
    expect(await screen.findByTestId('checks-empty')).toHaveTextContent('No problems found')
    expect(screen.getByTestId('checks-summary')).toHaveTextContent('No problems found')
    expect(
      within(screen.getByTestId('checks-power')).getByText('not known yet'),
    ).toBeInTheDocument()
  })

  it('groups problems with icons and words, and selects the part a check points at', async () => {
    await open(
      kwsPlan({
        sections: [6],
        placements: [
          { id: 'pl-a', itemId: 'lenovo-tiny-mount', y: 0 },
          { id: 'pl-b', itemId: 'lenovo-tiny-mount', y: 0 },
        ],
      }),
    )
    useEditorState.getState().setInspectorTab('rack')
    render(<ChecksPanel />)
    const errors = await screen.findByRole('heading', { level: 3, name: /^Errors/ })
    expect(errors).toHaveTextContent('Errors(2)')
    const overlaps = screen.getAllByTestId('checks-item-overlap')
    expect(overlaps).toHaveLength(2)
    expect(overlaps[0]).toHaveAccessibleName(
      'Error: Lenovo Tiny mount @U1 overlaps Lenovo Tiny mount @U1. Show',
    )

    fireEvent.click(overlaps[1] as HTMLElement)
    expect(useUiStore.getState().selection).toEqual(['pl-b'])
    expect(useEditorState.getState().inspectorTab).toBe('selection')
    await waitFor(() =>
      expect(screen.getAllByTestId('checks-item-overlap')[1]).toHaveAttribute(
        'aria-current',
        'true',
      ),
    )
    expect(said()).toBe('Selected Lenovo Tiny mount @U1.')
  })

  it('shows stack problems and checks without a target as plain rows', async () => {
    await open(kwsPlan({ sections: [] }))
    render(<ChecksPanel />)
    const empty = await screen.findByTestId('checks-item-empty-stack')
    expect(empty.tagName).toBe('LI')
    expect(empty).toHaveTextContent('The rack has no sections yet.')
    expect(screen.getByTestId('checks-summary')).toHaveTextContent('1 warning')
  })

  it('compares the outlets the plan needs with its power strip', async () => {
    await open(
      kwsPlan({
        sections: [6],
        placements: [{ id: 'pl-pdu', itemId: 'pdu-4', y: 0 }],
        equipment: [
          { id: 'eq-pc', deviceId: 'lenovo-m720q' },
          { id: 'eq-nas', deviceId: 'nas-2bay' },
          { id: 'eq-pi', deviceId: 'rpi-5' },
        ],
      }),
    )
    render(<ChecksPanel />)
    const ac = await screen.findByTestId('checks-power-ac')
    expect(ac).toHaveTextContent('AC outlets5 needed · 4 available1 short')
    expect(screen.getByTestId('checks-item-power-ac')).toHaveTextContent(
      'The plan needs 5 AC outlets (wall-plug bricks take 2); its power strips have 4.',
    )
    expect(screen.getByTestId('checks-power-draw')).toHaveTextContent(
      'about 38 W typical · up to 132 W',
    )
  })

  it('points a check on a tray device at its row in Equipment to fit', async () => {
    await open(
      kwsPlan({ sections: [6], equipment: [{ id: 'eq-gone', deviceId: 'no-such-device' }] }),
    )
    render(<ChecksPanel />)
    const unknown = await screen.findByTestId('checks-item-unknown-part')
    fireEvent.click(unknown)
    expect(useUiStore.getState().selection).toEqual(['eq-gone'])
    // The tray is not on screen here (below lg it is a sheet): its sheet opens.
    expect(useEditorShell.getState()).toMatchObject({ sheet: 'equipment', sheetOpen: true })
  })
})
