import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import type { BomResult } from './api'
import { computeBom } from './bom'
import { deviceKey, hardwareKey, printKey } from './ids'
import { canPlace } from './placement'
import {
  discardRetired,
  firstReuseSpot,
  keepAsSpare,
  listRetired,
  retiredSpares,
  reuseRetiredExtra,
  reuseRetiredPlacement,
  reuseRetiredSection,
  reuseSpots,
  sparesFreed,
  type RetiredOpResult,
} from './retired'
import type { Placement, Plan, RetiredEntry } from './schema/plan'
import { defaultSettings } from './schema/settings'
import { EDITOR_IDS, editorCatalog, placementAt } from './__fixtures__/editorFixtures'
import {
  FIXTURE_NOW,
  KWS_FRAME,
  KWS_IDS,
  kwsPlan,
  sectionSnapshot,
  type KwsPlanSpec,
} from './__fixtures__/kws'

const CATALOG = editorCatalog()
const SETTINGS = defaultSettings()
const REMOVED_AT = '2026-10-12T08:00:00.000Z'

/** The Lenovo Tiny mount the user deleted, with the M720q they own still in it. */
const OLD_MOUNT: RetiredEntry = {
  id: 'rt-mount',
  kind: 'placement',
  snapshot: { at: REMOVED_AT, itemId: EDITOR_IDS.tinyMount, options: {} },
  sourceId: 'pl-old',
  devices: [EDITOR_IDS.m720q],
}

/** A built 3U section taken out of the stack. */
const OLD_SECTION: RetiredEntry = {
  id: 'rt-section',
  kind: 'section',
  snapshot: { ...sectionSnapshot(KWS_FRAME, {}, { typeId: 's3' }), at: REMOVED_AT },
  sourceId: 'sec-old',
}

const OLD_FEET: RetiredEntry = {
  id: 'rt-feet',
  kind: 'extra',
  snapshot: { at: REMOVED_AT, itemId: EDITOR_IDS.rubberFeet, options: {} },
  sourceId: 'ex-old',
  qty: 3,
}

/** The user's built 3U (sec-1, sixths 0–18) + 6U (sec-2, 18–54), with removed parts. */
function rack(spec: KwsPlanSpec = {}): Plan {
  return kwsPlan({
    sections: [
      { u: 3, have: true },
      { u: 6, have: true },
    ],
    retired: [OLD_MOUNT],
    ...spec,
  })
}

function applied(result: RetiredOpResult): Plan {
  if (result.error !== undefined) throw new Error(result.error)
  expect(result.conflicts).toEqual([])
  return result.plan
}

function placementOf(plan: Plan, id: string | undefined): Placement {
  const placement = plan.placements.find((candidate) => candidate.id === id)
  if (placement === undefined) throw new Error(`No placement "${id}"`)
  return placement
}

function bom(plan: Plan): BomResult {
  return computeBom(plan, CATALOG, SETTINGS, {})
}

/** As-built per line key. */
function builtOf(result: BomResult): Record<string, number> {
  return Object.fromEntries(result.lines.map((line) => [line.key, line.asBuilt]))
}

// ---------------------------------------------------------------------------------------------
// Listing

