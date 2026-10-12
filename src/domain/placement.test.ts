import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import {
  BLANK_1U,
  BLANK_2U,
  CATALOG,
  DEAD_ZONE_FRAME,
  FRAME,
  HALF_BAY_1U,
  HALF_U_PANEL,
  makePlan,
  MINI_PC,
  NAS,
  NOW,
  PC_MOUNT_2U,
  SBC,
  SHELF_1U,
  STRIP_THIRD_U,
  STRIP_TWO_THIRDS_U,
  USER_SECTIONS,
  VENT_1_5U,
} from './__fixtures__/frameFixtures'
import { totalHeightSixths } from './frame'
import { railHoleYsMm, sixthsToMm } from './geometry'
import {
  addPlacement,
  allowedPhases,
  boxesOverlap,
  canPlace,
  deletePlacement,
  duplicatePlacement,
  findFreeSpot,
  findFreeY,
  fitDeviceInSlot,
  fitItIn,
  movePlacement,
  occupiedBox,
  orientedDims,
  packAreaSlot,
  resolvePlaceable,
  snapY,
  type OccupiedBox,
  type PlaceCheck,
  type PlacementCandidate,
} from './placement'
import { ItemSchema, SlotSchema, type Frame, type Item, type Slot } from './schema/catalog'
import type { Placement, Plan } from './schema/plan'

const LATER = '2026-10-12T08:00:00.000Z'

function placementOf(plan: Plan, id: string): Placement {
  const placement = plan.placements.find((candidate) => candidate.id === id)
  if (placement === undefined) throw new Error(`No placement "${id}"`)
  return placement
}

function slotOf(item: Item, id: string): Slot {
  const slot = item.slots.find((candidate) => candidate.id === id)
  if (slot === undefined) throw new Error(`No slot "${id}"`)
  return slot
}

function codes(check: PlaceCheck): string[] {
  return check.reasons.map((reason) => reason.code)
}

describe('resolvePlaceable', () => {
  it('resolves items and ear-mounted gear, nothing else', () => {
    expect(resolvePlaceable(CATALOG, 'blank-1u')).toMatchObject({
      source: 'item',
      heightSixths: 6,
      faces: ['front', 'rear'],
    })
    expect(resolvePlaceable(CATALOG, 'test-switch')).toEqual({
      id: 'test-switch',
      name: 'Test Switch',
      source: 'rackmount',
      heightSixths: 6,
      faces: ['front'],
      bay: 'full',
      depthMm: 100,
      mount: { front: 4, rear: 0 },
      slots: [],
      requiresRearSupport: false,
    })
    expect(resolvePlaceable(CATALOG, 'rubber-feet')).toBeUndefined()
    expect(resolvePlaceable(CATALOG, 'test-nas')).toBeUndefined()
    expect(resolvePlaceable(CATALOG, 'no-such-item')).toBeUndefined()
  })
})

