import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import {
  addEquipment,
  assignDevice,
  assignEquipment,
  DEFAULT_MOUNT_SUGGESTIONS,
  equipmentUSummary,
  estimateDeviceSixths,
  estimateSixthsFromHeight,
  MAX_STACK_SEARCH_U,
  mountSuggestions,
  placeEquipmentOnMount,
  removeDevice,
  removeEquipment,
  slotForDevice,
  smallestStackU,
  type DeviceOpResult,
} from './devices'
import { canPlace, occupiedBox } from './placement'
import type { CatalogLookup, Device, Frame, SectionType } from './schema/catalog'
import type { PlacedDevice, Placement, Plan } from './schema/plan'
import { RANGE_FRAME } from './__fixtures__/frameFixtures'
import { EDITOR_IDS, editorCatalog, placementAt } from './__fixtures__/editorFixtures'
import { KWS_FRAME, kwsPlan, parseEntries, type KwsPlanSpec } from './__fixtures__/kws'

const LATER = '2026-10-12T08:00:00.000Z'
const CATALOG = editorCatalog()

function device(catalog: CatalogLookup, id: string): Device {
  const found = catalog.device(id)
  if (found === undefined) throw new Error(`No device "${id}"`)
  return found
}

function placementOf(plan: Plan, id: string): Placement {
  const placement = plan.placements.find((candidate) => candidate.id === id)
  if (placement === undefined) throw new Error(`No placement "${id}"`)
  return placement
}

function applied(result: DeviceOpResult): Plan {
  if (result.error !== undefined) throw new Error(result.error)
  expect(result.conflicts).toEqual([])
  return result.plan
}

/** The user's built 3U (sec-1, sixths 0–18) + 6U (sec-2, 18–54). */
function rack(spec: KwsPlanSpec = {}): Plan {
  return kwsPlan({
    sections: [
      { u: 3, have: true },
      { u: 6, have: true },
    ],
    ...spec,
  })
}

const M720Q = device(CATALOG, EDITOR_IDS.m720q)
const DS224 = device(CATALOG, EDITOR_IDS.ds224)
const PI = device(CATALOG, EDITOR_IDS.rpi5)

// ---------------------------------------------------------------------------------------------
// Suggestions and estimates

describe('mountSuggestions', () => {
  it('puts mounts made for this frame first, then the least rack space', () => {
    expect(mountSuggestions(DS224, CATALOG, KWS_FRAME)).toEqual([
      {
        itemId: EDITOR_IDS.ds224Module,
        slotId: 'cradle',
        heightSixths: 24,
        frameSpecific: true,
      },
      { itemId: EDITOR_IDS.nasShelf, slotId: 'deck', heightSixths: 18, frameSpecific: false },
    ])
  })

  it('skips mounts made for other frames only', () => {
    const labRax: Frame = { ...KWS_FRAME, id: 'lab-rax', name: 'Lab Rax' }
    expect(mountSuggestions(DS224, CATALOG, labRax)).toEqual([
      {
        itemId: EDITOR_IDS.otherFrameMount,
        slotId: 'bay',
        heightSixths: 24,
        frameSpecific: true,
      },
      { itemId: EDITOR_IDS.nasShelf, slotId: 'deck', heightSixths: 18, frameSpecific: false },
    ])
  })

  it('lists only slots that accept and fit the device', () => {
    expect(mountSuggestions(M720Q, CATALOG, KWS_FRAME)).toEqual([
      { itemId: EDITOR_IDS.tinyMount, slotId: 'bay', heightSixths: 6, frameSpecific: false },
      { itemId: EDITOR_IDS.shelf2u, slotId: 'deck', heightSixths: 12, frameSpecific: false },
    ])
    expect(mountSuggestions(PI, CATALOG, KWS_FRAME).map((s) => s.itemId)).toEqual([
      EDITOR_IDS.sbcHalf,
      EDITOR_IDS.shelf2u,
    ])
    const tower = device(CATALOG, EDITOR_IDS.towerUps)
    expect(mountSuggestions(tower, CATALOG, KWS_FRAME)).toEqual([])
  })

  it('counts a device standing taller than its mount', () => {
    const [tall] = parseEntries([
      {
        kind: 'device',
        id: 'tall-box',
        brand: 'Fixture',
        model: 'Tall box',
        category: 'other',
        dims: { w: 100, d: 100, h: 80 },
        verified: { by: 'fixture', date: '2026-10-11', method: 'page' },
      },
    ])
    const catalog = editorCatalog(tall === undefined ? [] : [tall])
    // 2U shelf: 5 mm floor + 80 mm + 5 mm headroom = 90 mm -> 13 sixths.
    expect(mountSuggestions(device(catalog, 'tall-box'), catalog, KWS_FRAME)).toEqual([
      { itemId: EDITOR_IDS.shelf2u, slotId: 'deck', heightSixths: 13, frameSpecific: false },
    ])
  })

  it('breaks ties by name and leaves out extras', () => {
    const verified = { by: 'fixture', date: '2026-10-11', method: 'page' }
    const slot = {
      id: 'board',
      kind: 'fixed',
      maxW: 100,
      maxD: 100,
      maxH: 30,
      layout: { xMm: 5, yMm: 3, zMm: 0 },
    }
    const extras = parseEntries(
      ['Zeta SBC mount', 'alpha SBC mount', 'SBC mount 10'].map((name, index) => ({
        kind: 'item',
        id: `sbc-mount-${index + 1}`,
        name,
        category: 'sbc-mount',
        verified,
        heightSixths: 6,
        depthMm: 100,
        mount: { front: 4 },
        slots: [slot],
      })),
    )
    const [loose] = parseEntries([
      {
        kind: 'extra',
        id: 'loose-tray',
        name: 'A loose tray',
        category: 'accessory',
        verified,
        heightSixths: 0,
        depthMm: 0,
        slots: [slot],
      },
    ])
    const catalog = editorCatalog([...extras, ...(loose === undefined ? [] : [loose])])
    expect(mountSuggestions(PI, catalog, KWS_FRAME).map((s) => s.itemId)).toEqual([
      'sbc-mount-2', // alpha
      EDITOR_IDS.sbcHalf, // Half-width
      'sbc-mount-3', // SBC mount 10
      'sbc-mount-1', // Zeta
      EDITOR_IDS.shelf2u,
    ])
  })

  it('returns at most `limit` suggestions', () => {
    expect(DEFAULT_MOUNT_SUGGESTIONS).toBe(5)
    expect(mountSuggestions(PI, CATALOG, KWS_FRAME, 1).map((s) => s.itemId)).toEqual([
      EDITOR_IDS.sbcHalf,
    ])
    expect(mountSuggestions(PI, CATALOG, KWS_FRAME, 1.8)).toHaveLength(1)
    expect(mountSuggestions(PI, CATALOG, KWS_FRAME, 0)).toEqual([])
    expect(mountSuggestions(PI, CATALOG, KWS_FRAME, -3)).toEqual([])
    expect(mountSuggestions(PI, CATALOG, KWS_FRAME, Number.NaN)).toEqual([])
  })
})

