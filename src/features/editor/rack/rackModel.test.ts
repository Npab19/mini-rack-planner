import { describe, expect, it } from 'vitest'
import {
  CATALOG,
  FRAME,
  makePlan,
  RANGE_FRAME,
  USER_SECTIONS,
} from '@/domain/__fixtures__/frameFixtures'
import { createCatalogLookup, catalogBundle } from '@/domain/schema/catalog'
import {
  contentsGroups,
  focusOrder,
  insertGaps,
  insertItemText,
  placementAriaLabel,
  placementView,
  placementViews,
  sectionAriaLabel,
  sectionChoices,
  sectionViews,
} from './rackModel'

/** The user's 3U + 6U (both owned) with a few placements. */
function userPlan() {
  return makePlan({
    sections: USER_SECTIONS,
    placements: [
      { id: 'pl-blank', itemId: 'blank-1u', y: 0, have: true },
      {
        id: 'pl-shelf',
        itemId: 'shelf-1u',
        y: 6,
        devices: [
          { id: 'dv-sbc-1', deviceId: 'test-sbc', slotId: 'deck', have: true },
          { id: 'dv-sbc-2', deviceId: 'test-sbc', slotId: 'deck' },
        ],
      },
      {
        id: 'pl-pc',
        itemId: 'mini-pc-mount-2u',
        y: 18,
        devices: [{ id: 'dv-pc', deviceId: 'test-mini-pc', slotId: 'bay' }],
      },
      { id: 'pl-switch', itemId: 'test-switch', y: 30 },
      { id: 'pl-left', itemId: 'half-bay-1u', y: 36, bay: 'left' },
      { id: 'pl-right', itemId: 'half-bay-1u', y: 36, bay: 'right' },
      { id: 'pl-fan', itemId: 'rear-fan-1u', y: 42, face: 'rear' },
    ],
  })
}

function viewOf(id: string) {
  const plan = userPlan()
  const placement = plan.placements.find((candidate) => candidate.id === id)
  if (placement === undefined) throw new Error(id)
  return placementView(placement, CATALOG)
}

describe('placementView', () => {
  it('describes a mount: name, U range, Have, style', () => {
    const view = viewOf('pl-blank')
    expect(view).toMatchObject({
      name: 'Blank 1U',
      known: true,
      style: 'blank',
      role: 'neutral',
      y: 0,
      heightSixths: 6,
      have: true,
      uStart: 1,
      uEnd: 1,
      position: 'U1',
      holeOffsetsMm: [6.35, 38.1],
    })
  })

  it('packs devices on a shelf left to right at their true front size', () => {
    const view = viewOf('pl-shelf')
    expect(view.style).toBe('tray')
    expect(view.devices).toEqual([
      expect.objectContaining({ id: 'dv-sbc-1', xMm: 6, yMm: 4, wMm: 90, hMm: 25, have: true }),
      // 90 mm wide + the 5 mm gap
      expect.objectContaining({ id: 'dv-sbc-2', xMm: 101, yMm: 4, wMm: 90, hMm: 25, have: false }),
    ])
    expect(view.devices[0]?.name).toBe('Test SBC')
  })

  it('colours a part by what it is for: its devices, else what it accepts', () => {
    // The shelf accepts anything; the SBCs on it make it compute.
    expect(viewOf('pl-shelf').role).toBe('compute')
    expect(viewOf('pl-shelf').devices.map((device) => device.role)).toEqual(['compute', 'compute'])
    expect(viewOf('pl-pc').role).toBe('compute')
    expect(viewOf('pl-switch').role).toBe('network')
    expect(viewOf('pl-fan').role).toBe('neutral')
  })

  it('puts a device in a fixed slot at the slot origin', () => {
    const view = viewOf('pl-pc')
    expect(view.position).toBe('U4–U5')
    expect(view.devices).toEqual([
      expect.objectContaining({ id: 'dv-pc', xMm: 16, yMm: 5, wMm: 179, hMm: 35, known: true }),
    ])
  })

  it('draws ear-mounted gear as a device', () => {
    expect(viewOf('pl-switch')).toMatchObject({ style: 'device', name: 'Test Switch', known: true })
  })

  it('keeps unknown parts as labelled placeholders', () => {
    const plan = makePlan({ sections: USER_SECTIONS })
    const placement = {
      ...plan.placements[0],
      id: 'pl-ghost',
      itemId: 'gone-mount',
      name: 'Old mount',
      heightSixths: 12,
      y: 6,
      face: 'front' as const,
      bay: 'full' as const,
      devices: [{ id: 'dv-x', deviceId: 'gone-device', slotId: 'bay', have: false }],
    }
    const view = placementView(placement, CATALOG)
    expect(view).toMatchObject({
      known: false,
      style: 'unknown',
      role: 'neutral',
      name: 'Old mount',
      heightSixths: 12,
      position: 'U2–U3',
      devices: [],
    })
    expect(placementAriaLabel(view)).toBe('Unknown part: Old mount, U2–U3, To get')
  })

  it('reuses the view of an unchanged placement and redoes a changed one', () => {
    const plan = userPlan()
    const first = placementViews(plan.placements, CATALOG)
    const again = placementViews(plan.placements, CATALOG)
    expect(again[0]).toBe(first[0])
    const moved = plan.placements.map((placement, index) =>
      index === 0 ? { ...placement, y: 48 } : placement,
    )
    const after = placementViews(moved, CATALOG)
    expect(after[0]).not.toBe(first[0])
    expect(after[0]?.y).toBe(48)
    expect(after[1]).toBe(first[1])
    // Another catalog can rename anything: nothing is reused.
    const other = createCatalogLookup(
      catalogBundle([...CATALOG.allItems(), ...CATALOG.allDevices()]),
    )
    expect(placementViews(plan.placements, other)[1]).not.toBe(first[1])
  })
})

