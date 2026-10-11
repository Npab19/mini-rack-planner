import { describe, expect, it } from 'vitest'
import {
  CATALOG,
  FRAME,
  makePlan,
  NOW,
  USER_SECTIONS,
  type PlacementSpec,
} from '@/domain/__fixtures__/frameFixtures'
import type { Plan } from '@/domain/schema/plan'
import {
  addedPlacementId,
  addedSectionId,
  buildDuplicate,
  buildPlacement,
  checkMove,
  checkSpot,
  describeSource,
  duplicateSpot,
  firstSpot,
  placementPhases,
  spotAt,
  steppedSpot,
  stepTarget,
  validSpots,
} from './placeActions'

/** The user's 3U + 6U (9U) with a blank at U1 and a 2U mini PC mount at U4–U5. */
function plan(extra: readonly PlacementSpec[] = []): Plan {
  return makePlan({
    sections: USER_SECTIONS,
    placements: [
      { id: 'pl-blank', itemId: 'blank-1u', y: 0, have: true },
      { id: 'pl-pc', itemId: 'mini-pc-mount-2u', y: 18 },
      ...extra,
    ],
  })
}

function withTray(base: Plan, deviceId: string, have: boolean): Plan {
  return { ...base, equipment: [...base.equipment, { id: 'eq-1', deviceId, have }] }
}