describe('slotForDevice', () => {
  it('picks the first slot that accepts and fits, with its orientation', () => {
    const shelf = CATALOG.item(EDITOR_IDS.shelf2u)
    const wide = device(CATALOG, EDITOR_IDS.wideBox)
    expect(slotForDevice(shelf?.slots ?? [], wide)).toMatchObject({
      slot: { id: 'deck' },
      orientation: 'flat-rotated',
    })
    expect(slotForDevice(CATALOG.item(EDITOR_IDS.tinyMount)?.slots ?? [], PI)).toBeUndefined()
    expect(slotForDevice([], PI)).toBeUndefined()
  })
})

describe('estimateDeviceSixths', () => {
  it('uses ear-mounted gear’s own height', () => {
    const pdu = device(CATALOG, EDITOR_IDS.pdu)
    expect(estimateDeviceSixths(pdu, CATALOG, KWS_FRAME)).toEqual({ sixths: 6, via: 'rackmount' })
  })

  it('uses the best mount: the 1U Tiny mount, the KWS-only 4U module', () => {
    expect(estimateDeviceSixths(M720Q, CATALOG, KWS_FRAME)).toEqual({
      sixths: 6,
      via: 'mount',
      itemId: EDITOR_IDS.tinyMount,
    })
    expect(estimateDeviceSixths(DS224, CATALOG, KWS_FRAME)).toEqual({
      sixths: 24,
      via: 'mount',
      itemId: EDITOR_IDS.ds224Module,
    })
  })

  it('estimates whole U from the height plus 6 mm without a mount', () => {
    const tower = device(CATALOG, EDITOR_IDS.towerUps)
    // (230 + 6) / 44.45 = 5.3 -> 6U
    expect(estimateDeviceSixths(tower, CATALOG, KWS_FRAME)).toEqual({ sixths: 36, via: 'estimate' })
    expect(estimateSixthsFromHeight(38.45)).toBe(6)
    expect(estimateSixthsFromHeight(38.46)).toBe(12)
    expect(estimateSixthsFromHeight(1)).toBe(6)
    expect(estimateSixthsFromHeight(0)).toBe(6)
  })
})

