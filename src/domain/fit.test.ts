import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import {
  checkDeviceAt,
  findDeviceSpot,
  fitItForMe,
  mountedDevicePreview,
  type FitItForMeResult,
} from './fit'
import { totalHeightU } from './frame'
import { canPlace } from './placement'
import type { CatalogLookup, Device, Frame } from './schema/catalog'
import type { Placement, Plan } from './schema/plan'
import { EDITOR_IDS, editorCatalog, placementAt } from './__fixtures__/editorFixtures'
import { FIXTURE_NOW, KWS_FRAME, kwsPlan, parseEntries, type KwsPlanSpec } from './__fixtures__/kws'

const CATALOG = editorCatalog()

function device(catalog: CatalogLookup, id: string): Device {
  const found = catalog.device(id)
  if (found === undefined) throw new Error(`No device "${id}"`)
  return found
}

/** `count` 1U blanks from `fromU` (1-based) up. */
function blanks(count: number, fromU = 1, catalog: CatalogLookup = CATALOG) {
  return Array.from({ length: count }, (_, index) =>
    placementAt(catalog, `pl-blank-${fromU + index}`, EDITOR_IDS.blank1u, (fromU - 1 + index) * 6),
  )
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

function tray(...deviceIds: string[]): Plan['equipment'] {
  return deviceIds.map((deviceId, index) => ({ id: `eq-${index + 1}`, deviceId, have: false }))
}

function placementFor(result: FitItForMeResult, equipmentId: string): Placement {
  const placed = result.placed.find((entry) => entry.equipmentId === equipmentId)
  const placement = result.plan.placements.find((entry) => entry.id === placed?.placementId)
  if (placement === undefined) throw new Error(`"${equipmentId}" was not placed`)
  return placement
}

/** Where each tray entry went: [mount, y, device in it]. */
function layout(result: FitItForMeResult): Array<[string, string, number, string | undefined]> {
  return result.placed.map(({ equipmentId }) => {
    const placement = placementFor(result, equipmentId)
    return [equipmentId, placement.itemId, placement.y, placement.devices[0]?.deviceId]
  })
}

function sectionsOf(plan: Plan): Array<[string, boolean]> {
  return plan.frame.sections.map((section) => [section.typeId, section.have !== undefined])
}

/** Every placement passes `canPlace` where it is (nothing overlaps, everything is in the rack). */
function expectValidLayout(plan: Plan, catalog: CatalogLookup, frame: Frame): void {
  for (const placement of plan.placements) {
    const check = canPlace(plan, catalog, frame, {
      itemId: placement.itemId,
      y: placement.y,
      face: placement.face,
      bay: placement.bay,
      ignorePlacementId: placement.id,
    })
    expect(check.reasons, `${placement.itemId} at ${placement.y}`).toEqual([])
  }
}

// ---------------------------------------------------------------------------------------------
// fitItForMe

describe('fitItForMe', () => {
  it('KWS 9U with 3 mini PCs and a NAS in the tray: adds 3U at the top and places them all', () => {
    const plan = rack({
      placements: blanks(3),
      equipment: tray(EDITOR_IDS.m720q, EDITOR_IDS.m720q, EDITOR_IDS.ds224, EDITOR_IDS.m720q),
    })
    const result = fitItForMe(plan, CATALOG, KWS_FRAME, 'top', FIXTURE_NOW)

    expect(result.error).toBeUndefined()
    expect(result.conflicts).toEqual([])
    expect(result.addedU).toBe(3)
    expect(result.unplaced).toEqual([])
    expect(sectionsOf(result.plan)).toEqual([
      ['s3', true],
      ['s6', true],
      ['s3', false],
    ])
    // The built sections are untouched.
    expect(result.plan.frame.sections.slice(0, 2)).toEqual(plan.frame.sections)
    // Largest first: the DS224+ module at U4–U7, then the Tiny mounts at U8, U9 and the new U10.
    expect(layout(result)).toEqual([
      ['eq-1', EDITOR_IDS.tinyMount, 42, EDITOR_IDS.m720q],
      ['eq-2', EDITOR_IDS.tinyMount, 48, EDITOR_IDS.m720q],
      ['eq-3', EDITOR_IDS.ds224Module, 18, EDITOR_IDS.ds224],
      ['eq-4', EDITOR_IDS.tinyMount, 54, EDITOR_IDS.m720q],
    ])
    expect(result.plan.equipment).toEqual([])
    expect(totalHeightU(result.plan, KWS_FRAME)).toBe(12)
    expectValidLayout(result.plan, CATALOG, KWS_FRAME)
  })

  it('keeps each device’s Have flag; the new mounts are To get', () => {
    const plan = rack({
      equipment: [
        { id: 'eq-owned', deviceId: EDITOR_IDS.m720q, have: true },
        { id: 'eq-planned', deviceId: EDITOR_IDS.m720q, have: false },
      ],
    })
    const result = fitItForMe(plan, CATALOG, KWS_FRAME, 'top', FIXTURE_NOW)
    expect(result.addedU).toBe(0)
    const owned = placementFor(result, 'eq-owned')
    const planned = placementFor(result, 'eq-planned')
    expect([owned.have, planned.have]).toEqual([undefined, undefined])
    expect(owned.devices.map((entry) => entry.have)).toEqual([true])
    expect(planned.devices.map((entry) => entry.have)).toEqual([false])
  })

  it('places owned ear-mounted gear itself, stamped with the given time', () => {
    const plan = rack({ equipment: [{ id: 'eq-pdu', deviceId: EDITOR_IDS.pdu, have: true }] })
    const result = fitItForMe(plan, CATALOG, KWS_FRAME, 'top', '2026-10-12T08:00:00.000Z')
    const pdu = placementFor(result, 'eq-pdu')
    expect([pdu.itemId, pdu.y, pdu.devices]).toEqual([EDITOR_IDS.pdu, 0, []])
    expect(pdu.have).toEqual({
      at: '2026-10-12T08:00:00.000Z',
      itemId: EDITOR_IDS.pdu,
      options: {},
    })
  })

  it('stops at the frame’s max height and says why the rest is left', () => {
    const shortKws: Frame = { ...KWS_FRAME, stack: { ...KWS_FRAME.stack, maxU: 12 } }
    const plan = rack({
      placements: blanks(3),
      equipment: tray(
        EDITOR_IDS.ds224,
        EDITOR_IDS.m720q,
        EDITOR_IDS.m720q,
        EDITOR_IDS.m720q,
        EDITOR_IDS.m720q,
        EDITOR_IDS.m720q,
        EDITOR_IDS.m720q,
      ),
    })
    const result = fitItForMe(plan, CATALOG, shortKws, 'top', FIXTURE_NOW)
    expect(result.addedU).toBe(3)
    expect(totalHeightU(result.plan, shortKws)).toBe(12)
    // 4U for the module and five Tiny mounts fill U4–U12; the last mini PC waits in the tray.
    expect(result.placed.map((entry) => entry.equipmentId)).toEqual([
      'eq-1',
      'eq-2',
      'eq-3',
      'eq-4',
      'eq-5',
      'eq-6',
    ])
    expect(result.unplaced).toEqual([
      {
        equipmentId: 'eq-7',
        reason:
          'There is no room for it (it needs 1U on Lenovo Tiny mount), even at 12U, the tallest KWS Rack v2 stack.',
      },
    ])
    expect(result.plan.equipment.map((entry) => entry.id)).toEqual(['eq-7'])
    expectValidLayout(result.plan, CATALOG, shortKws)
  })

  it('does nothing with an empty tray', () => {
    const plan = rack({ placements: blanks(9) })
    const result = fitItForMe(plan, CATALOG, KWS_FRAME, 'top', FIXTURE_NOW)
    expect(result).toEqual({ plan, conflicts: [], placed: [], unplaced: [], addedU: 0 })
    expect(result.plan).toBe(plan)
  })

  it('does not grow the rack when the free space is enough', () => {
    const plan = rack({ placements: blanks(4), equipment: tray(EDITOR_IDS.ds224) })
    const result = fitItForMe(plan, CATALOG, KWS_FRAME, 'top', FIXTURE_NOW)
    expect(result.addedU).toBe(0)
    expect(result.plan.frame).toBe(plan.frame)
    expect(layout(result)).toEqual([['eq-1', EDITOR_IDS.ds224Module, 24, EDITOR_IDS.ds224]])
  })

  it('grows at the bottom: what was mounted moves up with its sections', () => {
    const plan = rack({
      placements: blanks(8),
      equipment: tray(EDITOR_IDS.m720q, EDITOR_IDS.m720q),
    })
    const result = fitItForMe(plan, CATALOG, KWS_FRAME, 'bottom', FIXTURE_NOW)
    expect(result.addedU).toBe(3)
    expect(sectionsOf(result.plan)).toEqual([
      ['s3', false],
      ['s3', true],
      ['s6', true],
    ])
    const blankYs = result.plan.placements
      .filter((placement) => placement.itemId === EDITOR_IDS.blank1u)
      .map((placement) => placement.y)
    expect(blankYs).toEqual([18, 24, 30, 36, 42, 48, 54, 60])
    // The lowest free spots are in the new bottom section.
    expect(layout(result).map(([, , y]) => y)).toEqual([0, 6])
    expectValidLayout(result.plan, CATALOG, KWS_FRAME)
  })

  it('finds half-width mounts sharing a U, which the U estimate counts twice', () => {
    const plan = rack({ placements: blanks(8), equipment: tray(EDITOR_IDS.rpi5, EDITOR_IDS.rpi5) })
    const result = fitItForMe(plan, CATALOG, KWS_FRAME, 'top', FIXTURE_NOW)
    expect(result.addedU).toBe(0)
    const bays = result.placed.map(({ equipmentId }) => {
      const placement = placementFor(result, equipmentId)
      return [placement.itemId, placement.y, placement.bay]
    })
    expect(bays).toEqual([
      [EDITOR_IDS.sbcHalf, 48, 'left'],
      [EDITOR_IDS.sbcHalf, 48, 'right'],
    ])
  })

  it('counts a device standing taller than its shelf', () => {
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
    // 2U free at U8–U9, but the 2U shelf with an 80 mm box needs 13 sixths.
    const plan = rack({ placements: blanks(7, 1, catalog), equipment: tray('tall-box') })
    const result = fitItForMe(plan, catalog, KWS_FRAME, 'top', FIXTURE_NOW)
    expect(result.addedU).toBe(3)
    expect(layout(result)).toEqual([['eq-1', EDITOR_IDS.shelf2u, 42, 'tall-box']])
    expectValidLayout(result.plan, catalog, KWS_FRAME)
  })

  it('tries the next mount when the best one has no room', () => {
    // The Lab Rax mount is the best for the DS224+ on Lab Rax but 4U; the 3U NAS shelf fits.
    const labRax: Frame = {
      ...KWS_FRAME,
      id: 'lab-rax',
      name: 'Lab Rax',
      stack: { ...KWS_FRAME.stack, maxU: 9 },
    }
    const plan = rack({ placements: blanks(6), equipment: tray(EDITOR_IDS.ds224) })
    const result = fitItForMe(plan, CATALOG, labRax, 'top', FIXTURE_NOW)
    expect(result.addedU).toBe(0)
    expect(layout(result)).toEqual([['eq-1', EDITOR_IDS.nasShelf, 36, EDITOR_IDS.ds224]])
  })

  it('leaves unknown devices and devices without a mount in the tray, with reasons', () => {
    const plan = rack({
      equipment: tray('mystery-box', EDITOR_IDS.towerUps, EDITOR_IDS.m720q),
    })
    const result = fitItForMe(plan, CATALOG, KWS_FRAME, 'top', FIXTURE_NOW)
    expect(result.addedU).toBe(0)
    expect(result.placed.map((entry) => entry.equipmentId)).toEqual(['eq-3'])
    expect(result.unplaced).toEqual([
      {
        equipmentId: 'eq-1',
        reason: '"mystery-box" is not in the catalog, so its size is unknown.',
      },
      { equipmentId: 'eq-2', reason: 'No mount in the catalog takes the Fixture Tower UPS yet.' },
    ])
    expect(result.plan.equipment.map((entry) => entry.id)).toEqual(['eq-1', 'eq-2'])
  })

  it('never grows the rack for devices it cannot place anyway', () => {
    const plan = rack({ placements: blanks(9), equipment: tray(EDITOR_IDS.towerUps) })
    const result = fitItForMe(plan, CATALOG, KWS_FRAME, 'top', FIXTURE_NOW)
    expect(result.plan).toBe(plan)
    expect(result.addedU).toBe(0)
  })

  it('explains when the rack cannot grow at that end', () => {
    // Plain rails of a height range, built: nothing can be added on top.
    const rails: Frame = {
      ...KWS_FRAME,
      id: 'plain-rails',
      name: 'Plain rails',
      sectionTypes: [{ id: 'rails', label: 'Rails', heightU: { min: 2, max: 22 } }],
      stack: { minU: 2, maxU: 22 },
    }
    const base = rack({ placements: blanks(6), equipment: tray(EDITOR_IDS.m720q) })
    const at = base.frame.sections[0]?.have?.at ?? FIXTURE_NOW
    const plan: Plan = {
      ...base,
      frame: {
        ...base.frame,
        sections: [
          {
            id: 'sec-1',
            typeId: 'rails',
            heightU: 6,
            have: { at, typeId: 'rails', heightU: 6, options: {} },
          },
        ],
      },
    }
    const result = fitItForMe(plan, CATALOG, rails, 'top', FIXTURE_NOW)
    expect(result.plan).toBe(plan)
    expect(result.unplaced).toEqual([
      {
        equipmentId: 'eq-1',
        reason:
          'There is no room for it (it needs 1U on Lenovo Tiny mount), and the rack cannot grow at the top.',
      },
    ])
  })

  it('makes a planned section of a height range taller on plain rails', () => {
    const rails: Frame = {
      ...KWS_FRAME,
      id: 'plain-rails',
      name: 'Plain rails',
      sectionTypes: [{ id: 'rails', label: 'Rails', heightU: { min: 2, max: 22 } }],
      stack: { minU: 2, maxU: 22 },
    }
    const base = kwsPlan({ placements: blanks(5), equipment: tray(EDITOR_IDS.ds224) })
    const plan: Plan = {
      ...base,
      frame: { ...base.frame, sections: [{ id: 'sec-1', typeId: 'rails', heightU: 6 }] },
    }
    // The DS224+ module is made for KWS, so the 3U NAS shelf; 1U is free.
    const top = fitItForMe(plan, CATALOG, rails, 'top', FIXTURE_NOW)
    expect(top.addedU).toBe(2)
    expect(top.plan.frame.sections).toEqual([{ id: 'sec-1', typeId: 'rails', heightU: 8 }])
    expect(layout(top)).toEqual([['eq-1', EDITOR_IDS.nasShelf, 30, EDITOR_IDS.ds224]])

    // At the bottom the new space does not join the free U at the top: 3U more.
    const bottom = fitItForMe(plan, CATALOG, rails, 'bottom', FIXTURE_NOW)
    expect(bottom.addedU).toBe(3)
    expect(bottom.plan.placements.slice(0, 5).map((placement) => placement.y)).toEqual([
      18, 24, 30, 36, 42,
    ])
    expect(layout(bottom)).toEqual([['eq-1', EDITOR_IDS.nasShelf, 0, EDITOR_IDS.ds224]])
  })

  it('never changes its input', () => {
    const plan = rack({
      placements: blanks(3),
      equipment: tray(EDITOR_IDS.m720q, EDITOR_IDS.ds224, EDITOR_IDS.m720q, EDITOR_IDS.m720q),
    })
    const before = structuredClone(plan)
    fitItForMe(plan, CATALOG, KWS_FRAME, 'bottom', FIXTURE_NOW)
    expect(plan).toEqual(before)
  })

  const DEVICE_POOL = [
    EDITOR_IDS.m720q,
    EDITOR_IDS.ds224,
    EDITOR_IDS.rpi5,
    EDITOR_IDS.nas2bay,
    EDITOR_IDS.pdu,
    EDITOR_IDS.towerUps,
    EDITOR_IDS.wideBox,
    EDITOR_IDS.bigMiniPc,
  ]

  test.prop(
    [
      fc.array(fc.constantFrom(...DEVICE_POOL), { maxLength: 8 }),
      fc.uniqueArray(fc.integer({ min: 0, max: 8 }), { maxLength: 9 }),
      fc.constantFrom<'top' | 'bottom'>('top', 'bottom'),
    ],
    { numRuns: 40 },
  )(
    'places without overlaps, within the max height, and accounts for every tray device',
    (deviceIds, blankUs, at) => {
      const plan = rack({
        placements: blankUs.map((u) => placementAt(CATALOG, `pl-b${u}`, EDITOR_IDS.blank1u, u * 6)),
        equipment: tray(...deviceIds),
      })
      const result = fitItForMe(plan, CATALOG, KWS_FRAME, at, FIXTURE_NOW)
      const handled = [...result.placed, ...result.unplaced].map((entry) => entry.equipmentId)
      expect(handled.toSorted()).toEqual(plan.equipment.map((entry) => entry.id).toSorted())
      expect(result.plan.equipment.map((entry) => entry.id)).toEqual(
        result.unplaced.map((entry) => entry.equipmentId),
      )
      const heightU = totalHeightU(result.plan, KWS_FRAME)
      expect(heightU).toBe(9 + result.addedU)
      expect(heightU).toBeLessThanOrEqual(KWS_FRAME.stack.maxU)
      // Built sections stay as they were, in order.
      const built = result.plan.frame.sections.filter((section) => section.have !== undefined)
      expect(built).toEqual(plan.frame.sections)
      expectValidLayout(result.plan, CATALOG, KWS_FRAME)
    },
  )
})

// ---------------------------------------------------------------------------------------------
// Spots

describe('mountedDevicePreview', () => {
  const m720q = device(CATALOG, EDITOR_IDS.m720q)

  it('puts the device in the mount’s first slot that takes it', () => {
    expect(mountedDevicePreview(CATALOG, EDITOR_IDS.tinyMount, m720q, true)).toEqual([
      {
        id: 'fit-preview',
        deviceId: EDITOR_IDS.m720q,
        slotId: 'bay',
        orientation: 'flat',
        have: true,
      },
    ])
    expect(mountedDevicePreview(CATALOG, EDITOR_IDS.shelf2u, m720q)).toEqual([
      {
        id: 'fit-preview',
        deviceId: EDITOR_IDS.m720q,
        slotId: 'deck',
        xMm: 0,
        orientation: 'flat',
        have: false,
      },
    ])
  })

  it('is empty for the device’s own ears, and undefined when the item cannot hold it', () => {
    const pdu = device(CATALOG, EDITOR_IDS.pdu)
    expect(mountedDevicePreview(CATALOG, EDITOR_IDS.pdu, pdu)).toEqual([])
    expect(mountedDevicePreview(CATALOG, EDITOR_IDS.pdu, m720q)).toBeUndefined()
    expect(mountedDevicePreview(CATALOG, EDITOR_IDS.blank1u, m720q)).toBeUndefined()
    expect(mountedDevicePreview(CATALOG, EDITOR_IDS.sbcHalf, m720q)).toBeUndefined()
    expect(mountedDevicePreview(CATALOG, 'no-such-item', m720q)).toBeUndefined()
  })
})

describe('findDeviceSpot', () => {
  const m720q = device(CATALOG, EDITOR_IDS.m720q)
  const plan = rack({
    placements: [...blanks(3), placementAt(CATALOG, 'pl-blank-6', EDITOR_IDS.blank1u, 30)],
  })

  it('finds the lowest free spot, or the one nearest a position', () => {
    expect(findDeviceSpot(plan, CATALOG, KWS_FRAME, EDITOR_IDS.tinyMount, m720q)).toEqual({
      y: 18,
      face: 'front',
      bay: 'full',
    })
    // U6 is taken: U5 and U7 are as near, and the lower one wins.
    expect(
      findDeviceSpot(plan, CATALOG, KWS_FRAME, EDITOR_IDS.tinyMount, m720q, { near: 30 }),
    ).toEqual({ y: 24, face: 'front', bay: 'full' })
    expect(
      findDeviceSpot(plan, CATALOG, KWS_FRAME, EDITOR_IDS.tinyMount, m720q, { near: 50 }),
    ).toEqual({ y: 48, face: 'front', bay: 'full' })
  })

  it('needs room for the whole mount and only looks where it mounts', () => {
    const ds224 = device(CATALOG, EDITOR_IDS.ds224)
    // 4U: U7–U9 is the only run left above U6, and too short.
    expect(findDeviceSpot(plan, CATALOG, KWS_FRAME, EDITOR_IDS.ds224Module, ds224)).toBeNull()
    expect(
      findDeviceSpot(plan, CATALOG, KWS_FRAME, EDITOR_IDS.tinyMount, m720q, { face: 'rear' }),
    ).toBeNull()
    expect(findDeviceSpot(plan, CATALOG, KWS_FRAME, EDITOR_IDS.blank1u, m720q)).toBeNull()
  })
})

describe('checkDeviceAt', () => {
  const m720q = device(CATALOG, EDITOR_IDS.m720q)
  const plan = rack({ placements: blanks(3) })

  it('snaps to a start the holes allow and says when it fits', () => {
    expect(
      checkDeviceAt(plan, CATALOG, KWS_FRAME, EDITOR_IDS.tinyMount, m720q, 20, 'front'),
    ).toEqual({
      y: 18,
      spot: { y: 18, face: 'front', bay: 'full' },
      reasons: [],
    })
  })

  it('says why it is blocked', () => {
    expect(
      checkDeviceAt(plan, CATALOG, KWS_FRAME, EDITOR_IDS.tinyMount, m720q, 6, 'front'),
    ).toEqual({
      y: 6,
      spot: null,
      reasons: ['It overlaps 1U blank (U2).'],
    })
    const rear = checkDeviceAt(plan, CATALOG, KWS_FRAME, EDITOR_IDS.tinyMount, m720q, 18, 'rear')
    expect(rear.reasons).toEqual(['Lenovo Tiny mount mounts on the front only.'])
    expect(
      checkDeviceAt(plan, CATALOG, KWS_FRAME, EDITOR_IDS.sbcHalf, m720q, 18, 'front').reasons,
    ).toEqual(['The Lenovo ThinkCentre M720q Tiny does not go in Half-width SBC mount.'])
    expect(
      checkDeviceAt(plan, CATALOG, KWS_FRAME, 'no-such-mount', m720q, 18, 'front').reasons,
    ).toEqual(['"no-such-mount" is not a mount in the catalog.'])
  })

  it('takes the right bay of a half-width mount when the left one is used', () => {
    const pi = device(CATALOG, EDITOR_IDS.rpi5)
    const withLeft = rack({
      placements: [placementAt(CATALOG, 'pl-left', EDITOR_IDS.sbcHalf, 18, { bay: 'left' })],
    })
    expect(
      checkDeviceAt(withLeft, CATALOG, KWS_FRAME, EDITOR_IDS.sbcHalf, pi, 18, 'front').spot,
    ).toEqual({
      y: 18,
      face: 'front',
      bay: 'right',
    })
  })

  it('counts the device on a shelf', () => {
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
    const box = device(catalog, 'tall-box')
    // The shelf alone fits at U8–U9; with the box it reaches a sixth above the rack.
    const check = checkDeviceAt(rack(), catalog, KWS_FRAME, EDITOR_IDS.shelf2u, box, 42, 'front')
    expect(check.spot).toBeNull()
    expect(check.reasons).toEqual(['It would reach above U9, the top of the rack.'])
  })
})