describe('allowedPhases on the EIA rail (holes at 6.35 / 22.225 / 38.1 mm per U)', () => {
  const withHoles = (heightSixths: number, holeOffsetsMm: number[], slotLengthMm?: number) => ({
    heightSixths,
    mount: {
      front: 2,
      rear: 0,
      holeOffsetsMm,
      ...(slotLengthMm === undefined ? {} : { slotLengthMm }),
    },
  })

  it('puts a 1U item with holes at 6.35 and 38.1 mm on whole U only', () => {
    expect(allowedPhases(BLANK_1U, FRAME)).toEqual({ phases: [0], verified: true })
    expect(allowedPhases(withHoles(6, [6.35, 22.225, 38.1]), FRAME).phases).toEqual([0])
  })

  it('checks a ½U item hole by hole against the pattern', () => {
    // 6.35 mm up meets a rail hole only in the lower half of a U (the upper half's hole is
    // 15.875 mm above its bottom), so a single hole there allows [0], not [0, 3].
    expect(allowedPhases(withHoles(3, [6.35]), FRAME)).toEqual({ phases: [0], verified: true })
    expect(allowedPhases(withHoles(3, [15.875]), FRAME).phases).toEqual([3])
  })

  it('widens the tolerance by half the length of a slotted hole', () => {
    // Holes drilled 1 mm high: too far off for 0.5 mm, close enough with a 2.4 mm slot.
    expect(allowedPhases(withHoles(6, [7.35, 39.1]), FRAME).phases).toEqual([])
    expect(allowedPhases(withHoles(6, [7.35, 39.1], 2.4), FRAME).phases).toEqual([0])
    // A slot from 6.35 to 15.875 mm reaches a rail hole wherever the item starts: rail holes are
    // never more than 15.875 mm apart.
    expect(allowedPhases(withHoles(3, [11.1125], 9.525), FRAME).phases).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('derives unverified phases from the height without hole data', () => {
    expect(allowedPhases(HALF_U_PANEL, FRAME)).toEqual({ phases: [0, 3], verified: false })
    expect(allowedPhases(STRIP_THIRD_U, FRAME)).toEqual({ phases: [0, 2, 4], verified: false })
    expect(allowedPhases(STRIP_TWO_THIRDS_U, FRAME)).toEqual({ phases: [0, 2], verified: false })
    expect(allowedPhases(VENT_1_5U, FRAME)).toEqual({ phases: [0], verified: false })
    expect(allowedPhases(BLANK_2U, FRAME)).toEqual({ phases: [0], verified: false })
  })

  it('honours the rail tolerance', () => {
    expect(allowedPhases(withHoles(6, [6.8, 38.1]), FRAME).phases).toEqual([0])
    expect(allowedPhases(withHoles(6, [7.0, 38.1]), FRAME).phases).toEqual([])
  })

  it('follows a frame with its own hole pattern', () => {
    const halfPitch: Frame = {
      ...FRAME,
      rail: { ...FRAME.rail, holeOffsetsPerUMm: [11.1125, 33.3375] },
    }
    expect(allowedPhases(withHoles(3, [11.1125]), halfPitch).phases).toEqual([0, 3])
    expect(allowedPhases(withHoles(6, [11.1125, 33.3375]), halfPitch).phases).toEqual([0, 3])
  })

  test.prop([
    fc.integer({ min: 0, max: 5 }),
    fc.integer({ min: 1, max: 4 }),
    fc.array(fc.nat({ max: 50 }), { minLength: 1, maxLength: 4 }),
  ])('accepts the phase its holes were drilled for', (phase, heightU, picks) => {
    const bottomMm = sixthsToMm(phase)
    const topMm = bottomMm + sixthsToMm(heightU * 6)
    const railHoles = railHoleYsMm(heightU + 2).filter((y) => y >= bottomMm && y <= topMm)
    const holes = picks.map((pick) => (railHoles[pick % railHoles.length] ?? bottomMm) - bottomMm)
    const item = withHoles(heightU * 6, holes)
    expect(allowedPhases(item, FRAME).phases).toContain(phase)
  })
})

describe('snapY', () => {
  it('snaps to the nearest allowed phase, ties going down', () => {
    expect(snapY(4.2, [0])).toBe(6)
    expect(snapY(2.9, [0])).toBe(0)
    expect(snapY(3, [0])).toBe(0)
    expect(snapY(4, [0, 3])).toBe(3)
    expect(snapY(70.4, [0, 2, 4])).toBe(70)
    expect(snapY(-2, [0])).toBe(0)
    expect(snapY(-4, [0])).toBe(-6)
    expect(Object.is(snapY(-0.2, [0]), 0)).toBe(true)
  })

  it('just rounds when no phase is allowed', () => {
    expect(snapY(7.6, [])).toBe(8)
  })

  test.prop([
    fc.double({ min: -100, max: 500, noNaN: true }),
    fc.subarray([0, 1, 2, 3, 4, 5], { minLength: 1 }),
  ])('lands on an allowed phase within half a U', (raw, phases) => {
    const y = snapY(raw, phases)
    expect(Number.isInteger(y)).toBe(true)
    expect(phases).toContain(((y % 6) + 6) % 6)
    // Near-ties (within snapY's 1e-6 epsilon) go to the lower start, so a raw value just past
    // the midpoint may land 3 + up to 1e-6 away (3 + 1e-9 failed for 3.000000001).
    expect(Math.abs(y - raw)).toBeLessThanOrEqual(3 + 2e-6)
  })
})

describe('occupiedBox', () => {
  const plan = makePlan({
    sections: USER_SECTIONS,
    placements: [
      { id: 'pl-blank', itemId: 'blank-1u', y: 6 },
      { id: 'pl-fan', itemId: 'rear-fan-1u', y: 6, face: 'rear' },
      { id: 'pl-tray', itemId: 'deep-tray-2u', y: 18 },
      {
        id: 'pl-shelf',
        itemId: 'shelf-1u',
        y: 30,
        devices: [{ id: 'dv-nas', deviceId: 'test-nas', slotId: 'deck' }],
      },
      { id: 'pl-switch', itemId: 'test-switch', y: 0 },
    ],
  })
  const box = (id: string, inPlan: Plan = plan) =>
    occupiedBox(inPlan, CATALOG, placementOf(inPlan, id), FRAME)
  // Without a frame argument: the plan's frame comes from the catalog, if it is there.
  const boxOwnFrame = (id: string, inPlan: Plan) =>
    occupiedBox(inPlan, CATALOG, placementOf(inPlan, id))

  it('covers a front item from the rail face back to its depth', () => {
    expect(box('pl-blank')).toEqual({
      placementId: 'pl-blank',
      face: 'front',
      y0: 6,
      y1: 12,
      bay: 'full',
      zFrontMm: 0,
      zBackMm: -10,
      claimsRearColumns: false,
      claimsFrontColumns: true,
    })
    expect(box('pl-switch')).toMatchObject({ y0: 0, y1: 6, zFrontMm: 0, zBackMm: -100 })
  })

  it('measures a rear item from the rear rail, after rack option effects', () => {
    expect(box('pl-fan')).toMatchObject({
      face: 'rear',
      zFrontMm: -170,
      zBackMm: -200,
      claimsRearColumns: true,
      claimsFrontColumns: false,
    })
    const deep: Plan = { ...plan, frame: { ...plan.frame, options: { deep: true } } }
    expect(box('pl-fan', deep)).toMatchObject({ zFrontMm: -290, zBackMm: -320 })
    expect(boxOwnFrame('pl-fan', plan)).toEqual(box('pl-fan'))
  })

  it('measures rear items from the front when the frame is unknown', () => {
    const lost: Plan = { ...plan, frame: { ...plan.frame, frameId: 'unknown-frame' } }
    expect(boxOwnFrame('pl-fan', lost)).toMatchObject({ zFrontMm: 0, zBackMm: -30 })
  })

  it('makes items supported at the rear span the whole depth and both rails', () => {
    expect(box('pl-tray')).toMatchObject({
      zFrontMm: 0,
      zBackMm: -200,
      claimsRearColumns: true,
      claimsFrontColumns: true,
    })
  })

  it('reaches up to the tallest device on a shelf and back past the deepest one', () => {
    // Floor 4 mm + NAS 120 mm + 5 mm headroom = 129 mm above sixth 30 (222.25 mm): 351.25 mm,
    // which rounds up to sixth 48. Depth: 140 mm from 5 mm behind the rail + 30 mm for plugs.
    expect(box('pl-shelf')).toMatchObject({ y0: 30, y1: 48, zBackMm: -175 })
    // 4 + 25 + 5 = 34 mm stays within the shelf's own 1U.
    expect(box('pl-shelf', shelfWith('test-sbc'))).toMatchObject({ y0: 30, y1: 36 })
  })

  it('takes the first orientation that fits when a device has none', () => {
    // The 183 mm-deep mini PC only fits the 150 mm deck standing upright: 183 mm tall.
    expect(box('pl-shelf', shelfWith('test-mini-pc'))).toMatchObject({ y1: 56, zBackMm: -150 })
    expect(box('pl-shelf', shelfWith('test-mini-pc', 'flat'))).toMatchObject({
      y1: 36,
      zBackMm: -218,
    })
  })

  function shelfWith(deviceId: string, orientation?: 'flat'): Plan {
    const device = { id: 'dv-1', deviceId, slotId: 'deck', ...(orientation ? { orientation } : {}) }
    return makePlan({
      sections: USER_SECTIONS,
      placements: [{ id: 'pl-shelf', itemId: 'shelf-1u', y: 30, devices: [device] }],
    })
  }

  it('uses the saved height of an unknown item', () => {
    const base = makePlan({ sections: USER_SECTIONS })
    const ghost: Placement = {
      id: 'pl-ghost',
      itemId: 'gone-item',
      name: 'Old mount',
      heightSixths: 12,
      y: 6,
      face: 'front',
      bay: 'full',
      devices: [],
    }
    const withGhost: Plan = { ...base, placements: [ghost] }
    expect(box('pl-ghost', withGhost)).toMatchObject({ y0: 6, y1: 18, zFrontMm: 0, zBackMm: 0 })
  })
})

describe('boxesOverlap', () => {
  const front: OccupiedBox = {
    face: 'front',
    y0: 0,
    y1: 6,
    bay: 'full',
    zFrontMm: 0,
    zBackMm: -100,
    claimsRearColumns: false,
    claimsFrontColumns: true,
  }
  const rear: OccupiedBox = {
    face: 'rear',
    y0: 0,
    y1: 6,
    bay: 'full',
    zFrontMm: -150,
    zBackMm: -200,
    claimsRearColumns: true,
    claimsFrontColumns: false,
  }

  it('needs overlapping U ranges and bays', () => {
    expect(boxesOverlap(front, { ...front, y0: 3, y1: 9 })).toBe(true)
    expect(boxesOverlap(front, { ...front, y0: 6, y1: 12 })).toBe(false)
    expect(boxesOverlap({ ...front, bay: 'left' }, { ...front, bay: 'right' })).toBe(false)
    expect(boxesOverlap({ ...front, bay: 'left' }, { ...front, bay: 'left' })).toBe(true)
    expect(boxesOverlap({ ...front, bay: 'left' }, front)).toBe(true)
  })

  it('lets front and rear gear share a U when their depths leave room', () => {
    expect(boxesOverlap(front, rear)).toBe(false)
    expect(boxesOverlap({ ...front, zBackMm: -150 }, rear)).toBe(false)
    expect(boxesOverlap({ ...front, zBackMm: -160 }, rear)).toBe(true)
  })

  it('treats items supported on the other rail as using its hole columns', () => {
    expect(boxesOverlap({ ...front, zBackMm: -10, claimsRearColumns: true }, rear)).toBe(true)
  })

  const boxArb: fc.Arbitrary<OccupiedBox> = fc.record({
    face: fc.constantFrom('front' as const, 'rear' as const),
    y0: fc.integer({ min: 0, max: 30 }),
    y1: fc.integer({ min: 0, max: 36 }),
    bay: fc.constantFrom('full' as const, 'left' as const, 'right' as const),
    zFrontMm: fc.integer({ min: -100, max: 0 }),
    zBackMm: fc.integer({ min: -300, max: -100 }),
    claimsRearColumns: fc.boolean(),
    claimsFrontColumns: fc.boolean(),
  })

  test.prop([boxArb, boxArb])('is symmetric', (a, b) => {
    expect(boxesOverlap(a, b)).toBe(boxesOverlap(b, a))
  })
})

describe('canPlace', () => {
  // A Mini PC mount 2U sits at U5–U6 of the user's 9U rack.
  const plan = makePlan({
    sections: USER_SECTIONS,
    placements: [{ id: 'pl-pc', itemId: 'mini-pc-mount-2u', y: 24 }],
  })
  const check = (
    candidate: Partial<PlacementCandidate> & { itemId: string; y: number },
    inPlan: Plan = plan,
    frame: Frame = FRAME,
  ) => canPlace(inPlan, CATALOG, frame, { face: 'front', bay: 'full', ...candidate })

  it('accepts a free spot its holes line up with', () => {
    expect(check({ itemId: 'blank-1u', y: 0 })).toEqual({ ok: true, reasons: [] })
    expect(check({ itemId: 'test-switch', y: 36 }).ok).toBe(true)
  })

  it('names what it would overlap', () => {
    expect(check({ itemId: 'blank-2u', y: 30 })).toEqual({
      ok: false,
      reasons: [
        {
          code: 'overlap',
          message: 'It overlaps Mini PC mount 2U (U5–U6).',
          placementIds: ['pl-pc'],
        },
      ],
    })
  })

  it('keeps items inside the rack', () => {
    expect(check({ itemId: 'blank-1u', y: -6 }).reasons).toEqual([
      { code: 'out-of-rack', message: 'It would sit below U1, the bottom of the rack.' },
    ])
    expect(check({ itemId: 'blank-1u', y: 54 }).reasons).toEqual([
      { code: 'out-of-rack', message: 'It would reach above U9, the top of the rack.' },
    ])
    expect(check({ itemId: 'blank-1u', y: 0 }, makePlan()).reasons).toEqual([
      { code: 'out-of-rack', message: 'The rack has no sections yet.' },
    ])
  })

  it('checks the start against the item holes', () => {
    expect(check({ itemId: 'blank-1u', y: 3 }).reasons).toEqual([
      {
        code: 'invalid-phase',
        message:
          'Blank 1U cannot start at U1 + ½U: its holes do not line up with the rail there. Try U1.',
      },
    ])
    expect(check({ itemId: 'half-u-panel', y: 3 }).ok).toBe(true)
    expect(check({ itemId: 'blank-2u', y: 2 }).reasons[0]?.message).toBe(
      'Blank 2U cannot start at U1 + ⅓U: items of its height do not usually mount there (its holes are not verified). Try U1.',
    )
  })

  it('keeps clear of joint dead zones', () => {
    const empty = makePlan({ sections: USER_SECTIONS })
    expect(check({ itemId: 'blank-2u', y: 12 }, empty, DEAD_ZONE_FRAME).reasons).toEqual([
      {
        code: 'dead-zone',
        message: 'It crosses the joint between U3 and U4, where nothing can mount.',
      },
    ])
    // The zone covers sixths 17–18, so a 1U ending at the joint is in it too.
    expect(codes(check({ itemId: 'blank-1u', y: 12 }, empty, DEAD_ZONE_FRAME))).toEqual([
      'dead-zone',
    ])
    expect(check({ itemId: 'blank-1u', y: 6 }, empty, DEAD_ZONE_FRAME).ok).toBe(true)
    expect(check({ itemId: 'blank-2u', y: 12 }, empty, FRAME).ok).toBe(true)
  })

  it('respects the faces and the bay an item allows', () => {
    expect(check({ itemId: 'rear-fan-1u', y: 0 }).reasons).toEqual([
      { code: 'face-not-allowed', message: 'Rear fan 1U mounts on the rear only.' },
    ])
    expect(check({ itemId: 'rear-fan-1u', y: 0, face: 'rear' }).ok).toBe(true)
    expect(check({ itemId: 'half-bay-1u', y: 0 }).reasons).toEqual([
      {
        code: 'bay-mismatch',
        message: 'Half-width 1U is half width: put it on the left or the right.',
      },
    ])
    expect(check({ itemId: 'blank-1u', y: 0, bay: 'left' }).reasons).toEqual([
      { code: 'bay-mismatch', message: 'Blank 1U is full width.' },
    ])
    expect(check({ itemId: 'half-bay-1u', y: 0, bay: 'left' }).ok).toBe(true)
  })

  it('lets rear gear share a U with front gear when the frame is deep enough', () => {
    // The 190 mm mount and a 30 mm rear fan need 220 mm of a 200 mm frame.
    expect(codes(check({ itemId: 'rear-fan-1u', y: 24, face: 'rear' }))).toEqual(['overlap'])
    const deep: Plan = { ...plan, frame: { ...plan.frame, options: { deep: true } } }
    expect(check({ itemId: 'rear-fan-1u', y: 24, face: 'rear' }, deep).ok).toBe(true)
  })

  describe('moving a placement', () => {
    // A NAS on the shelf reaches up to sixth 18 (U3).
    const shelfPlan = makePlan({
      sections: USER_SECTIONS,
      placements: [
        {
          id: 'pl-shelf',
          itemId: 'shelf-1u',
          y: 0,
          devices: [{ id: 'dv-nas', deviceId: 'test-nas', slotId: 'deck' }],
        },
      ],
    })

    it('never collides with itself', () => {
      const move = { itemId: 'shelf-1u', y: 6, ignorePlacementId: 'pl-shelf' }
      expect(check(move, shelfPlan).ok).toBe(true)
      expect(codes(check({ itemId: 'shelf-1u', y: 6 }, shelfPlan))).toEqual(['overlap'])
    })

    it('brings its devices along', () => {
      const move = { itemId: 'shelf-1u', y: 42, ignorePlacementId: 'pl-shelf' }
      expect(codes(check(move, shelfPlan))).toEqual(['out-of-rack'])
      expect(check({ ...move, devices: [] }, shelfPlan).ok).toBe(true)
    })

    it('can move a placeholder of an unknown item', () => {
      const base = makePlan({ sections: USER_SECTIONS })
      const ghost: Placement = {
        id: 'pl-ghost',
        itemId: 'gone-item',
        name: 'Old mount',
        heightSixths: 12,
        y: 0,
        face: 'front',
        bay: 'full',
        devices: [],
      }
      const withGhost: Plan = { ...base, placements: [ghost] }
      const move = { itemId: 'gone-item', y: 6, ignorePlacementId: 'pl-ghost' }
      expect(check(move, withGhost).ok).toBe(true)
      expect(codes(check({ ...move, y: 48 }, withGhost))).toEqual(['out-of-rack'])
    })
  })

  it('reports unknown and non-rack items', () => {
    expect(check({ itemId: 'no-such-item', y: 0 })).toEqual({
      ok: false,
      reasons: [{ code: 'unknown-item', message: '"no-such-item" is not in the catalog.' }],
    })
    expect(codes(check({ itemId: 'rubber-feet', y: 0 }))).toEqual(['unknown-item'])
  })

  it("finds the plan's own custom items", () => {
    const custom = ItemSchema.parse({
      kind: 'item',
      id: 'custom:my-panel',
      name: 'My panel',
      category: 'panel',
      verified: { by: 'me', date: '2026-10-11', method: 'calipers' },
      heightSixths: 6,
      depthMm: 5,
      mount: { front: 4 },
    })
    const withCustom: Plan = { ...plan, custom: { ...plan.custom, items: [custom] } }
    expect(check({ itemId: 'custom:my-panel', y: 0 }, withCustom).ok).toBe(true)
    expect(codes(check({ itemId: 'custom:my-panel', y: 0 }))).toEqual(['unknown-item'])
  })
})

describe('findFreeY', () => {
  // Taken: [0, 6) and [12, 24).
  const plan = makePlan({
    sections: USER_SECTIONS,
    placements: [
      { id: 'pl-low', itemId: 'blank-1u', y: 0 },
      { id: 'pl-pc', itemId: 'mini-pc-mount-2u', y: 12 },
    ],
  })

  it('finds the lowest or the highest free spot', () => {
    expect(findFreeY(plan, CATALOG, FRAME, 'blank-1u', { face: 'front', from: 'bottom' })).toBe(6)
    expect(findFreeY(plan, CATALOG, FRAME, 'blank-1u', { face: 'front', from: 'top' })).toBe(48)
  })

  it('skips gaps that are too small', () => {
    expect(findFreeY(plan, CATALOG, FRAME, 'blank-2u', { face: 'front' })).toBe(24)
  })

  it('uses the half-U starts of a ½U item', () => {
    const half = makePlan({
      sections: USER_SECTIONS,
      placements: [{ id: 'pl-h', itemId: 'half-u-panel', y: 0 }],
    })
    expect(findFreeY(half, CATALOG, FRAME, 'half-u-panel', { face: 'front' })).toBe(3)
  })

  it('returns null when nothing fits', () => {
    const full = makePlan({
      sections: [{ id: 'sec-a', typeId: 's3' }],
      placements: [
        { id: 'pl-1', itemId: 'blank-1u', y: 0 },
        { id: 'pl-2', itemId: 'blank-2u', y: 6 },
      ],
    })
    expect(findFreeY(full, CATALOG, FRAME, 'blank-1u', { face: 'front' })).toBeNull()
    expect(findFreeY(full, CATALOG, FRAME, 'no-such-item')).toBeNull()
    // The other face is still free.
    expect(findFreeSpot(full, CATALOG, FRAME, 'blank-1u')).toEqual({
      y: 0,
      face: 'rear',
      bay: 'full',
    })
  })

  it('tries the left half, then the right', () => {
    const half = makePlan({
      sections: [{ id: 'sec-a', typeId: 's3' }],
      placements: [{ id: 'pl-l', itemId: 'half-bay-1u', y: 0, bay: 'left' }],
    })
    expect(findFreeSpot(half, CATALOG, FRAME, 'half-bay-1u')).toEqual({
      y: 0,
      face: 'front',
      bay: 'right',
    })
  })
})

describe('fitItIn', () => {
  it('fills the rack bottom-up, taller items first', () => {
    const plan = makePlan({ sections: USER_SECTIONS })
    const result = fitItIn(plan, CATALOG, FRAME, ['blank-1u', 'half-u-panel', 'mini-pc-mount-2u'])
    expect(result.unplaced).toEqual([])
    expect(result.placed.map(({ itemId, y, face, bay }) => ({ itemId, y, face, bay }))).toEqual([
      { itemId: 'mini-pc-mount-2u', y: 0, face: 'front', bay: 'full' },
      { itemId: 'blank-1u', y: 12, face: 'front', bay: 'full' },
      { itemId: 'half-u-panel', y: 18, face: 'front', bay: 'full' },
    ])
    expect(result.plan.placements).toEqual(
      result.placed.map((placed) =>
        expect.objectContaining({ id: placed.placementId, y: placed.y, devices: [] }),
      ),
    )
    expect(result.plan.placements[0]).toMatchObject({ name: 'Mini PC mount 2U', heightSixths: 12 })
    expect(result.plan.placements[0]?.have).toBeUndefined()
    expect(plan.placements).toEqual([])
  })

  it('reports what does not fit or is unknown', () => {
    const plan = makePlan({ sections: [{ id: 'sec-a', typeId: 's3' }] })
    const result = fitItIn(plan, CATALOG, FRAME, [
      'mini-pc-mount-2u',
      'mini-pc-mount-2u',
      'no-such-item',
    ])
    expect(result.placed).toHaveLength(1)
    expect(result.unplaced).toEqual(['no-such-item', 'mini-pc-mount-2u'])
  })

  const itemsArb = fc.array(
    fc.constantFrom(
      BLANK_1U.id,
      BLANK_2U.id,
      HALF_U_PANEL.id,
      SHELF_1U.id,
      PC_MOUNT_2U.id,
      HALF_BAY_1U.id,
      'rear-fan-1u',
      'deep-tray-2u',
      'test-switch',
    ),
    { maxLength: 12 },
  )
  const sectionsArb = fc.array(fc.constantFrom('s3', 's6'), { minLength: 1, maxLength: 3 })

  test.prop([sectionsArb, itemsArb])(
    'places everything it reports as placed validly and without overlaps',
    (typeIds, itemIds) => {
      const plan = makePlan({
        sections: typeIds.map((typeId, index) => ({ id: `sec-${index}`, typeId })),
      })
      const result = fitItIn(plan, CATALOG, FRAME, itemIds)
      expect(result.placed.length + result.unplaced.length).toBe(itemIds.length)
      for (const placement of result.plan.placements) {
        const candidate = { ...placement, ignorePlacementId: placement.id }
        expect(canPlace(result.plan, CATALOG, FRAME, candidate).reasons).toEqual([])
      }
      const top = totalHeightSixths(result.plan, FRAME)
      for (const placement of result.plan.placements) {
        const placed = occupiedBox(result.plan, CATALOG, placement, FRAME)
        expect(placed.y1).toBeLessThanOrEqual(top)
      }
    },
  )
})

describe('fitDeviceInSlot', () => {
  const bay = slotOf(PC_MOUNT_2U, 'bay')
  const slot = (input: Record<string, unknown>) =>
    SlotSchema.parse({ id: 'cradle', kind: 'fixed', layout: { xMm: 0, yMm: 0, zMm: 0 }, ...input })

  it('fits a mini PC flat in its bay', () => {
    expect(fitDeviceInSlot(MINI_PC, bay)).toEqual({ ok: true, orientation: 'flat' })
  })

  it('only takes what the slot accepts', () => {
    expect(fitDeviceInSlot(NAS, bay)).toEqual({
      ok: false,
      reason: 'Mini PC bay is not made for the Test NAS.',
    })
    const byId = slot({ maxW: 200, maxD: 200, accepts: { deviceIds: ['test-nas'] } })
    expect(fitDeviceInSlot(NAS, byId).ok).toBe(true)
    expect(fitDeviceInSlot(MINI_PC, byId).ok).toBe(false)
  })

  it('turns, rolls or stands a device up when the slot allows it', () => {
    const wide = { ...MINI_PC, dims: { w: 195, d: 150, h: 35 } }
    expect(fitDeviceInSlot(wide, slot({ maxW: 190, maxD: 200 }))).toEqual({
      ok: true,
      orientation: 'flat-rotated',
    })
    const flatBox = { ...NAS, dims: { w: 150, d: 140, h: 50 } }
    const narrow = slot({ maxW: 60, maxD: 200, maxH: 200, orientations: ['flat', 'on-side'] })
    expect(fitDeviceInSlot(flatBox, narrow)).toEqual({ ok: true, orientation: 'on-side' })
    const longBox = { ...SBC, dims: { w: 100, d: 180, h: 30 } }
    const shallow = slot({ maxW: 120, maxD: 40, orientations: ['flat', 'upright'] })
    expect(fitDeviceInSlot(longBox, shallow)).toEqual({ ok: true, orientation: 'upright' })
  })

  it('explains when nothing fits', () => {
    const big = { ...NAS, model: 'Tower', dims: { w: 300, d: 300, h: 300 } }
    expect(fitDeviceInSlot(big, slotOf(SHELF_1U, 'deck'))).toEqual({
      ok: false,
      reason:
        'The Test Tower (300 × 300 × 300 mm) does not fit Shelf deck (210 × 150 mm) in any allowed orientation.',
    })
    expect(fitDeviceInSlot(NAS, slot({ maxW: 200, maxD: 200, maxH: 100 })).reason).toMatch(
      /\(200 × 200 × 100 mm\)/,
    )
  })

  it('documents the orientation convention', () => {
    const dims = { w: 1, d: 2, h: 3 }
    expect(orientedDims(dims, 'flat')).toEqual({ w: 1, d: 2, h: 3 })
    expect(orientedDims(dims, 'flat-rotated')).toEqual({ w: 2, d: 1, h: 3 })
    expect(orientedDims(dims, 'on-side')).toEqual({ w: 3, d: 2, h: 1 })
    expect(orientedDims(dims, 'upright')).toEqual({ w: 1, d: 3, h: 2 })
  })
})

describe('packAreaSlot', () => {
  const deck = slotOf(SHELF_1U, 'deck')

  it('packs left to right with gaps and reports what overflows', () => {
    const result = packAreaSlot(
      [
        { id: 'dv-1', device: SBC },
        { id: 'dv-2', device: SBC },
        { id: 'dv-3', device: SBC },
      ],
      deck,
    )
    expect(result).toEqual({
      ok: false,
      positions: [
        { id: 'dv-1', deviceId: 'test-sbc', xMm: 0, orientation: 'flat' },
        { id: 'dv-2', deviceId: 'test-sbc', xMm: 95, orientation: 'flat' },
      ],
      overflowIds: ['dv-3'],
    })
  })

  it('turns a device to fit the width that is left', () => {
    const long = { ...SBC, id: 'test-long', dims: { w: 120, d: 60, h: 25 } }
    const result = packAreaSlot(
      [
        { id: 'a', device: SBC },
        { id: 'b', device: long },
      ],
      deck,
    )
    expect(result).toEqual({
      ok: true,
      positions: [
        { id: 'a', deviceId: 'test-sbc', xMm: 0, orientation: 'flat' },
        { id: 'b', deviceId: 'test-long', xMm: 95, orientation: 'flat-rotated' },
      ],
      overflowIds: [],
    })
  })

  it('keeps a chosen orientation and a custom gap', () => {
    const result = packAreaSlot(
      [
        { id: 'a', device: SBC, orientation: 'flat-rotated' },
        { id: 'b', device: SBC },
      ],
      deck,
      0,
    )
    expect(result.positions.map(({ xMm, orientation }) => [xMm, orientation])).toEqual([
      [0, 'flat-rotated'],
      [60, 'flat'],
    ])
  })

  it('lets a later, smaller device use the space left', () => {
    const flatOnly = { ...deck, maxD: 200, orientations: ['flat' as const] }
    const result = packAreaSlot(
      [
        { id: 'a', device: SBC },
        { id: 'b', device: NAS },
        { id: 'c', device: SBC },
      ],
      flatOnly,
    )
    expect(result.positions.map(({ id, xMm }) => [id, xMm])).toEqual([
      ['a', 0],
      ['c', 95],
    ])
    expect(result.overflowIds).toEqual(['b'])
  })

  it('holds one device in a fixed slot and skips what it does not accept', () => {
    const result = packAreaSlot(
      [
        { id: 'nas', device: NAS },
        { id: 'pc-1', device: MINI_PC },
        { id: 'pc-2', device: MINI_PC },
      ],
      slotOf(PC_MOUNT_2U, 'bay'),
    )
    expect(result).toEqual({
      ok: false,
      positions: [{ id: 'pc-1', deviceId: 'test-mini-pc', xMm: 0, orientation: 'flat' }],
      overflowIds: ['nas', 'pc-2'],
    })
  })

  const deviceArb = fc.record({
    w: fc.integer({ min: 20, max: 250 }),
    d: fc.integer({ min: 20, max: 250 }),
    h: fc.integer({ min: 10, max: 120 }),
  })

  test.prop([fc.array(deviceArb, { maxLength: 8 }), fc.integer({ min: 0, max: 10 })])(
    'never overlaps devices or runs past the slot',
    (sizes, gapMm) => {
      const items = sizes.map((dims, index) => ({ id: `dv-${index}`, device: { ...SBC, dims } }))
      const result = packAreaSlot(items, deck, gapMm)
      expect(result.positions.length + result.overflowIds.length).toBe(items.length)
      let edge = Number.NEGATIVE_INFINITY
      for (const position of result.positions) {
        const item = items.find((candidate) => candidate.id === position.id)
        if (item === undefined) throw new Error('unknown id')
        const size = orientedDims(item.device.dims, position.orientation)
        expect(position.xMm).toBeGreaterThanOrEqual(edge)
        expect(position.xMm + size.w).toBeLessThanOrEqual(deck.maxW + 1e-6)
        expect(size.d).toBeLessThanOrEqual(deck.maxD + 1e-6)
        edge = position.xMm + size.w + gapMm
      }
    },
  )
})

describe('placement edits', () => {
  const plan = makePlan({
    sections: USER_SECTIONS,
    placements: [
      {
        id: 'pl-shelf',
        itemId: 'shelf-1u',
        y: 6,
        have: true,
        label: 'Pi shelf',
        devices: [
          { id: 'dv-own', deviceId: 'test-sbc', slotId: 'deck', have: true },
          { id: 'dv-new', deviceId: 'test-sbc', slotId: 'deck' },
        ],
      },
      { id: 'pl-blank', itemId: 'blank-1u', y: 0 },
    ],
  })

  it('moves a placement, devices and all', () => {
    const moved = movePlacement(plan, 'pl-blank', { y: 30, face: 'rear' })
    expect(placementOf(moved, 'pl-blank')).toMatchObject({ y: 30, face: 'rear', bay: 'full' })
    expect(moved.placements[0]).toBe(plan.placements[0])
    expect(movePlacement(plan, 'pl-blank', { y: 0 })).toBe(plan)
    expect(movePlacement(plan, 'pl-none', { y: 6 })).toBe(plan)
  })

  it('duplicates as still to get, right above the original', () => {
    const { plan: next, placementId } = duplicatePlacement(plan, 'pl-shelf')
    expect(next.placements.map((placement) => placement.id)).toEqual([
      'pl-shelf',
      placementId,
      'pl-blank',
    ])
    const copy = placementOf(next, placementId ?? '')
    expect(copy).toMatchObject({ itemId: 'shelf-1u', label: 'Pi shelf', y: 12, face: 'front' })
    expect('have' in copy).toBe(false)
    expect(copy.devices.map((device) => [device.deviceId, device.have])).toEqual([
      ['test-sbc', false],
      ['test-sbc', false],
    ])
    expect(copy.devices.map((device) => device.id)).not.toContain('dv-own')
    expect(placementOf(plan, 'pl-shelf').have).toBeDefined()
    expect(duplicatePlacement(plan, 'pl-blank', { y: 42 }).plan.placements[2]?.y).toBe(42)
    expect(duplicatePlacement(plan, 'pl-none')).toEqual({ plan })
  })

  it('retires an owned placement with its owned devices; the rest go to the tray', () => {
    const next = deletePlacement(plan, 'pl-shelf')
    expect(next.placements.map((placement) => placement.id)).toEqual(['pl-blank'])
    expect(next.retired).toEqual([
      {
        id: expect.stringMatching(/^rt-/),
        kind: 'placement',
        snapshot: { at: NOW, itemId: 'shelf-1u', options: {} },
        sourceId: 'pl-shelf',
        devices: ['test-sbc'],
      },
    ])
    expect(next.equipment).toEqual([
      { id: expect.stringMatching(/^eq-/), deviceId: 'test-sbc', have: false },
    ])
    expect(deletePlacement(plan, 'pl-shelf', { at: LATER }).retired[0]?.snapshot.at).toBe(LATER)
    expect(deletePlacement(plan, 'pl-shelf', { needDevices: 'drop' }).equipment).toEqual([])
  })

  it('deletes a planned placement and keeps the owned devices that were on it', () => {
    const planned = makePlan({
      sections: USER_SECTIONS,
      placements: [
        {
          id: 'pl-new',
          itemId: 'shelf-1u',
          y: 0,
          devices: [{ id: 'dv-own', deviceId: 'test-mini-pc', slotId: 'deck', have: true }],
        },
      ],
    })
    const next = deletePlacement(planned, 'pl-new', { needDevices: 'drop' })
    expect(next.placements).toEqual([])
    expect(next.retired).toEqual([])
    expect(next.equipment.map(({ deviceId, have }) => ({ deviceId, have }))).toEqual([
      { deviceId: 'test-mini-pc', have: true },
    ])
    expect(deletePlacement(planned, 'pl-none')).toBe(planned)
  })

  it('adds a placement with its name and height', () => {
    const empty = makePlan({ sections: USER_SECTIONS })
    const added = addPlacement(empty, CATALOG, { itemId: 'test-switch', y: 0 })
    expect(added.plan.placements).toEqual([
      {
        id: added.placementId,
        itemId: 'test-switch',
        name: 'Test Switch',
        heightSixths: 6,
        y: 0,
        face: 'front',
        bay: 'full',
        devices: [],
      },
    ])
    expect(
      addPlacement(empty, CATALOG, { itemId: 'half-bay-1u', y: 0 }).plan.placements[0]?.bay,
    ).toBe('left')
    expect(addPlacement(empty, CATALOG, { itemId: 'no-such-item', y: 0 })).toEqual({ plan: empty })
  })
})