describe('smallestStackU', () => {
  const types = (heights: Array<number | { min: number; max: number }>): SectionType[] =>
    heights.map((heightU, index) => ({ id: `t${index}`, label: `Type ${index}`, heightU }))

  it('rounds up to what the section types add up to', () => {
    const kws = KWS_FRAME.sectionTypes
    expect([0, 1, 3, 4, 7, 9].map((u) => smallestStackU(u, kws))).toEqual([0, 3, 3, 6, 9, 9])
    const sixTen = types([6, 10])
    expect([1, 7, 11, 13, 14, 17].map((u) => smallestStackU(u, sixTen))).toEqual([
      6, 10, 12, 16, 16, 18,
    ])
    expect([1, 5, 23].map((u) => smallestStackU(u, RANGE_FRAME.sectionTypes))).toEqual([1, 5, 23])
    expect([1, 3].map((u) => smallestStackU(u, types([{ min: 2, max: 4 }])))).toEqual([2, 3])
  })

  it('is undefined when nothing can be made', () => {
    expect(smallestStackU(3, [])).toBeUndefined()
    expect(smallestStackU(3, types([{ min: 5, max: 4 }]))).toBeUndefined()
    expect(smallestStackU(Number.NaN, KWS_FRAME.sectionTypes)).toBeUndefined()
    expect(smallestStackU(Number.POSITIVE_INFINITY, KWS_FRAME.sectionTypes)).toBeUndefined()
  })

  it('stays fast: huge ranges are cut to what matters, huge targets are not searched', () => {
    expect(smallestStackU(7, types([{ min: 3, max: 1_000_000_000 }]))).toBe(7)
    expect(smallestStackU(2, types([{ min: 3, max: 1_000_000_000 }]))).toBe(3)
    expect(smallestStackU(MAX_STACK_SEARCH_U - 2, KWS_FRAME.sectionTypes)).toBe(999)
    expect(smallestStackU(MAX_STACK_SEARCH_U, KWS_FRAME.sectionTypes)).toBeUndefined()
    expect(smallestStackU(1e9, KWS_FRAME.sectionTypes)).toBeUndefined()
  })

  test.prop([fc.integer({ min: 0, max: 120 })])(
    'KWS: the next multiple of 3U at or above the target',
    (minU) => {
      const result = smallestStackU(minU, KWS_FRAME.sectionTypes)
      expect(result).toBe(Math.ceil(minU / 3) * 3)
    },
  )

  /** Every height up to `limit` that some sum of the steps makes (plain DP over all steps). */
  function reachableUpTo(limit: number, steps: readonly number[]): boolean[] {
    const reachable = [true]
    for (let u = 1; u <= limit; u++) {
      reachable[u] = steps.some((step) => step <= u && reachable[u - step] === true)
    }
    return reachable
  }

  test.prop([
    fc.array(fc.integer({ min: 1, max: 12 }), { maxLength: 3 }),
    fc.option(
      fc.record({ min: fc.integer({ min: 1, max: 10 }), span: fc.integer({ min: 0, max: 5 }) }),
      { nil: undefined },
    ),
    fc.integer({ min: 0, max: 60 }),
  ])('matches a brute-force search', (fixed, range, minU) => {
    const sectionTypes = types([
      ...fixed,
      ...(range === undefined ? [] : [{ min: range.min, max: range.min + range.span }]),
    ])
    const steps = [
      ...fixed,
      ...(range === undefined
        ? []
        : Array.from({ length: range.span + 1 }, (_, index) => range.min + index)),
    ]
    const reachable = reachableUpTo(minU + 30, steps)
    const expected = reachable.findIndex((ok, u) => ok && u >= minU)
    expect(smallestStackU(minU, sectionTypes)).toBe(expected === -1 ? undefined : expected)
  })
})

describe('equipmentUSummary', () => {
  /** `count` 1U blanks from U1 up. */
  const blanks = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      placementAt(CATALOG, `pl-blank-${index + 1}`, EDITOR_IDS.blank1u, index * 6),
    )
  const tray = [
    { id: 'eq-m720q', deviceId: EDITOR_IDS.m720q, have: true },
    { id: 'eq-ds', deviceId: EDITOR_IDS.ds224 },
  ]

  it('Lenovo M720q + Synology DS224+ in a 9U KWS with 2U free: +3U', () => {
    const summary = equipmentUSummary(
      rack({ placements: blanks(7), equipment: tray }),
      CATALOG,
      KWS_FRAME,
    )
    expect(summary).toEqual({
      rackSixths: 54,
      usedSixths: 42,
      freeSixths: 12,
      neededSixths: 30,
      shortfallSixths: 18,
      perDevice: [
        {
          equipmentId: 'eq-m720q',
          deviceId: EDITOR_IDS.m720q,
          sixths: 6,
          via: 'mount',
          itemId: EDITOR_IDS.tinyMount,
        },
        {
          equipmentId: 'eq-ds',
          deviceId: EDITOR_IDS.ds224,
          sixths: 24,
          via: 'mount',
          itemId: EDITOR_IDS.ds224Module,
        },
      ],
    })
  })

  it('rounds a 4U shortfall up to 6U: KWS grows in 3U steps', () => {
    const summary = equipmentUSummary(
      rack({ placements: blanks(8), equipment: tray }),
      CATALOG,
      KWS_FRAME,
    )
    expect(summary).toMatchObject({ usedSixths: 48, freeSixths: 6, neededSixths: 30 })
    expect(summary.shortfallSixths).toBe(36)
  })

  it('has no shortfall when the equipment fits', () => {
    const summary = equipmentUSummary(rack({ equipment: tray }), CATALOG, KWS_FRAME)
    expect(summary).toMatchObject({ usedSixths: 0, freeSixths: 54, neededSixths: 30 })
    expect(summary.shortfallSixths).toBe(0)
    const empty = equipmentUSummary(rack(), CATALOG, KWS_FRAME)
    expect(empty).toMatchObject({ neededSixths: 0, shortfallSixths: 0, perDevice: [] })
  })

  it('counts the front once per sixth, inside the rack, with shelves up to their devices', () => {
    const [tall] = parseEntries([
      {
        kind: 'device',
        id: 'tall-box',
        brand: 'Fixture',
        model: 'Tall box',
        category: 'other',
        dims: { w: 100, d: 100, h: 80 },
        verified: { by: 'fixture', date: '2026-10-11', method: 'page' },
      },
    ])
    const catalog = editorCatalog(tall === undefined ? [] : [tall])
    const plan = rack({
      placements: [
        // A 2U shelf with an 80 mm box reaches 13 sixths.
        placementAt(catalog, 'pl-shelf', EDITOR_IDS.shelf2u, 0, {
          devices: [{ id: 'dv-tall', deviceId: 'tall-box', slotId: 'deck', xMm: 0 }],
        }),
        // Overlapping the shelf's top: counted once.
        placementAt(catalog, 'pl-overlap', EDITOR_IDS.blank1u, 12),
        // Rear-face gear leaves the front free.
        placementAt(catalog, 'pl-rear', EDITOR_IDS.blank1u, 30, { face: 'rear' }),
        // Half outside the rack: only the part inside counts.
        placementAt(catalog, 'pl-top', EDITOR_IDS.shelf2u, 48),
        placementAt(catalog, 'pl-below', EDITOR_IDS.blank1u, -6),
      ],
    })
    // [0, 18) + [48, 54)
    expect(equipmentUSummary(plan, catalog, KWS_FRAME)).toMatchObject({
      usedSixths: 24,
      freeSixths: 30,
    })
  })

  it('skips unknown devices and rounds to whole U on frames with any height', () => {
    const plan = kwsPlan({
      sections: [3],
      equipment: [
        { id: 'eq-ghost', deviceId: 'ghost-device' },
        { id: 'eq-m720q', deviceId: EDITOR_IDS.m720q },
        { id: 'eq-m720q-2', deviceId: EDITOR_IDS.m720q },
      ],
      placements: [placementAt(CATALOG, 'pl-1', EDITOR_IDS.shelf2u, 0)],
    })
    const kws = equipmentUSummary(plan, CATALOG, KWS_FRAME)
    expect(kws.perDevice.map((entry) => entry.equipmentId)).toEqual(['eq-m720q', 'eq-m720q-2'])
    expect(kws).toMatchObject({ freeSixths: 6, neededSixths: 12, shortfallSixths: 18 })

    // With a 1U section type any whole U can be added.
    const withBlocks: Frame = {
      ...KWS_FRAME,
      sectionTypes: [...KWS_FRAME.sectionTypes, { id: 'u1', label: '1U block', heightU: 1 }],
    }
    expect(equipmentUSummary(plan, CATALOG, withBlocks).shortfallSixths).toBe(6)
  })

  it('falls back to whole U for an absurd custom device', () => {
    const plan = kwsPlan({
      sections: [3],
      equipment: [{ id: 'eq-huge', deviceId: 'custom:huge-box' }],
      custom: {
        devices: [
          {
            kind: 'device',
            id: 'custom:huge-box',
            brand: 'Me',
            model: 'Huge box',
            category: 'other',
            dims: { w: 100, d: 100, h: 1_000_000 },
            verified: { by: 'me', date: '2026-10-11', method: 'unverified' },
          },
        ],
      },
    })
    const summary = equipmentUSummary(plan, CATALOG, KWS_FRAME)
    // (1,000,000 + 6) / 44.45 -> 22,498U; 3U of rack is free.
    expect(summary.perDevice).toEqual([
      { equipmentId: 'eq-huge', deviceId: 'custom:huge-box', sixths: 22_498 * 6, via: 'estimate' },
    ])
    expect(summary.shortfallSixths).toBe((22_498 - 3) * 6)
  })
})

