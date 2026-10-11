import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDbForTests } from '@/db/db'
import type { Plan } from '@/domain/schema/plan'
import { stopLibrarySync } from '@/state/catalogStore'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { useEditorState } from './editorState'
import { buildPlan, openPlan, ZETA } from './inspector/__fixtures__/editorPlans'
import { placementForId, selectInEditor } from './selection'

/** A front blank and a rear blank on one 3U section, a PC mount holding a device. */
function plan(): Plan {
  const base = buildPlan(
    [{ typeId: 's3', have: true }],
    [
      { id: 'pl-front', itemId: ZETA.blank1u, y: 0 },
      { id: 'pl-rear', itemId: ZETA.blank1u, y: 6 },
      {
        id: 'pl-pc',
        itemId: ZETA.pcMount,
        y: 12,
        devices: [{ id: 'dv-pc', deviceId: ZETA.tinyPc, slotId: 'pc', have: false }],
      },
    ],
  )
  return {
    ...base,
    placements: base.placements.map((placement) =>
      placement.id === 'pl-rear' ? { ...placement, face: 'rear' } : placement,
    ),
  }
}

beforeEach(async () => {
  await resetDbForTests()
  useUiStore.setState({ selection: [], face: 'front', recordingMode: {} })
  useEditorState.getState().reset()
  await openPlan(plan())
})

afterEach(async () => {
  await usePlanStore.getState().unload()
  stopLibrarySync()
})

describe('selectInEditor', () => {
  it('selects, shows the Selection tab and turns the rack to the part’s face', () => {
    useEditorState.getState().setInspectorTab('rack')
    selectInEditor(['pl-rear'])
    expect(useUiStore.getState().selection).toEqual(['pl-rear'])
    expect(useEditorState.getState().inspectorTab).toBe('selection')
    expect(useUiStore.getState().face).toBe('rear')

    // A device selects with its mount's face; a section has no face.
    selectInEditor(['dv-pc'])
    expect(useUiStore.getState().face).toBe('front')
    selectInEditor(['sec-1'])
    expect(useUiStore.getState().face).toBe('front')
    expect(useUiStore.getState().selection).toEqual(['sec-1'])
  })

  it('toggles with Shift/Ctrl-click without turning the rack', () => {
    selectInEditor(['pl-front'])
    selectInEditor(['pl-rear'], { toggle: true })
    expect(useUiStore.getState().selection).toEqual(['pl-front', 'pl-rear'])
    expect(useUiStore.getState().face).toBe('front')
    selectInEditor(['pl-front'], { toggle: true })
    expect(useUiStore.getState().selection).toEqual(['pl-rear'])
  })

  it('leaves the inspector tab alone when the selection ends up empty', () => {
    useEditorState.getState().setInspectorTab('rack')
    selectInEditor([])
    expect(useEditorState.getState().inspectorTab).toBe('rack')
  })

  it('finds the placement an id names, directly or through a device on it', () => {
    const open = usePlanStore.getState().plan
    if (open === null) throw new Error('no plan')
    expect(placementForId(open, 'pl-pc')?.id).toBe('pl-pc')
    expect(placementForId(open, 'dv-pc')?.id).toBe('pl-pc')
    expect(placementForId(open, 'sec-1')).toBeUndefined()
  })
})