describe('accessible names', () => {
  it('reads a placement with its devices and their Have / To get', () => {
    expect(placementAriaLabel(viewOf('pl-shelf'))).toBe(
      'Shelf 1U, U2, To get, holds Test SBC (In my rack), Test SBC (To get)',
    )
    expect(placementAriaLabel(viewOf('pl-left'))).toBe('Half-width 1U, U7, left half, To get')
    expect(placementAriaLabel(viewOf('pl-fan'))).toBe('Rear fan 1U, U8, rear, To get')
  })

  it('reads a section with its range and Have', () => {
    const [bottom, top] = sectionViews(userPlan(), FRAME)
    expect(bottom && sectionAriaLabel(bottom)).toBe('3U section, U1–U3, In my rack')
    expect(top && sectionAriaLabel(top)).toBe('6U section, U4–U9, In my rack')
  })
})

describe('sections, joints and + handles', () => {
  it('lists sections bottom to top with labels and U ranges', () => {
    const plan = makePlan({ sections: [...USER_SECTIONS, { id: 'sec-c', typeId: 's3' }] })
    expect(sectionViews(plan, FRAME)).toEqual([
      expect.objectContaining({
        id: 'sec-a',
        label: '3U section',
        ordinalLabel: 'Section 1 (3U)',
        uStart: 1,
        uEnd: 3,
        have: true,
      }),
      expect.objectContaining({ id: 'sec-b', label: '6U section', uStart: 4, uEnd: 9, have: true }),
      expect.objectContaining({
        id: 'sec-c',
        label: '3U section',
        startSixths: 54,
        endSixths: 72,
        have: false,
      }),
    ])
  })

  it('names range-height sections with their height', () => {
    const plan = makePlan({
      frame: RANGE_FRAME,
      sections: [{ id: 'sec-r', typeId: 'rails', heightU: 12 }],
    })
    expect(sectionViews(plan, RANGE_FRAME)[0]?.label).toBe('Rails 12U')
  })

  it('offers + handles on top, between sections and at the bottom', () => {
    const sections = sectionViews(makePlan({ sections: USER_SECTIONS }), FRAME)
    const gaps = insertGaps(sections)
    expect(gaps.map((gap) => [gap.where, gap.index, gap.ySixths])).toEqual([
      ['top', 2, 54],
      ['between', 1, 18],
      ['bottom', 0, 0],
    ])
    expect(gaps[1]?.label).toBe('Add a section between Section 1 (3U) and Section 2 (6U)')
    expect(gaps[1]?.phrase).toBe('between Section 1 (3U) and Section 2 (6U)')
    expect(insertGaps([])).toEqual([expect.objectContaining({ where: 'top', index: 0 })])
  })

  it('offers each section type, range types at their smallest height', () => {
    expect(sectionChoices(FRAME)).toEqual([
      { typeId: 's3', heightU: 3, label: '3U' },
      { typeId: 's6', heightU: 6, label: '6U' },
    ])
    expect(sectionChoices(RANGE_FRAME)[0]).toEqual({
      typeId: 'rails',
      heightU: 2,
      label: 'Rails 2U',
    })
    const choice = { typeId: 's3', heightU: 3, label: '3U' }
    expect(insertItemText({ where: 'top' }, choice)).toBe('Add 3U above')
    expect(insertItemText({ where: 'bottom' }, choice)).toBe('Add 3U below')
    expect(insertItemText({ where: 'between' }, choice)).toBe('Add 3U here')
  })
})

describe('contents list and focus order', () => {
  it('groups placements under the section holding their bottom edge, top to bottom', () => {
    const plan = makePlan({
      sections: USER_SECTIONS,
      placements: [
        { id: 'pl-low', itemId: 'blank-1u', y: 0 },
        { id: 'pl-high', itemId: 'blank-1u', y: 48 },
        { id: 'pl-mid', itemId: 'blank-1u', y: 24 },
        { id: 'pl-stray', itemId: 'blank-1u', y: 60 },
      ],
    })
    const groups = contentsGroups(
      sectionViews(plan, FRAME),
      placementViews(plan.placements, CATALOG),
    )
    expect(
      groups.map((group) => [group.section?.id, group.placements.map((view) => view.id)]),
    ).toEqual([
      ['sec-b', ['pl-high', 'pl-mid']],
      ['sec-a', ['pl-low']],
      [undefined, ['pl-stray']],
    ])
  })

  it('orders focus top to bottom, left half before right', () => {
    const views = placementViews(userPlan().placements, CATALOG).filter(
      (view) => view.face === 'front',
    )
    expect(focusOrder(views)).toEqual([
      'pl-left',
      'pl-right',
      'pl-switch',
      'pl-pc',
      'pl-shelf',
      'pl-blank',
    ])
  })
})