// ---------------------------------------------------------------------------------------------
// The tray

describe('addEquipment / removeEquipment', () => {
  const plan = rack()

  it('adds a tray entry with a new id and the owned flag', () => {
    const added = addEquipment(plan, EDITOR_IDS.ds224, true)
    expect(added.equipment).toHaveLength(1)
    const [entry] = added.equipment
    expect(entry).toMatchObject({ deviceId: EDITOR_IDS.ds224, have: true })
    expect(entry?.id).toMatch(/^eq-[0-9a-z]{12}$/)
    const twice = addEquipment(added, EDITOR_IDS.ds224, false)
    expect(twice.equipment.map((item) => item.have)).toEqual([true, false])
    expect(new Set(twice.equipment.map((item) => item.id)).size).toBe(2)
    expect(addEquipment(plan, 'custom:my-nas', false).equipment[0]?.deviceId).toBe('custom:my-nas')
  })

  it('ignores malformed device ids', () => {
    for (const bad of ['', 'Not An Id', 'a--b', 'x'.repeat(101), 'custom:']) {
      expect(addEquipment(plan, bad, true)).toBe(plan)
    }
  })

  it('removes one entry and ignores unknown ids', () => {
    const withTwo = rack({
      equipment: [
        { id: 'eq-1', deviceId: EDITOR_IDS.ds224, have: true },
        { id: 'eq-2', deviceId: EDITOR_IDS.rpi5 },
      ],
    })
    expect(removeEquipment(withTwo, 'eq-1').equipment.map((entry) => entry.id)).toEqual(['eq-2'])
    expect(removeEquipment(withTwo, 'eq-9')).toBe(withTwo)
  })
})

// ---------------------------------------------------------------------------------------------
// Devices in slots