describe('listRetired', () => {
  it('names each kind and says whether and how it can be reused', () => {
    const plan = rack({
      retired: [
        OLD_MOUNT,
        OLD_SECTION,
        OLD_FEET,
        {
          id: 'rt-top',
          kind: 'cap',
          snapshot: { at: REMOVED_AT, options: { top: 'handle' } },
          sourceId: 'top',
        },
        {
          id: 'rt-ghost',
          kind: 'placement',
          snapshot: { at: REMOVED_AT, itemId: 'ghost-mount', options: {} },
          devices: ['ghost-device'],
        },
      ],
    })
    expect(listRetired(plan, CATALOG)).toEqual([
      {
        id: 'rt-mount',
        kind: 'placement',
        itemId: EDITOR_IDS.tinyMount,
        name: 'Lenovo Tiny mount',
        devices: ['Lenovo ThinkCentre M720q Tiny'],
        at: REMOVED_AT,
        reuse: 'placement',
      },
      {
        id: 'rt-section',
        kind: 'section',
        name: '3U section',
        devices: [],
        at: REMOVED_AT,
        reuse: 'section',
      },
      {
        id: 'rt-feet',
        kind: 'extra',
        itemId: EDITOR_IDS.rubberFeet,
        name: 'Rubber feet',
        devices: [],
        qty: 3,
        at: REMOVED_AT,
        reuse: 'extra',
      },
      {
        id: 'rt-top',
        kind: 'cap',
        name: 'Top of the rack',
        devices: [],
        at: REMOVED_AT,
        reuseNote: 'Every rack has its top and bottom: change them under Options instead.',
      },
      {
        id: 'rt-ghost',
        kind: 'placement',
        itemId: 'ghost-mount',
        name: 'Unknown part "ghost-mount"',
        devices: ['"ghost-device"'],
        at: REMOVED_AT,
        reuseNote: 'It is not in your catalog any more, so it cannot go back on the rack.',
      },
    ])
  })

  it('cannot put anything back when the frame is unknown', () => {
    const plan = { ...rack(), frame: { ...rack().frame, frameId: 'ghost-frame' } }
    const [view] = listRetired(plan, CATALOG)
    expect(view?.reuse).toBeUndefined()
    expect(view?.reuseNote).toBe(
      'This plan’s frame is not in your catalog, so nothing can go back on the rack.',
    )
    expect(reuseRetiredPlacement(plan, CATALOG, 'rt-mount', 0, 'front').error).toBe(
      'The frame "ghost-frame" is not in your catalog, so nothing can be placed.',
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Reuse: placements

describe('reuseRetiredPlacement', () => {
  it('puts the part back owned, with its device, and the BOM does not change what you own', () => {
    const plan = rack()
    const result = reuseRetiredPlacement(plan, CATALOG, 'rt-mount', 6, 'front')
    const next = applied(result)
    expect(result.placementId).toMatch(/^pl-/)
    expect(next.retired).toEqual([])
    expect(placementOf(next, result.placementId)).toEqual({
      id: result.placementId,
      itemId: EDITOR_IDS.tinyMount,
      name: 'Lenovo Tiny mount',
      heightSixths: 6,
      y: 6,
      face: 'front',
      bay: 'full',
      have: { at: REMOVED_AT, itemId: EDITOR_IDS.tinyMount, options: {} },
      devices: [
        {
          id: expect.stringMatching(/^dv-/) as unknown as string,
          deviceId: EDITOR_IDS.m720q,
          slotId: 'bay',
          orientation: 'flat',
          have: true,
        },
      ],
    })
    // Owned before (removed) and after (in the rack): the same; nothing new to get for it.
    const before = bom(plan)
    const after = bom(next)
    expect(builtOf(after)).toEqual(builtOf(before))
    for (const key of [
      printKey(EDITOR_IDS.tinyMount, 'mount'),
      hardwareKey(KWS_IDS.m5x10),
      deviceKey(EDITOR_IDS.m720q),
    ]) {
      expect(after.lines.find((line) => line.key === key)).toMatchObject({ need: 0, surplus: 0 })
    }
  })

  it('plans it with the options it was built with', () => {
    const plan = rack({
      placements: [],
      retired: [
        {
          id: 'rt-shelf',
          kind: 'placement',
          snapshot: { at: REMOVED_AT, itemId: EDITOR_IDS.nasShelf, options: { lip: false } },
        },
      ],
    })
    const result = reuseRetiredPlacement(plan, CATALOG, 'rt-shelf', 0, 'front')
    expect(placementOf(applied(result), result.placementId)).toMatchObject({
      options: { lip: false },
      have: { options: { lip: false } },
    })
  })

  it('explains a spot that is taken and leaves the plan alone', () => {
    const plan = rack({ placements: [placementAt(CATALOG, 'pl-blank', EDITOR_IDS.blank1u, 6)] })
    const result = reuseRetiredPlacement(plan, CATALOG, 'rt-mount', 6, 'front')
    expect(result).toEqual({
      plan,
      conflicts: [],
      error: 'Lenovo Tiny mount cannot go back at U2 on the front. It overlaps 1U blank (U2).',
    })
  })

  it('sends devices no slot takes any more to Equipment to fit, owned', () => {
    const plan = rack({
      retired: [{ ...OLD_MOUNT, devices: [EDITOR_IDS.m720q, EDITOR_IDS.bigMiniPc] }],
    })
    const next = applied(reuseRetiredPlacement(plan, CATALOG, 'rt-mount', 0, 'front'))
    expect(next.placements[0]?.devices.map((device) => device.deviceId)).toEqual([EDITOR_IDS.m720q])
    expect(next.equipment).toEqual([
      {
        id: expect.stringMatching(/^eq-/) as unknown as string,
        deviceId: EDITOR_IDS.bigMiniPc,
        have: true,
      },
    ])
  })

  it('uses the free half of a half-width spot, or the one asked for', () => {
    const plan = rack({
      placements: [placementAt(CATALOG, 'pl-left', EDITOR_IDS.sbcHalf, 0, { bay: 'left' })],
      retired: [
        {
          id: 'rt-sbc',
          kind: 'placement',
          snapshot: { at: REMOVED_AT, itemId: EDITOR_IDS.sbcHalf, options: {} },
          devices: [EDITOR_IDS.rpi5],
        },
      ],
    })
    const result = reuseRetiredPlacement(plan, CATALOG, 'rt-sbc', 0, 'front')
    expect(placementOf(applied(result), result.placementId)).toMatchObject({ bay: 'right' })
    expect(
      reuseRetiredPlacement(plan, CATALOG, 'rt-sbc', 0, 'front', { bay: 'left' }).error,
    ).toMatch(/^Half-width SBC mount cannot go back at U1 on the front\. It overlaps/)
  })

  it('refuses what cannot go back on the rails', () => {
    const plan = rack({
      retired: [
        OLD_SECTION,
        {
          id: 'rt-ghost',
          kind: 'placement',
          snapshot: { at: REMOVED_AT, itemId: 'ghost-mount', options: {} },
        },
        { id: 'rt-blank', kind: 'placement', snapshot: { at: REMOVED_AT, options: {} } },
      ],
    })
    const cases: Array<[string, string]> = [
      ['rt-section', 'Only parts that mount on the rails go back at a U.'],
      [
        'rt-ghost',
        '"ghost-mount" is not in your catalog any more, so it cannot go back on the rack.',
      ],
      ['rt-blank', 'What this part was is not recorded, so it cannot go back on the rack.'],
      ['rt-nope', 'There is no removed part "rt-nope" in this plan.'],
    ]
    for (const [retiredId, error] of cases) {
      expect(reuseRetiredPlacement(plan, CATALOG, retiredId, 0, 'front')).toEqual({
        plan,
        conflicts: [],
        error,
      })
    }
  })

  test.prop([fc.integer({ min: -6, max: 60 }), fc.constantFrom('front' as const, 'rear' as const)])(
    'either goes back where canPlace allows it, owning the same, or changes nothing',
    (y, face) => {
      const plan = rack({ placements: [placementAt(CATALOG, 'pl-blank', EDITOR_IDS.blank1u, 12)] })
      const result = reuseRetiredPlacement(plan, CATALOG, 'rt-mount', y, face)
      if (result.error !== undefined) {
        expect(result.plan).toBe(plan)
        return
      }
      const placement = placementOf(result.plan, result.placementId)
      expect(placement).toMatchObject({ y, face })
      const others = { ...result.plan, placements: plan.placements }
      expect(canPlace(others, CATALOG, KWS_FRAME, { ...placement }).ok).toBe(true)
      expect(builtOf(bom(result.plan))).toEqual(builtOf(bom(plan)))
    },
  )
})

describe('reuseSpots / firstReuseSpot', () => {
  it('lists the free starts bottom to top, its device counted', () => {
    const plan = rack({
      placements: [
        placementAt(CATALOG, 'pl-a', EDITOR_IDS.blank1u, 0),
        placementAt(CATALOG, 'pl-b', EDITOR_IDS.blank1u, 12),
      ],
    })
    expect(firstReuseSpot(plan, CATALOG, 'rt-mount')).toEqual({ y: 6, face: 'front', bay: 'full' })
    const spots = reuseSpots(plan, CATALOG, 'rt-mount', 'front')
    expect(spots.slice(0, 3)).toEqual([
      { y: 6, face: 'front', bay: 'full' },
      { y: 18, face: 'front', bay: 'full' },
      { y: 24, face: 'front', bay: 'full' },
    ])
    expect(spots.every((spot) => spot.face === 'front')).toBe(true)
    expect(reuseSpots(plan, CATALOG, 'rt-mount', 'rear')).toEqual([])
    expect(reuseSpots(plan, CATALOG, 'rt-nope')).toEqual([])
    expect(firstReuseSpot(plan, CATALOG, 'rt-nope')).toBeUndefined()
  })

  it('has no spot in a full rack', () => {
    const placements = [0, 6, 12, 18, 24, 30, 36, 42, 48].map((y) =>
      placementAt(CATALOG, `pl-${y}`, EDITOR_IDS.blank1u, y),
    )
    expect(firstReuseSpot(rack({ placements }), CATALOG, 'rt-mount')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------
// Reuse: sections and accessories

describe('reuseRetiredSection', () => {
  const plan = rack({
    placements: [placementAt(CATALOG, 'pl-blank', EDITOR_IDS.blank1u, 6)],
    retired: [OLD_SECTION],
  })

  it('puts it back on top, owned as it was built', () => {
    const result = reuseRetiredSection(plan, CATALOG, 'rt-section', 'top')
    const next = applied(result)
    expect(next.retired).toEqual([])
    expect(next.frame.sections.map((section) => section.typeId)).toEqual(['s3', 's6', 's3'])
    expect(next.frame.sections[2]).toEqual({
      id: result.sectionId,
      typeId: 's3',
      // Planned as it was built: its section options.
      options: { magnets: true, 'side-panels': 'none' },
      have: OLD_SECTION.snapshot,
    })
    expect(next.placements[0]?.y).toBe(6)
    // What you own did not change, and its frame parts are not to get again.
    expect(builtOf(bom(next))).toEqual(builtOf(bom(plan)))
    for (const print of ['plate-3u', 'frame-connectors']) {
      expect(
        bom(next).lines.find((line) => line.key === printKey(KWS_FRAME.id, print)),
      ).toMatchObject({ need: 0, surplus: 0 })
    }
  })

  it('puts it back at the bottom, and what is above moves up with its section', () => {
    const next = applied(reuseRetiredSection(plan, CATALOG, 'rt-section', 'bottom'))
    expect(next.frame.sections.map((section) => section.typeId)).toEqual(['s3', 's3', 's6'])
    expect(next.placements[0]?.y).toBe(24)
  })

  it('refuses past the frame’s height and what is not a section', () => {
    const tall = rack({
      sections: Array.from({ length: 5 }, () => ({ u: 6 as const, have: true })),
      retired: [OLD_SECTION, OLD_FEET],
    })
    const result = reuseRetiredSection(tall, CATALOG, 'rt-section', 'top')
    expect(result.plan).toBe(tall)
    expect(result.error).toBe('KWS Rack v2 stacks go up to 30U; this would make 33U.')
    expect(result.conflicts).toEqual([expect.objectContaining({ kind: 'out-of-bounds' })])
    expect(reuseRetiredSection(tall, CATALOG, 'rt-feet', 'top').error).toBe(
      'Only sections go back into the stack.',
    )
  })
})

describe('reuseRetiredExtra', () => {
  it('first covers what the plan still has to get, then adds to its line', () => {
    const plan = rack({
      extras: [{ id: 'ex-feet', itemId: EDITOR_IDS.rubberFeet, qty: 4, haveQty: 2 }],
      retired: [OLD_FEET],
    })
    const result = reuseRetiredExtra(plan, 'rt-feet')
    expect(result.extraId).toBe('ex-feet')
    const next = applied(result)
    expect(next.extras).toEqual([
      { id: 'ex-feet', itemId: EDITOR_IDS.rubberFeet, qty: 5, haveQty: 5 },
    ])
    expect(next.retired).toEqual([])
    expect(builtOf(bom(next))).toEqual(builtOf(bom(plan)))
  })

  it('starts a line when the plan has none, and refuses other kinds', () => {
    const plan = rack({ retired: [OLD_FEET, OLD_SECTION] })
    expect(applied(reuseRetiredExtra(plan, 'rt-feet')).extras).toEqual([
      {
        id: expect.stringMatching(/^ex-/) as unknown as string,
        itemId: EDITOR_IDS.rubberFeet,
        qty: 3,
        haveQty: 3,
      },
    ])
    expect(reuseRetiredExtra(plan, 'rt-section').error).toBe(
      'Only accessories go back on the list.',
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Keep as spare, discard

describe('keepAsSpare / discardRetired', () => {
  it('take it out of the plan; unknown ids are refused', () => {
    const plan = rack({ retired: [OLD_MOUNT, OLD_FEET] })
    expect(applied(keepAsSpare(plan, 'rt-mount')).retired).toEqual([OLD_FEET])
    expect(applied(discardRetired(plan, 'rt-feet')).retired).toEqual([OLD_MOUNT])
    expect(discardRetired(plan, 'rt-x')).toEqual({
      plan,
      conflicts: [],
      error: 'There is no removed part "rt-x" in this plan.',
    })
    expect(keepAsSpare(plan, 'rt-x').plan).toBe(plan)
  })
})

describe('retiredSpares', () => {
  it('lists the print, the rack screws and the device, never the brick in its box', () => {
    const spares = retiredSpares(rack(), CATALOG, 'rt-mount', SETTINGS)
    expect(spares.map(({ key, qty }) => [key, qty])).toEqual([
      [printKey(EDITOR_IDS.tinyMount, 'mount'), 1],
      [hardwareKey(KWS_IDS.m5x10), 4],
      [deviceKey(EDITOR_IDS.m720q), 1],
    ])
    expect(spares[0]).toMatchObject({
      kind: 'print',
      unit: 'plates',
      label: 'Lenovo Tiny mount: Tiny mount',
    })
  })

  it('a section frees its plate, its joint and its screws, not the inserts inside the plate', () => {
    const spares = retiredSpares(rack({ retired: [OLD_SECTION] }), CATALOG, 'rt-section', SETTINGS)
    const byKey = Object.fromEntries(spares.map((spare) => [spare.key, spare.qty]))
    expect(byKey[printKey(KWS_FRAME.id, 'plate-3u')]).toBe(1)
    expect(byKey[printKey(KWS_FRAME.id, 'frame-connectors')]).toBe(1)
    expect(byKey[hardwareKey(KWS_IDS.m6x10)]).toBeGreaterThan(0)
    expect(byKey[hardwareKey(KWS_IDS.inserts)]).toBeUndefined()
    expect(byKey[hardwareKey(KWS_IDS.magnets)]).toBeUndefined()
  })

  it('is empty for an unknown id', () => {
    expect(retiredSpares(rack(), CATALOG, 'rt-x', SETTINGS)).toEqual([])
  })
})

describe('sparesFreed', () => {
  it('is what leaves the as-built between two BOMs', () => {
    const plan = rack()
    const before = bom(plan)
    const after = bom(applied(keepAsSpare(plan, 'rt-mount')))
    expect(sparesFreed(before, after)).toEqual({
      [printKey(EDITOR_IDS.tinyMount, 'mount')]: 1,
      [hardwareKey(KWS_IDS.m5x10)]: 4,
      [deviceKey(EDITOR_IDS.m720q)]: 1,
    })
    expect(sparesFreed(after, before)).toEqual({})
  })
})

it('keeps FIXTURE_NOW snapshots as they are when nothing is reused', () => {
  const plan = rack({ placements: [placementAt(CATALOG, 'pl-blank', EDITOR_IDS.blank1u, 0)] })
  const copy = structuredClone(plan)
  reuseRetiredPlacement(plan, CATALOG, 'rt-mount', 6, 'front')
  reuseSpots(plan, CATALOG, 'rt-mount')
  keepAsSpare(plan, 'rt-mount')
  expect(plan).toEqual(copy)
  expect(plan.frame.sections[0]?.have?.at).toBe(FIXTURE_NOW)
})
