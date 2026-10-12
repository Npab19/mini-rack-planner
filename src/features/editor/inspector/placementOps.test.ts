import { describe, expect, it } from 'vitest'
import {
  BLANK_1U,
  CATALOG,
  FRAME,
  HALF_BAY_1U,
  makePlan,
  MINI_PC,
  PC_MOUNT_2U,
  USER_SECTIONS,
} from '@/domain/__fixtures__/frameFixtures'
import { duplicateNear, resolveSelection } from './placementOps'

describe('duplicateNear', () => {
  it('puts the copy right above when that is free, reset to To get', () => {
    const plan = makePlan({
      sections: [...USER_SECTIONS],
      placements: [
        {
          id: 'pc',
          itemId: PC_MOUNT_2U.id,
          y: 0,
          have: true,
          devices: [{ id: 'dev', deviceId: MINI_PC.id, slotId: 'bay', have: true }],
        },
      ],
    })
    const result = duplicateNear(plan, CATALOG, FRAME, 'pc')
    if (typeof result === 'string') throw new Error(result)
    const copy = result.plan.placements.find((placement) => placement.id === result.placementId)
    expect(copy).toMatchObject({ itemId: PC_MOUNT_2U.id, y: 12 })
    expect(copy?.have).toBeUndefined()
    expect(copy?.devices).toEqual([
      expect.objectContaining({ deviceId: MINI_PC.id, slotId: 'bay', have: false }),
    ])
  })

  it('takes the nearest free spot when the one above is taken', () => {
    const plan = makePlan({
      sections: [...USER_SECTIONS],
      placements: [
        { id: 'a', itemId: BLANK_1U.id, y: 24 },
        { id: 'b', itemId: BLANK_1U.id, y: 30 },
      ],
    })
    const result = duplicateNear(plan, CATALOG, FRAME, 'a')
    if (typeof result === 'string') throw new Error(result)
    expect(result.plan.placements.find((p) => p.id === result.placementId)?.y).toBe(18)
  })

  it('uses the other half for a half-width part', () => {
    const plan = makePlan({
      sections: [...USER_SECTIONS],
      placements: [
        { id: 'l', itemId: HALF_BAY_1U.id, y: 0, bay: 'left' },
        { id: 'above', itemId: BLANK_1U.id, y: 6 },
      ],
    })
    const result = duplicateNear(plan, CATALOG, FRAME, 'l')
    if (typeof result === 'string') throw new Error(result)
    expect(result.plan.placements.find((p) => p.id === result.placementId)).toMatchObject({
      y: 0,
      bay: 'right',
    })
  })

  it('says so when there is no room', () => {
    const plan = makePlan({
      sections: [{ id: 's', typeId: 's3' }],
      placements: [0, 6, 12].map((y) => ({ id: `b${y}`, itemId: BLANK_1U.id, y })),
    })
    expect(duplicateNear(plan, CATALOG, FRAME, 'b0')).toBe(
      'There is no free spot for another Blank 1U on the front of the rack.',
    )
    expect(duplicateNear(plan, CATALOG, FRAME, 'gone')).toBe('That part is no longer in the plan.')
  })
})

describe('resolveSelection', () => {
  const plan = makePlan({
    sections: [...USER_SECTIONS],
    placements: [
      {
        id: 'pc',
        itemId: PC_MOUNT_2U.id,
        y: 0,
        devices: [{ id: 'dev', deviceId: MINI_PC.id, slotId: 'bay' }],
      },
      { id: 'blank', itemId: BLANK_1U.id, y: 12 },
    ],
  })

  it('resolves placements, sections and devices (to their placement)', () => {
    expect(resolveSelection(plan, [])).toEqual({ kind: 'none' })
    expect(resolveSelection(plan, ['stale'])).toEqual({ kind: 'none' })
    expect(resolveSelection(plan, ['blank'])).toMatchObject({
      kind: 'placement',
      placement: { id: 'blank' },
    })
    expect(resolveSelection(plan, ['dev'])).toMatchObject({
      kind: 'placement',
      placement: { id: 'pc' },
      deviceEntryId: 'dev',
    })
    expect(resolveSelection(plan, ['sec-b'])).toMatchObject({
      kind: 'section',
      section: { id: 'sec-b' },
    })
  })

  it('makes a multi-selection of distinct things, ignoring stale ids', () => {
    const multi = resolveSelection(plan, ['pc', 'dev', 'sec-a', 'stale', 'blank'])
    expect(multi.kind).toBe('multi')
    if (multi.kind !== 'multi') return
    expect(multi.placements.map((placement) => placement.id)).toEqual(['pc', 'blank'])
    expect(multi.sections.map((section) => section.id)).toEqual(['sec-a'])
    // A placement and one of its devices are one thing.
    expect(resolveSelection(plan, ['pc', 'dev'])).toMatchObject({ kind: 'placement' })
  })

  it('leaves out tray entries (a check can select one): the Rack tab shows instead', () => {
    const withTray = { ...plan, equipment: [{ id: 'eq-1', deviceId: MINI_PC.id, have: false }] }
    expect(resolveSelection(withTray, ['eq-1'])).toEqual({ kind: 'none' })
    expect(resolveSelection(withTray, ['eq-1', 'blank'])).toMatchObject({
      kind: 'placement',
      placement: { id: 'blank' },
    })
  })
})