describe('assignDevice: fixed slots', () => {
  const plan = rack({
    placements: [
      placementAt(CATALOG, 'pl-tiny', EDITOR_IDS.tinyMount, 0),
      placementAt(CATALOG, 'pl-blank', EDITOR_IDS.blank1u, 6),
      placementAt(CATALOG, 'pl-pdu', EDITOR_IDS.pdu, 12),
    ],
  })

  it('puts the device in the cradle, owned or not', () => {
    const result = assignDevice(plan, CATALOG, 'pl-tiny', 'bay', EDITOR_IDS.m720q, true)
    const next = applied(result)
    expect(result.placementId).toBe('pl-tiny')
    expect(placementOf(next, 'pl-tiny').devices).toEqual([
      {
        id: result.deviceEntryId,
        deviceId: EDITOR_IDS.m720q,
        slotId: 'bay',
        orientation: 'flat',
        have: true,
      },
    ])
    expect(result.deviceEntryId).toMatch(/^dv-/)
    expect(placementOf(next, 'pl-blank')).toBe(placementOf(plan, 'pl-blank'))
  })

  it('holds one device', () => {
    const once = applied(assignDevice(plan, CATALOG, 'pl-tiny', 'bay', EDITOR_IDS.m720q, true))
    const twice = assignDevice(once, CATALOG, 'pl-tiny', 'bay', EDITOR_IDS.m720q, false)
    expect(twice.plan).toBe(once)
    expect(twice.error).toBe(
      'Slot "bay" of Lenovo Tiny mount already holds the Lenovo ThinkCentre M720q Tiny; it takes one device.',
    )
  })

  it('turns the device when only the other orientation fits', () => {
    const result = assignDevice(plan, CATALOG, 'pl-tiny', 'bay', EDITOR_IDS.rotatedMiniPc, false)
    expect(placementOf(applied(result), 'pl-tiny').devices[0]?.orientation).toBe('flat-rotated')
  })

  it('explains why a device cannot go in', () => {
    const cases: Array<[string, string, string, string]> = [
      [
        'pl-tiny',
        'bay',
        EDITOR_IDS.bigMiniPc,
        'The Fixture Big mini PC (190 × 190 × 40 mm) does not fit slot "bay" (182 × 186 × 37 mm) in any allowed orientation.',
      ],
      ['pl-tiny', 'bay', EDITOR_IDS.rpi5, 'Slot "bay" is not made for the Raspberry Pi 5.'],
      ['pl-tiny', 'deck', EDITOR_IDS.m720q, 'Lenovo Tiny mount has no slot "deck".'],
      ['pl-blank', 'bay', EDITOR_IDS.m720q, '1U blank has no slots for devices.'],
      ['pl-pdu', 'bay', EDITOR_IDS.m720q, 'Fixture 4-outlet 10" PDU has no slots for devices.'],
      ['pl-tiny', 'bay', 'ghost-device', '"ghost-device" is not in the catalog.'],
      ['pl-nope', 'bay', EDITOR_IDS.m720q, 'There is no placement "pl-nope" here.'],
    ]
    for (const [placementId, slotId, deviceId, error] of cases) {
      const result = assignDevice(plan, CATALOG, placementId, slotId, deviceId, false)
      expect(result).toEqual({ plan, conflicts: [], error })
      expect(result.plan).toBe(plan)
    }
  })
})

describe('assignDevice: area slots', () => {
  const shelfWith = (devices: PlacedDevice[] = []) =>
    rack({ placements: [placementAt(CATALOG, 'pl-shelf', EDITOR_IDS.shelf2u, 0, { devices })] })
  const deck = (plan: Plan) => placementOf(plan, 'pl-shelf').devices

  it('packs left to right with a 5 mm gap, then reports the room left', () => {
    const one = applied(assignDevice(shelfWith(), CATALOG, 'pl-shelf', 'deck', PI.id, false))
    const two = applied(assignDevice(one, CATALOG, 'pl-shelf', 'deck', PI.id, true))
    expect(deck(two).map(({ xMm, orientation, have }) => ({ xMm, orientation, have }))).toEqual([
      { xMm: 0, orientation: 'flat', have: false },
      { xMm: 90, orientation: 'flat', have: true },
    ])
    const three = assignDevice(two, CATALOG, 'pl-shelf', 'deck', PI.id, false)
    expect(three.plan).toBe(two)
    expect(three.error).toBe(
      'No room left in slot "deck" of 2U shelf for the Raspberry Pi 5: 35 mm of 215 mm is free (it needs 56 mm).',
    )
  })

  it('turns a device that only fits rotated', () => {
    const next = applied(
      assignDevice(shelfWith(), CATALOG, 'pl-shelf', 'deck', EDITOR_IDS.wideBox, false),
    )
    expect(deck(next)[0]).toMatchObject({ xMm: 0, orientation: 'flat-rotated' })
  })

  it('positions every device in the slot and keeps stored orientations', () => {
    const plan = shelfWith([
      { id: 'dv-a', deviceId: PI.id, slotId: 'deck', orientation: 'flat-rotated', have: true },
      { id: 'dv-b', deviceId: PI.id, slotId: 'deck', have: false },
    ])
    const next = applied(assignDevice(plan, CATALOG, 'pl-shelf', 'deck', 'pi-zero-usb', false))
    expect(deck(next).map(({ id, xMm, orientation }) => ({ id, xMm, orientation }))).toEqual([
      { id: 'dv-a', xMm: 0, orientation: 'flat-rotated' },
      { id: 'dv-b', xMm: 61, orientation: 'flat' },
      // 64 mm left: the Pi Zero turns to fit.
      {
        id: expect.stringMatching(/^dv-/) as unknown as string,
        xMm: 151,
        orientation: 'flat-rotated',
      },
    ])
    expect(deck(next)[0]?.have).toBe(true)
  })

  it('refuses a device into a slot that is already over-full', () => {
    const plan = shelfWith(
      ['dv-a', 'dv-b', 'dv-c'].map((id) => ({
        id,
        deviceId: PI.id,
        slotId: 'deck',
        orientation: 'flat' as const,
        have: false,
      })),
    )
    const result = assignDevice(plan, CATALOG, 'pl-shelf', 'deck', 'pi-zero-usb', false)
    expect(result.plan).toBe(plan)
    expect(result.error).toBe(
      'Slot "deck" of 2U shelf is already over-full (Raspberry Pi 5 does not fit), so nothing more can go in.',
    )
  })

  it('keeps devices of other slots and unknown devices where they are', () => {
    const plan = shelfWith([
      { id: 'dv-ghost', deviceId: 'ghost-device', slotId: 'deck', xMm: 150, have: false },
      { id: 'dv-other', deviceId: PI.id, slotId: 'other', xMm: 7, have: false },
    ])
    const next = applied(assignDevice(plan, CATALOG, 'pl-shelf', 'deck', PI.id, false))
    expect(deck(next).slice(0, 2)).toEqual(deck(plan))
    expect(deck(next)[2]).toMatchObject({ xMm: 0, deviceId: PI.id })
  })

  it('never mutates its input', () => {
    const plan = shelfWith([{ id: 'dv-b', deviceId: PI.id, slotId: 'deck', have: false }])
    const copy = structuredClone(plan)
    assignDevice(plan, CATALOG, 'pl-shelf', 'deck', PI.id, false)
    expect(plan).toEqual(copy)
  })
})