function placement(p: Plan, id: string) {
  const found = p.placements.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no ${id}`)
  return found
}

describe('describeSource', () => {
  it('describes a mount: name, height, phases, faces, width', () => {
    expect(
      describeSource(plan(), CATALOG, FRAME, { kind: 'item', itemId: 'blank-1u' }),
    ).toMatchObject({
      itemId: 'blank-1u',
      name: 'Blank 1U',
      heightSixths: 6,
      phases: [0],
      faces: ['front', 'rear'],
      half: false,
      devices: [],
    })
    expect(
      describeSource(plan(), CATALOG, FRAME, { kind: 'item', itemId: 'half-u-panel' }),
    ).toMatchObject({ heightSixths: 3, phases: [0, 3] })
    expect(
      describeSource(plan(), CATALOG, FRAME, { kind: 'item', itemId: 'half-bay-1u' }).half,
    ).toBe(true)
  })

  it('places ear-mounted gear directly, and says when a device needs a mount', () => {
    const gear = describeSource(plan(), CATALOG, FRAME, { kind: 'device', deviceId: 'test-switch' })
    expect(gear).toMatchObject({ itemId: 'test-switch', name: 'Test Switch', faces: ['front'] })
    expect(gear.problem).toBeUndefined()
    expect(
      describeSource(plan(), CATALOG, FRAME, { kind: 'device', deviceId: 'test-mini-pc' }).problem,
    ).toBe('The Test Mini PC does not mount on the rails by itself: place a mount for it instead.')
  })

  it('explains unknown ids and accessories', () => {
    expect(describeSource(plan(), CATALOG, FRAME, { kind: 'item', itemId: 'gone' }).problem).toBe(
      '"gone" is not in the catalog.',
    )
    expect(
      describeSource(plan(), CATALOG, FRAME, { kind: 'item', itemId: 'rubber-feet' }).problem,
    ).toBe('Rubber feet is an accessory: it does not take rack space.')
  })

  it('counts the tray device going onto the mount (shelf heights)', () => {
    const info = describeSource(withTray(plan(), 'test-mini-pc', true), CATALOG, FRAME, {
      kind: 'item',
      itemId: 'mini-pc-mount-2u',
      equipmentId: 'eq-1',
    })
    expect(info.devices).toEqual([
      expect.objectContaining({ deviceId: 'test-mini-pc', slotId: 'bay', have: true }),
    ])
  })
})

describe('spots', () => {
  const blank = describeSource(plan(), CATALOG, FRAME, { kind: 'item', itemId: 'blank-1u' })
  const half = describeSource(plan(), CATALOG, FRAME, { kind: 'item', itemId: 'half-bay-1u' })

  it('snaps a pointer to the allowed starts and picks a bay for half-width items', () => {
    expect(spotAt(blank, 25.2, 'front', 'right')).toEqual({ y: 24, face: 'front', bay: 'full' })
    expect(spotAt(half, 31, 'rear', 'left')).toEqual({ y: 30, face: 'rear', bay: 'left' })
  })

  it('says why a spot is taken, outside the rack or not for this item', () => {
    expect(checkSpot(plan(), CATALOG, FRAME, blank, { y: 30, face: 'front', bay: 'full' })).toEqual(
      {
        ok: true,
        reasons: [],
      },
    )
    const taken = checkSpot(plan(), CATALOG, FRAME, blank, { y: 18, face: 'front', bay: 'full' })
    expect(taken.ok).toBe(false)
    expect(taken.reasons).toEqual(['It overlaps Mini PC mount 2U (U4–U5).'])
    const outside = checkSpot(plan(), CATALOG, FRAME, blank, { y: 54, face: 'front', bay: 'full' })
    expect(outside.reasons).toEqual(['It would reach above U9, the top of the rack.'])
    const pc = describeSource(plan(), CATALOG, FRAME, { kind: 'device', deviceId: 'test-mini-pc' })
    expect(checkSpot(plan(), CATALOG, FRAME, pc, { y: 30, face: 'front', bay: 'full' })).toEqual({
      ok: false,
      reasons: [pc.problem],
    })
  })

  it('lists every free start on a face, bottom to top', () => {
    const spots = validSpots(plan(), CATALOG, FRAME, blank, 'front')
    expect(spots.map((spot) => spot.y)).toEqual([6, 12, 30, 36, 42, 48])
    expect(spots.every((spot) => spot.face === 'front' && spot.bay === 'full')).toBe(true)
    const halves = validSpots(plan(), CATALOG, FRAME, half, 'front')
    expect(halves.slice(0, 2)).toEqual([
      { y: 6, face: 'front', bay: 'left' },
      { y: 6, face: 'front', bay: 'right' },
    ])
    const rearFan = describeSource(plan(), CATALOG, FRAME, { kind: 'item', itemId: 'rear-fan-1u' })
    expect(validSpots(plan(), CATALOG, FRAME, rearFan, 'front')).toEqual([])
  })

  it('starts the keyboard ghost at the lowest free spot and steps it inside the stack', () => {
    const start = firstSpot(plan(), CATALOG, FRAME, blank, 'front')
    expect(start).toEqual({ y: 6, face: 'front', bay: 'full' })
    expect(steppedSpot(start, blank, 54, 1, 1)?.y).toBe(12)
    expect(steppedSpot(start, blank, 54, 1, 5)?.y).toBe(36)
    // Five steps up from U8 only go as far as the top (U9).
    expect(steppedSpot({ ...start, y: 42 }, blank, 54, 1, 5)?.y).toBe(48)
    expect(steppedSpot({ ...start, y: 48 }, blank, 54, 1, 1)).toBeNull()
    expect(steppedSpot({ ...start, y: 0 }, blank, 54, -1, 1)).toBeNull()
  })
})

describe('moving', () => {
  it('steps by the allowed starts', () => {
    expect(stepTarget(18, [0], 1, 1)).toBe(24)
    expect(stepTarget(18, [0], -1, 5)).toBe(-12)
    expect(stepTarget(15, [0, 3], 1, 1)).toBe(18)
    expect(stepTarget(15, [0, 3], -1, 2)).toBe(9)
    // From an off-grid start, the first step lands on the grid.
    expect(stepTarget(14, [0], 1, 1)).toBe(18)
    expect(stepTarget(14, [], -1, 1)).toBe(12)
  })

  it('knows the phases of placed items, unknown ones from their stored height', () => {
    const p = plan()
    expect(placementPhases(placement(p, 'pl-blank'), CATALOG, FRAME)).toEqual([0])
    const unknown = { ...placement(p, 'pl-blank'), itemId: 'gone', heightSixths: 3 }
    expect(placementPhases(unknown, CATALOG, FRAME)).toEqual([0, 3])
  })

  it('checks a move without the item blocking itself', () => {
    const p = plan()
    expect(checkMove(p, CATALOG, FRAME, placement(p, 'pl-pc'), 24).ok).toBe(true)
    const blocked = checkMove(p, CATALOG, FRAME, placement(p, 'pl-blank'), 6)
    expect(blocked.ok).toBe(true)
    const into = checkMove(p, CATALOG, FRAME, placement(p, 'pl-blank'), 18)
    expect(into).toEqual({ ok: false, reasons: ['It overlaps Mini PC mount 2U (U4–U5).'] })
  })
})

describe('duplicating', () => {
  it('puts the copy at the nearest free spot above', () => {
    const p = plan()
    expect(duplicateSpot(p, CATALOG, FRAME, placement(p, 'pl-blank'))).toEqual({
      y: 6,
      face: 'front',
      bay: 'full',
    })
    // Above the 2U mount everything is free.
    expect(duplicateSpot(p, CATALOG, FRAME, placement(p, 'pl-pc'))?.y).toBe(30)
  })

  it('goes below when the top is full, and gives up when the rack is full', () => {
    const p = plan([{ id: 'pl-top', itemId: 'blank-2u', y: 42 }])
    expect(duplicateSpot(p, CATALOG, FRAME, placement(p, 'pl-top'))?.y).toBe(30)
    const full = makePlan({
      sections: [{ id: 'sec-a', typeId: 's3' }],
      placements: [
        { id: 'pl-a', itemId: 'blank-2u', y: 0 },
        { id: 'pl-b', itemId: 'blank-1u', y: 12 },
      ],
    })
    expect(duplicateSpot(full, CATALOG, FRAME, placement(full, 'pl-b'))).toBeNull()
  })

  it('fills the other half of the U first for half-width items', () => {
    const p = plan([{ id: 'pl-half', itemId: 'half-bay-1u', y: 36, bay: 'left' }])
    expect(duplicateSpot(p, CATALOG, FRAME, placement(p, 'pl-half'))).toEqual({
      y: 36,
      face: 'front',
      bay: 'right',
    })
  })

  it('copies as To get, or as In my rack (with its devices) in Recording mode', () => {
    const p = plan([
      {
        id: 'pl-shelf',
        itemId: 'shelf-1u',
        y: 30,
        have: true,
        devices: [{ id: 'dv-1', deviceId: 'test-sbc', slotId: 'deck', have: true }],
      },
    ])
    const spot = { y: 36, face: 'front' as const, bay: 'full' as const }
    const planned = buildDuplicate(p, CATALOG, 'pl-shelf', spot, false, NOW)
    const copy = placement(planned.plan, planned.placementId ?? '')
    expect(copy).toMatchObject({ itemId: 'shelf-1u', y: 36 })
    expect(copy.have).toBeUndefined()
    expect(copy.devices.map((device) => device.have)).toEqual([false])

    const recorded = buildDuplicate(p, CATALOG, 'pl-shelf', spot, true, NOW)
    const owned = placement(recorded.plan, recorded.placementId ?? '')
    expect(owned.have).toMatchObject({ at: NOW, itemId: 'shelf-1u' })
    expect(owned.devices.map((device) => device.have)).toEqual([true])
    expect(buildDuplicate(p, CATALOG, 'nope', spot, false, NOW).error).toBe(
      'There is nothing to copy.',
    )
  })
})

describe('buildPlacement', () => {
  const at = NOW

  it('adds a planned (To get) mount and returns its id', () => {
    const p = plan()
    const result = buildPlacement(p, CATALOG, FRAME, {
      source: { kind: 'item', itemId: 'blank-1u' },
      spot: { y: 30, face: 'front', bay: 'full' },
      have: false,
      at,
    })
    expect(result.error).toBeUndefined()
    expect(result.placementId).toBe(addedPlacementId(p, result.plan))
    const added = placement(result.plan, result.placementId ?? '')
    expect(added).toMatchObject({ itemId: 'blank-1u', y: 30, face: 'front', bay: 'full' })
    expect(added.have).toBeUndefined()
  })

  it('marks it In my rack in the same result in Recording mode', () => {
    const result = buildPlacement(plan(), CATALOG, FRAME, {
      source: { kind: 'item', itemId: 'shelf-1u' },
      spot: { y: 30, face: 'front', bay: 'full' },
      have: true,
      at,
    })
    expect(placement(result.plan, result.placementId ?? '').have).toMatchObject({
      at,
      itemId: 'shelf-1u',
    })
  })

  it('places ear-mounted gear from the palette by its device id', () => {
    const result = buildPlacement(plan(), CATALOG, FRAME, {
      source: { kind: 'device', deviceId: 'test-switch' },
      spot: { y: 36, face: 'front', bay: 'full' },
      have: false,
      at,
    })
    expect(placement(result.plan, result.placementId ?? '')).toMatchObject({
      itemId: 'test-switch',
      y: 36,
    })
  })

  it('moves a tray device onto the new mount and off the tray', () => {
    const p = withTray(plan(), 'test-sbc', true)
    const result = buildPlacement(p, CATALOG, FRAME, {
      source: { kind: 'item', itemId: 'shelf-1u', equipmentId: 'eq-1' },
      spot: { y: 30, face: 'front', bay: 'full' },
      have: false,
      at,
    })
    expect(result.error).toBeUndefined()
    expect(result.plan.equipment).toEqual([])
    const mount = placement(result.plan, result.placementId ?? '')
    expect(mount.devices).toEqual([
      expect.objectContaining({ deviceId: 'test-sbc', slotId: 'deck', have: true }),
    ])
    // The mount itself is new, so still To get (outside Recording mode).
    expect(mount.have).toBeUndefined()
  })

  it('keeps owned ear-mounted gear from the tray In my rack', () => {
    const p = withTray(plan(), 'test-switch', true)
    const result = buildPlacement(p, CATALOG, FRAME, {
      source: { kind: 'device', deviceId: 'test-switch', equipmentId: 'eq-1' },
      spot: { y: 36, face: 'front', bay: 'full' },
      have: false,
      at,
    })
    expect(result.plan.equipment).toEqual([])
    expect(placement(result.plan, result.placementId ?? '').have).toMatchObject({ at })
  })

  it('returns the domain error and the plan untouched when the tray entry is gone', () => {
    const p = plan()
    const result = buildPlacement(p, CATALOG, FRAME, {
      source: { kind: 'item', itemId: 'shelf-1u', equipmentId: 'eq-missing' },
      spot: { y: 30, face: 'front', bay: 'full' },
      have: false,
      at,
    })
    expect(result.plan).toBe(p)
    expect(result.error).toBe('There is no "eq-missing" in Equipment to fit.')
  })
})

describe('what an edit added', () => {
  it('finds the new placement and the new section', () => {
    const before = plan()
    const after = makePlan({
      sections: [...USER_SECTIONS, { id: 'sec-new', typeId: 's3' }],
      placements: [{ id: 'pl-new', itemId: 'blank-1u', y: 0 }],
    })
    expect(addedPlacementId(before, after)).toBe('pl-new')
    expect(addedSectionId(before, after)).toBe('sec-new')
    expect(addedSectionId(before, before)).toBeUndefined()
  })
})