describe('assignEquipment', () => {
  const plan = rack({
    placements: [placementAt(CATALOG, 'pl-shelf', EDITOR_IDS.shelf2u, 0)],
    equipment: [
      { id: 'eq-pi', deviceId: EDITOR_IDS.rpi5, have: true },
      { id: 'eq-tower', deviceId: EDITOR_IDS.towerUps },
    ],
  })

  it('moves a tray device into a slot with its owned flag', () => {
    const result = assignEquipment(plan, CATALOG, 'pl-shelf', 'deck', 'eq-pi')
    const next = applied(result)
    expect(next.equipment.map((entry) => entry.id)).toEqual(['eq-tower'])
    expect(placementOf(next, 'pl-shelf').devices).toEqual([
      expect.objectContaining({ id: result.deviceEntryId, deviceId: PI.id, have: true }),
    ])
  })

  it('keeps the tray as it is when the device does not fit', () => {
    const result = assignEquipment(plan, CATALOG, 'pl-shelf', 'deck', 'eq-tower')
    expect(result.plan).toBe(plan)
    expect(result.error).toMatch(/does not fit slot "deck"/)
    expect(assignEquipment(plan, CATALOG, 'pl-shelf', 'deck', 'eq-nope').error).toBe(
      'There is no "eq-nope" in Equipment to fit.',
    )
  })
})

describe('removeDevice', () => {
  const plan = rack({
    placements: [
      placementAt(CATALOG, 'pl-shelf', EDITOR_IDS.shelf2u, 0, {
        devices: [
          { id: 'dv-a', deviceId: PI.id, slotId: 'deck', xMm: 0, have: true },
          { id: 'dv-b', deviceId: PI.id, slotId: 'deck', xMm: 90, have: false },
          { id: 'dv-c', deviceId: 'pi-zero-usb', slotId: 'deck', xMm: 180, have: false },
        ],
      }),
    ],
  })
  const deckIds = (current: Plan) => placementOf(current, 'pl-shelf').devices.map((d) => d.id)

  it('drops a planned device and leaves the others where they are', () => {
    const next = removeDevice(plan, 'pl-shelf', 'dv-b')
    expect(deckIds(next)).toEqual(['dv-a', 'dv-c'])
    expect(placementOf(next, 'pl-shelf').devices[1]?.xMm).toBe(180)
    expect(next.equipment).toEqual([])
  })

  it('puts an owned device back in the tray', () => {
    const next = removeDevice(plan, 'pl-shelf', 'dv-a')
    expect(deckIds(next)).toEqual(['dv-b', 'dv-c'])
    expect(next.equipment).toEqual([
      { id: expect.stringMatching(/^eq-/) as unknown as string, deviceId: PI.id, have: true },
    ])
  })

  it('follows `toTray` when given', () => {
    expect(removeDevice(plan, 'pl-shelf', 'dv-a', { toTray: false }).equipment).toEqual([])
    expect(removeDevice(plan, 'pl-shelf', 'dv-b', { toTray: true }).equipment).toMatchObject([
      { deviceId: PI.id, have: false },
    ])
  })

  it('returns the same plan for unknown ids', () => {
    expect(removeDevice(plan, 'pl-shelf', 'dv-x')).toBe(plan)
    expect(removeDevice(plan, 'pl-x', 'dv-a')).toBe(plan)
  })
})

// ---------------------------------------------------------------------------------------------
// Placing tray devices

describe('placeEquipmentOnMount', () => {
  const plan = rack({
    placements: [placementAt(CATALOG, 'pl-blank', EDITOR_IDS.blank1u, 6)],
    equipment: [
      { id: 'eq-m720q', deviceId: EDITOR_IDS.m720q, have: true },
      { id: 'eq-ds', deviceId: EDITOR_IDS.ds224 },
      { id: 'eq-pdu', deviceId: EDITOR_IDS.pdu, have: true },
      { id: 'eq-pi', deviceId: EDITOR_IDS.rpi5 },
      { id: 'eq-big', deviceId: EDITOR_IDS.bigMiniPc },
      { id: 'eq-ghost', deviceId: 'ghost-device' },
    ],
  })
  const trayIds = (current: Plan) => current.equipment.map((entry) => entry.id)

  it('creates the mount with the tray device in it and empties that tray entry', () => {
    const result = placeEquipmentOnMount(
      plan,
      CATALOG,
      KWS_FRAME,
      'eq-m720q',
      EDITOR_IDS.tinyMount,
      0,
      'front',
    )
    const next = applied(result)
    const placement = placementOf(next, result.placementId ?? '')
    expect(placement).toEqual({
      id: result.placementId,
      itemId: EDITOR_IDS.tinyMount,
      name: 'Lenovo Tiny mount',
      heightSixths: 6,
      y: 0,
      face: 'front',
      bay: 'full',
      devices: [
        {
          id: result.deviceEntryId,
          deviceId: EDITOR_IDS.m720q,
          slotId: 'bay',
          orientation: 'flat',
          have: true,
        },
      ],
    })
    expect(placement.have).toBeUndefined()
    expect(trayIds(next)).toEqual(['eq-ds', 'eq-pdu', 'eq-pi', 'eq-big', 'eq-ghost'])
    // The result is a valid spot for what it holds.
    expect(
      canPlace(next, CATALOG, KWS_FRAME, { ...placement, ignorePlacementId: placement.id }).ok,
    ).toBe(true)
  })

  it('puts the DS224+ in its KWS module, still to get', () => {
    const result = placeEquipmentOnMount(
      plan,
      CATALOG,
      KWS_FRAME,
      'eq-ds',
      EDITOR_IDS.ds224Module,
      24,
      'front',
    )
    const placement = placementOf(applied(result), result.placementId ?? '')
    expect(placement).toMatchObject({ y: 24, heightSixths: 24 })
    expect(placement.devices).toMatchObject([
      { deviceId: EDITOR_IDS.ds224, slotId: 'cradle', orientation: 'flat', have: false },
    ])
  })

  it('packs a device on a shelf at the left edge', () => {
    const result = placeEquipmentOnMount(
      plan,
      CATALOG,
      KWS_FRAME,
      'eq-pi',
      EDITOR_IDS.shelf2u,
      30,
      'front',
    )
    const placement = placementOf(applied(result), result.placementId ?? '')
    expect(placement.devices).toMatchObject([{ slotId: 'deck', xMm: 0, orientation: 'flat' }])
  })

  it('places ear-mounted gear itself, keeping it owned', () => {
    const result = placeEquipmentOnMount(
      plan,
      CATALOG,
      KWS_FRAME,
      'eq-pdu',
      EDITOR_IDS.pdu,
      48,
      'front',
      { at: LATER },
    )
    const next = applied(result)
    const placement = placementOf(next, result.placementId ?? '')
    expect(placement).toMatchObject({ itemId: EDITOR_IDS.pdu, y: 48, devices: [] })
    expect(placement.have).toEqual({ at: LATER, itemId: EDITOR_IDS.pdu, options: {} })
    expect(result.deviceEntryId).toBeUndefined()
    expect(trayIds(next)).not.toContain('eq-pdu')

    const planned = rack({ equipment: [{ id: 'eq-pdu', deviceId: EDITOR_IDS.pdu }] })
    const plannedResult = placeEquipmentOnMount(
      planned,
      CATALOG,
      KWS_FRAME,
      'eq-pdu',
      EDITOR_IDS.pdu,
      0,
      'front',
    )
    expect(placementOf(applied(plannedResult), plannedResult.placementId ?? '').have).toBe(
      undefined,
    )
  })

  it('uses the other bay for half-width mounts when one is taken', () => {
    const halfTaken = rack({
      placements: [placementAt(CATALOG, 'pl-left', EDITOR_IDS.sbcHalf, 0, { bay: 'left' })],
      equipment: [
        { id: 'eq-pi', deviceId: EDITOR_IDS.rpi5 },
        { id: 'eq-pi-2', deviceId: EDITOR_IDS.rpi5 },
      ],
    })
    const result = placeEquipmentOnMount(
      halfTaken,
      CATALOG,
      KWS_FRAME,
      'eq-pi',
      EDITOR_IDS.sbcHalf,
      0,
      'front',
    )
    const next = applied(result)
    expect(placementOf(next, result.placementId ?? '').bay).toBe('right')
    const full = placeEquipmentOnMount(
      next,
      CATALOG,
      KWS_FRAME,
      'eq-pi-2',
      EDITOR_IDS.sbcHalf,
      0,
      'front',
    )
    expect(full.plan).toBe(next)
    expect(full.error).toMatch(/^Half-width SBC mount cannot go at U1 on the front\. It overlaps/)
  })

  it('checks the bay the caller asks for', () => {
    const halfTaken = rack({
      placements: [placementAt(CATALOG, 'pl-left', EDITOR_IDS.sbcHalf, 0, { bay: 'left' })],
      equipment: [
        { id: 'eq-pi', deviceId: EDITOR_IDS.rpi5 },
        { id: 'eq-m720q', deviceId: EDITOR_IDS.m720q },
      ],
    })
    const place = (equipmentId: string, itemId: string, bay: 'left' | 'right' | 'full') =>
      placeEquipmentOnMount(halfTaken, CATALOG, KWS_FRAME, equipmentId, itemId, 0, 'front', {
        bay,
      })
    expect(place('eq-pi', EDITOR_IDS.sbcHalf, 'left').error).toMatch(/It overlaps/)
    const right = place('eq-pi', EDITOR_IDS.sbcHalf, 'right')
    expect(placementOf(applied(right), right.placementId ?? '').bay).toBe('right')
    expect(place('eq-pi', EDITOR_IDS.sbcHalf, 'full').error).toMatch(
      /Half-width SBC mount is half width: put it on the left or the right\./,
    )
    expect(place('eq-m720q', EDITOR_IDS.tinyMount, 'right').error).toMatch(
      /Lenovo Tiny mount is full width\./,
    )
  })

  it('counts the device on a shelf when checking the spot', () => {
    const [tall] = parseEntries([
      {
        kind: 'device',
        id: 'tall-box',
        brand: 'Fixture',
        model: 'Tall box',
        category: 'other',
        dims: { w: 100, d: 100, h: 80 },
        verified: { by: 'fixture', date: '2026-10-11', method: 'page' },
      },
    ])
    const catalog = editorCatalog(tall === undefined ? [] : [tall])
    const tight = rack({
      placements: [placementAt(catalog, 'pl-blank', EDITOR_IDS.blank1u, 12)],
      equipment: [{ id: 'eq-tall', deviceId: 'tall-box' }],
    })
    // The bare 2U shelf would end at sixth 12; with the box it reaches 13 and hits the blank.
    const result = placeEquipmentOnMount(
      tight,
      catalog,
      KWS_FRAME,
      'eq-tall',
      EDITOR_IDS.shelf2u,
      0,
      'front',
    )
    expect(result.plan).toBe(tight)
    expect(result.error).toMatch(/It overlaps 1U blank \(U3\)\./)
    const roomy = placeEquipmentOnMount(
      tight,
      catalog,
      KWS_FRAME,
      'eq-tall',
      EDITOR_IDS.shelf2u,
      18,
      'front',
    )
    const placement = placementOf(applied(roomy), roomy.placementId ?? '')
    expect(occupiedBox(roomy.plan, catalog, placement, KWS_FRAME)).toMatchObject({ y0: 18, y1: 31 })
  })

  it('explains every reason a spot is blocked and leaves the plan alone', () => {
    const cases: Array<[string, string, number, 'front' | 'rear', RegExp]> = [
      [
        'eq-m720q',
        EDITOR_IDS.tinyMount,
        6,
        'front',
        /^Lenovo Tiny mount cannot go at U2 on the front\. It overlaps 1U blank \(U2\)\.$/,
      ],
      ['eq-m720q', EDITOR_IDS.tinyMount, 54, 'front', /reach above U9, the top of the rack/],
      ['eq-m720q', EDITOR_IDS.tinyMount, 1, 'front', /cannot start at U1 \+ ⅙U/],
      ['eq-m720q', EDITOR_IDS.tinyMount, 0, 'rear', /mounts on the front only/],
      ['eq-m720q', EDITOR_IDS.tinyMount, -6, 'front', /below U1/],
    ]
    for (const [equipmentId, itemId, y, face, error] of cases) {
      const result = placeEquipmentOnMount(plan, CATALOG, KWS_FRAME, equipmentId, itemId, y, face)
      expect(result.plan).toBe(plan)
      expect(result.conflicts).toEqual([])
      expect(result.error).toMatch(error)
    }
  })

  it('explains devices and mounts that do not go together', () => {
    const cases: Array<[string, string, string]> = [
      [
        'eq-big',
        EDITOR_IDS.tinyMount,
        'The Fixture Big mini PC does not fit Lenovo Tiny mount. The Fixture Big mini PC (190 × 190 × 40 mm) does not fit slot "bay" (182 × 186 × 37 mm) in any allowed orientation.',
      ],
      [
        'eq-m720q',
        EDITOR_IDS.blank1u,
        '1U blank has no slots for devices, so the Lenovo ThinkCentre M720q Tiny cannot go in it.',
      ],
      [
        'eq-m720q',
        EDITOR_IDS.pdu,
        'Fixture 4-outlet 10" PDU has no slots, so the Lenovo ThinkCentre M720q Tiny cannot go in it.',
      ],
      ['eq-m720q', EDITOR_IDS.rubberFeet, '"rubber-feet" is not a mount in the catalog.'],
      ['eq-m720q', 'ghost-mount', '"ghost-mount" is not a mount in the catalog.'],
      [
        'eq-ghost',
        EDITOR_IDS.tinyMount,
        '"ghost-device" is not in the catalog, so it cannot be placed.',
      ],
      ['eq-nope', EDITOR_IDS.tinyMount, 'There is no "eq-nope" in Equipment to fit.'],
    ]
    for (const [equipmentId, itemId, error] of cases) {
      const result = placeEquipmentOnMount(
        plan,
        CATALOG,
        KWS_FRAME,
        equipmentId,
        itemId,
        30,
        'front',
      )
      expect(result).toEqual({ plan, conflicts: [], error })
    }
  })

  test.prop([
    fc.integer({ min: -12, max: 66 }),
    fc.constantFrom('front' as const, 'rear' as const),
  ])('either places at a spot canPlace accepts or changes nothing', (y, face) => {
    const result = placeEquipmentOnMount(
      plan,
      CATALOG,
      KWS_FRAME,
      'eq-m720q',
      EDITOR_IDS.tinyMount,
      y,
      face,
    )
    if (result.error !== undefined) {
      expect(result.plan).toBe(plan)
      return
    }
    const placement = placementOf(result.plan, result.placementId ?? '')
    expect(placement).toMatchObject({ y, face })
    const check = canPlace(plan, CATALOG, KWS_FRAME, { ...placement })
    expect(check.ok).toBe(true)
    expect(result.plan.equipment).toHaveLength(plan.equipment.length - 1)
  })
})
