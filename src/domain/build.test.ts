import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import type { BomResult } from './api'
import { computeBom, consumeInventory, shoppingLines } from './bom'
import {
  capSnapshot,
  finishBuild,
  markCap,
  markEquipment,
  markExtra,
  markPlacement,
  markPlacementDevice,
  markSectionContents,
  placementSnapshot,
  placementsAnchoredIn,
} from './build'
import { insertSection, markSection, placementsInSection, totalHeightSixths } from './frame'
import { hardwareKey, printKey } from './ids'
import type { CatalogLookup } from './schema/catalog'
import type { OptionValues } from './schema/common'
import type { Placement, Plan } from './schema/plan'
import { defaultSettings, type Inventory, type Settings } from './schema/settings'
import { EDITOR_IDS, editorCatalog, placementAt } from './__fixtures__/editorFixtures'
import {
  FIXTURE_NOW,
  KWS_FRAME,
  KWS_FRAME_ID,
  KWS_IDS,
  kwsPlan,
  type KwsPlanSpec,
} from './__fixtures__/kws'

const LATER = '2026-10-12T08:00:00.000Z'
const CATALOG = editorCatalog()
const NO_SPARES: Settings = { ...defaultSettings(), sparePct: { default: 0 } }

const KEYS = {
  plate3: printKey(KWS_FRAME_ID, 'plate-3u'),
  leg6: printKey(KWS_FRAME_ID, 'leg-6u'),
  connectors: printKey(KWS_FRAME_ID, 'frame-connectors'),
  topFlat: printKey(KWS_FRAME_ID, 'top-flat'),
  inserts: hardwareKey(KWS_IDS.inserts),
  m6x8: hardwareKey(KWS_IDS.m6x8),
  m6x10: hardwareKey(KWS_IDS.m6x10),
  nyloc: hardwareKey(KWS_IDS.nyloc),
  magnets: hardwareKey(KWS_IDS.magnets),
}

/** The signed-off shopping list for adding one 3U to the user's 3U + 6U (spares off). */
const GOLDEN: Record<string, number> = {
  [KEYS.plate3]: 1,
  [KEYS.connectors]: 1,
  [KEYS.inserts]: 36,
  [KEYS.m6x8]: 16,
  [KEYS.m6x10]: 24,
  [KEYS.nyloc]: 40,
  [KEYS.magnets]: 16,
}

/** Every KWS option as it resolves for a cap with no values set anywhere. */
const DEFAULT_CAP_OPTIONS: OptionValues = {
  magnets: true,
  'insert-policy': 'all',
  top: 'handle',
  stoppers: false,
  'high-rack': false,
  'side-panels': 'none',
  'deep-320': false,
}

function bom(plan: Plan, inventory: Inventory = {}, catalog: CatalogLookup = CATALOG): BomResult {
  return computeBom(plan, catalog, NO_SPARES, inventory)
}

/** The shopping list as { key: buy }. */
function shopping(result: BomResult): Record<string, number> {
  return Object.fromEntries(shoppingLines(result).map((line) => [line.key, line.buy]))
}

function placementOf(plan: Plan, id: string): Placement {
  const placement = plan.placements.find((candidate) => candidate.id === id)
  if (placement === undefined) throw new Error(`No placement "${id}"`)
  return placement
}

function ids(placements: readonly Placement[]): string[] {
  return placements.map((placement) => placement.id)
}

function inserted(plan: Plan, atIndex: number): Plan {
  const result = insertSection(plan, KWS_FRAME, atIndex, 's3')
  if (result.error !== undefined) throw new Error(result.error)
  return result.plan
}

/**
 * The user's rack as the wizard leaves it before recording: 3U (sec-1, sixths 0–18) under 6U
 * (sec-2, 18–54), nothing owned yet (caps included), and their gear:
 * - sec-1: a Lenovo Tiny mount with an M720q at U1, a blank at U2, a 2U shelf with a Pi from U3
 *   (it straddles the joint at U4);
 * - sec-2: a blank at U6 and a 10" PDU (ear-mounted, placed directly) at U9.
 */
function userRack(spec: KwsPlanSpec = {}): Plan {
  return kwsPlan({
    sections: [3, 6],
    placements: [
      placementAt(CATALOG, 'pl-tiny', EDITOR_IDS.tinyMount, 0, {
        devices: [{ id: 'dv-m720q', deviceId: EDITOR_IDS.m720q, slotId: 'bay' }],
      }),
      placementAt(CATALOG, 'pl-blank', EDITOR_IDS.blank1u, 6),
      placementAt(CATALOG, 'pl-shelf', EDITOR_IDS.shelf2u, 12, {
        devices: [{ id: 'dv-pi', deviceId: EDITOR_IDS.rpi5, slotId: 'deck', xMm: 0 }],
      }),
      placementAt(CATALOG, 'pl-blank-2', EDITOR_IDS.blank1u, 30),
      placementAt(CATALOG, 'pl-pdu', EDITOR_IDS.pdu, 48),
    ],
    ...spec,
  })
}

/** Records the whole rack the way the user does: section menu, "Mark everything as Have". */
function recorded(plan: Plan, at = FIXTURE_NOW): Plan {
  return plan.frame.sections.reduce(
    (current, section) => markSectionContents(current, KWS_FRAME, section.id, true, at, CATALOG),
    plan,
  )
}

// ---------------------------------------------------------------------------------------------
// The user scenario

describe("the user's KWS 3U + 6U, adding one 3U", () => {
  it('records the rack section by section and gets the signed-off shopping list', () => {
    const rack = recorded(userRack())
    expect(rack.frame.sections.every((section) => section.have !== undefined)).toBe(true)
    expect(rack.placements.every((placement) => placement.have !== undefined)).toBe(true)
    expect(rack.placements.flatMap((placement) => placement.devices).every((d) => d.have)).toBe(
      true,
    )
    // Nothing to get while the rack is just what the user has.
    expect(shopping(bom(rack))).toEqual({})

    expect(shopping(bom(inserted(rack, 2)))).toEqual(GOLDEN)
    expect(shopping(bom(inserted(rack, 0)))).toEqual(GOLDEN)
  })

  it('marks the caps Have with the first recorded section, so the top and bottom are not bought', () => {
    const plan = userRack()
    expect(plan.frame.caps.top.have).toBeUndefined()
    const first = markSectionContents(plan, KWS_FRAME, 'sec-2', true, FIXTURE_NOW)
    expect(first.frame.caps.top.have).toEqual({ at: FIXTURE_NOW, options: DEFAULT_CAP_OPTIONS })
    expect(first.frame.caps.bottom.have).toEqual({ at: FIXTURE_NOW, options: DEFAULT_CAP_OPTIONS })
    // Recording only the 6U: the 3U is still to get, but never a second top or bottom.
    const result = bom(first)
    const capKeys = ['top-handle', 'top-connectors', 'base-legs', 'bottom-connectors'].map((id) =>
      printKey(KWS_FRAME_ID, id),
    )
    for (const key of capKeys) expect(shopping(result)[key]).toBeUndefined()
  })

  it('runs a second cycle: Got it -> Finish build -> next 3U gives the same list', () => {
    const plan = inserted(recorded(userRack()), 2)
    const before = bom(plan)
    expect(shopping(before)).toEqual(GOLDEN)

    // "Got it" on every line puts what was bought into the inventory: nothing left to get.
    const inventory: Inventory = { ...GOLDEN }
    const gotIt = bom(plan, inventory)
    expect(shopping(gotIt)).toEqual({})

    const finished = finishBuild(plan, KWS_FRAME, LATER, CATALOG)
    expect(finished.changed).toBe(1) // the new 3U section
    const after = bom(finished.plan, inventory)
    expect(shopping(after)).toEqual({})
    // The parts went into the rack: the loose spares are used up.
    expect(consumeInventory(gotIt, after, inventory)).toEqual({})

    expect(shopping(bom(inserted(finished.plan, 3)))).toEqual(GOLDEN)
    expect(shopping(bom(inserted(finished.plan, 0)))).toEqual(GOLDEN)
  })

  it('Finish build empties the shopping list of the golden plan', () => {
    const plan = kwsPlan({ sections: [{ u: 3, have: true }, { u: 6, have: true }, 3] })
    expect(shopping(bom(plan))).toEqual(GOLDEN)
    const { plan: built, changed } = finishBuild(plan, KWS_FRAME, LATER)
    expect(changed).toBeGreaterThanOrEqual(1)
    expect(shopping(bom(built))).toEqual({})
    expect(built.frame.sections[2]?.have).toEqual({
      at: LATER,
      typeId: 's3',
      heightU: 3,
      options: {
        magnets: true,
        'insert-policy': 'all',
        'high-rack': false,
        'side-panels': 'none',
        'deep-320': false,
      },
    })
  })
})

// ---------------------------------------------------------------------------------------------
// Placements, devices, equipment

describe('markPlacement', () => {
  const plan = userRack()

  it('captures {at, itemId, options} and leaves the devices alone', () => {
    const marked = markPlacement(plan, 'pl-tiny', true, LATER)
    const placement = placementOf(marked, 'pl-tiny')
    expect(placement.have).toEqual({ at: LATER, itemId: EDITOR_IDS.tinyMount, options: {} })
    expect(placement.devices).toEqual(placementOf(plan, 'pl-tiny').devices)
    expect(placement.devices[0]?.have).toBe(false)
    // Only that placement changed.
    expect(
      marked.placements.filter((candidate) => candidate !== placementOf(plan, candidate.id)),
    ).toHaveLength(1)
  })

  it('clears the snapshot for Need and returns the same plan when nothing changes', () => {
    const marked = markPlacement(plan, 'pl-tiny', true, LATER)
    expect(markPlacement(marked, 'pl-tiny', true, '2027-01-01T00:00:00.000Z')).toBe(marked)
    const unmarked = markPlacement(marked, 'pl-tiny', false, LATER)
    expect(placementOf(unmarked, 'pl-tiny').have).toBeUndefined()
    expect('have' in placementOf(unmarked, 'pl-tiny')).toBe(false)
    expect(markPlacement(unmarked, 'pl-tiny', false, LATER)).toBe(unmarked)
    expect(markPlacement(plan, 'pl-nope', true, LATER)).toBe(plan)
  })

  it('resolves the option values against the item when given the catalog', () => {
    const shelfPlan = kwsPlan({
      sections: [6],
      placements: [
        placementAt(CATALOG, 'pl-nas', EDITOR_IDS.nasShelf, 0, { options: { feet: 'rubber' } }),
      ],
    })
    const raw = markPlacement(shelfPlan, 'pl-nas', true, LATER)
    expect(placementOf(raw, 'pl-nas').have?.options).toEqual({ feet: 'rubber' })
    const resolved = markPlacement(shelfPlan, 'pl-nas', true, LATER, CATALOG)
    expect(placementOf(resolved, 'pl-nas').have?.options).toEqual({ lip: true, feet: 'rubber' })
    // Raw and resolved snapshots describe the same build: re-marking keeps either.
    expect(markPlacement(raw, 'pl-nas', true, '2027-01-01T00:00:00.000Z', CATALOG)).toBe(raw)
    expect(markPlacement(resolved, 'pl-nas', true, '2027-01-01T00:00:00.000Z')).toBe(resolved)
    expect(placementSnapshot(placementOf(shelfPlan, 'pl-nas'), LATER, CATALOG)).toEqual({
      at: LATER,
      itemId: EDITOR_IDS.nasShelf,
      options: { lip: true, feet: 'rubber' },
    })
  })

  it('re-captures an owned placement whose options changed since', () => {
    const shelfPlan = kwsPlan({
      sections: [6],
      placements: [placementAt(CATALOG, 'pl-nas', EDITOR_IDS.nasShelf, 0)],
    })
    const owned = markPlacement(shelfPlan, 'pl-nas', true, FIXTURE_NOW, CATALOG)
    const edited: Plan = {
      ...owned,
      placements: owned.placements.map((placement) => ({ ...placement, options: { lip: false } })),
    }
    for (const catalog of [CATALOG, undefined]) {
      const again = markPlacement(edited, 'pl-nas', true, LATER, catalog)
      expect(placementOf(again, 'pl-nas').have?.at).toBe(LATER)
      expect(placementOf(again, 'pl-nas').have?.options.lip).toBe(false)
    }
  })

  it('records gear placed directly (no item) with its own values', () => {
    const marked = markPlacement(plan, 'pl-pdu', true, LATER, CATALOG)
    expect(placementOf(marked, 'pl-pdu').have).toEqual({
      at: LATER,
      itemId: EDITOR_IDS.pdu,
      options: {},
    })
  })

  it('never mutates its input', () => {
    const frozen = structuredClone(plan)
    markPlacement(plan, 'pl-tiny', true, LATER, CATALOG)
    expect(plan).toEqual(frozen)
  })
})

describe('markPlacementDevice', () => {
  const plan = userRack()

  it('sets the owned flag of one device entry', () => {
    const marked = markPlacementDevice(plan, 'pl-tiny', 'dv-m720q', true)
    expect(placementOf(marked, 'pl-tiny').devices[0]?.have).toBe(true)
    expect(placementOf(marked, 'pl-tiny').have).toBeUndefined()
    expect(placementOf(marked, 'pl-shelf')).toBe(placementOf(plan, 'pl-shelf'))
    const unmarked = markPlacementDevice(marked, 'pl-tiny', 'dv-m720q', false)
    expect(placementOf(unmarked, 'pl-tiny').devices[0]?.have).toBe(false)
  })

  it('returns the same plan for unknown ids and unchanged flags', () => {
    expect(markPlacementDevice(plan, 'pl-tiny', 'dv-m720q', false)).toBe(plan)
    expect(markPlacementDevice(plan, 'pl-tiny', 'dv-nope', true)).toBe(plan)
    expect(markPlacementDevice(plan, 'pl-nope', 'dv-m720q', true)).toBe(plan)
    // The device belongs to another placement.
    expect(markPlacementDevice(plan, 'pl-shelf', 'dv-m720q', true)).toBe(plan)
  })
})

describe('markEquipment', () => {
  const plan = userRack({
    equipment: [
      { id: 'eq-ds', deviceId: EDITOR_IDS.ds224 },
      { id: 'eq-pi', deviceId: EDITOR_IDS.rpi5, have: true },
    ],
  })

  it('sets the owned flag of a tray entry', () => {
    const marked = markEquipment(plan, 'eq-ds', true)
    expect(marked.equipment.map((entry) => entry.have)).toEqual([true, true])
    expect(markEquipment(marked, 'eq-pi', false).equipment.map((entry) => entry.have)).toEqual([
      true,
      false,
    ])
  })

  it('returns the same plan for unknown ids and unchanged flags', () => {
    expect(markEquipment(plan, 'eq-pi', true)).toBe(plan)
    expect(markEquipment(plan, 'eq-nope', true)).toBe(plan)
  })
})

// ---------------------------------------------------------------------------------------------
// Caps and extras

describe('markCap', () => {
  const plan = kwsPlan({
    sections: [3, 6],
    rackOptions: { 'insert-policy': 'top-bottom' },
    top: { options: { top: 'flat' } },
  })

  it('captures every option as it resolves for the cap: default, rack value, cap value', () => {
    const marked = markCap(plan, KWS_FRAME, 'top', true, LATER)
    expect(marked.frame.caps.top.have).toEqual({
      at: LATER,
      options: { ...DEFAULT_CAP_OPTIONS, 'insert-policy': 'top-bottom', top: 'flat' },
    })
    expect(marked.frame.caps.top.options).toEqual({ top: 'flat' })
    expect(marked.frame.caps.bottom).toBe(plan.frame.caps.bottom)
    expect(capSnapshot(plan, KWS_FRAME, 'bottom', LATER).options).toEqual({
      ...DEFAULT_CAP_OPTIONS,
      'insert-policy': 'top-bottom',
    })
  })

  it('clears for Need and returns the same plan when nothing changes', () => {
    const marked = markCap(plan, KWS_FRAME, 'bottom', true, LATER)
    expect(markCap(marked, KWS_FRAME, 'bottom', true, '2027-01-01T00:00:00.000Z')).toBe(marked)
    const unmarked = markCap(marked, KWS_FRAME, 'bottom', false, LATER)
    expect(unmarked.frame.caps.bottom).toEqual({})
    expect(markCap(unmarked, KWS_FRAME, 'bottom', false, LATER)).toBe(unmarked)
    expect(markCap(plan, KWS_FRAME, 'side' as 'top', true, LATER)).toBe(plan)
  })

  it('re-captures a cap whose options changed since it was built', () => {
    const builtHandle = kwsPlan({
      sections: [{ u: 3, have: true }],
      top: { options: { top: 'flat' }, builtOptions: { ...DEFAULT_CAP_OPTIONS, top: 'handle' } },
    })
    expect(shopping(bom(builtHandle))[KEYS.topFlat]).toBe(2)
    const again = markCap(builtHandle, KWS_FRAME, 'top', true, LATER)
    expect(again.frame.caps.top.have?.options.top).toBe('flat')
    expect(shopping(bom(again))[KEYS.topFlat]).toBeUndefined()
  })
})

describe('markExtra', () => {
  const plan = kwsPlan({
    sections: [3],
    extras: [{ id: 'ex-feet', itemId: EDITOR_IDS.rubberFeet, qty: 4, haveQty: 1 }],
  })
  const haveQty = (current: Plan) => current.extras[0]?.haveQty

  it('clamps to 0..qty and rounds down', () => {
    expect(haveQty(markExtra(plan, 'ex-feet', 3))).toBe(3)
    expect(haveQty(markExtra(plan, 'ex-feet', 7))).toBe(4)
    expect(haveQty(markExtra(plan, 'ex-feet', -2))).toBe(0)
    expect(haveQty(markExtra(plan, 'ex-feet', 2.9))).toBe(2)
    expect(haveQty(markExtra(plan, 'ex-feet', Number.POSITIVE_INFINITY))).toBe(4)
    expect(haveQty(markExtra(plan, 'ex-feet', Number.NEGATIVE_INFINITY))).toBe(0)
  })

  it('returns the same plan for NaN, unknown ids and unchanged quantities', () => {
    expect(markExtra(plan, 'ex-feet', Number.NaN)).toBe(plan)
    expect(markExtra(plan, 'ex-nope', 2)).toBe(plan)
    expect(markExtra(plan, 'ex-feet', 1)).toBe(plan)
    expect(markExtra(plan, 'ex-feet', 1.5)).toBe(plan)
  })
})

// ---------------------------------------------------------------------------------------------
// Sections

describe('placementsAnchoredIn', () => {
  const plan = userRack()

  it('gives each placement to the section its bottom edge sits on', () => {
    expect(ids(placementsAnchoredIn(plan, KWS_FRAME, 'sec-1'))).toEqual([
      'pl-tiny',
      'pl-blank',
      'pl-shelf',
    ])
    expect(ids(placementsAnchoredIn(plan, KWS_FRAME, 'sec-2', CATALOG))).toEqual([
      'pl-blank-2',
      'pl-pdu',
    ])
    // The straddling shelf is on the 6U too, but anchored in the 3U.
    expect(ids(placementsInSection(plan, KWS_FRAME, 'sec-2'))).toContain('pl-shelf')
    expect(placementsAnchoredIn(plan, KWS_FRAME, 'sec-x')).toEqual([])
  })

  it('leaves out placements entirely outside the stack', () => {
    const outside = userRack({
      placements: [
        placementAt(CATALOG, 'pl-above', EDITOR_IDS.blank1u, 60),
        placementAt(CATALOG, 'pl-below', EDITOR_IDS.blank1u, -6),
        placementAt(CATALOG, 'pl-half-below', EDITOR_IDS.blank1u, -3),
      ],
    })
    expect(ids(placementsAnchoredIn(outside, KWS_FRAME, 'sec-1'))).toEqual(['pl-half-below'])
    expect(ids(placementsAnchoredIn(outside, KWS_FRAME, 'sec-2'))).toEqual([])
  })
})

describe('markSectionContents', () => {
  const plan = userRack()

  it('marks the section, the placements anchored in it and their devices', () => {
    const marked = markSectionContents(plan, KWS_FRAME, 'sec-1', true, LATER)
    expect(marked.frame.sections[0]?.have).toMatchObject({ at: LATER, typeId: 's3', heightU: 3 })
    expect(marked.frame.sections[1]?.have).toBeUndefined()
    for (const id of ['pl-tiny', 'pl-blank', 'pl-shelf']) {
      const placement = placementOf(marked, id)
      expect(placement.have).toEqual({ at: LATER, itemId: placement.itemId, options: {} })
      expect(placement.devices.every((device) => device.have)).toBe(true)
    }
    for (const id of ['pl-blank-2', 'pl-pdu']) {
      expect(placementOf(marked, id)).toBe(placementOf(plan, id))
    }
  })

  it('marks Need the same way and leaves the caps alone', () => {
    const owned = recorded(plan)
    const unmarked = markSectionContents(owned, KWS_FRAME, 'sec-2', false, LATER)
    expect(unmarked.frame.sections[1]?.have).toBeUndefined()
    expect(unmarked.frame.sections[0]?.have).toBeDefined()
    expect(placementOf(unmarked, 'pl-blank-2').have).toBeUndefined()
    expect(placementOf(unmarked, 'pl-pdu').have).toBeUndefined()
    expect(placementOf(unmarked, 'pl-shelf').have).toBeDefined()
    expect(placementOf(unmarked, 'pl-shelf').devices[0]?.have).toBe(true)
    expect(unmarked.frame.caps).toBe(owned.frame.caps)
  })

  it('leaves caps alone once either has a snapshot', () => {
    const topOnly = markCap(plan, KWS_FRAME, 'top', true, FIXTURE_NOW)
    const marked = markSectionContents(topOnly, KWS_FRAME, 'sec-1', true, LATER)
    expect(marked.frame.caps).toBe(topOnly.frame.caps)
    expect(marked.frame.caps.bottom.have).toBeUndefined()
  })

  it('returns the same plan when there is nothing to change', () => {
    const owned = recorded(plan)
    for (const section of owned.frame.sections) {
      expect(markSectionContents(owned, KWS_FRAME, section.id, true, LATER, CATALOG)).toBe(owned)
    }
    expect(markSectionContents(plan, KWS_FRAME, 'sec-1', false, LATER)).toBe(plan)
    expect(markSectionContents(plan, KWS_FRAME, 'sec-nope', true, LATER)).toBe(plan)
  })

  it('leaves the plan alone when the frame does not have the section type', () => {
    const odd: Plan = {
      ...plan,
      frame: {
        ...plan.frame,
        sections: plan.frame.sections.map((section, index) =>
          index === 0 ? { ...section, typeId: 's9' } : section,
        ),
      },
    }
    expect(markSectionContents(odd, KWS_FRAME, 'sec-1', true, LATER)).toBe(odd)
  })

  it('marks a placement hanging below U1 with the bottom section only', () => {
    const outside = userRack({
      placements: [
        placementAt(CATALOG, 'pl-above', EDITOR_IDS.blank1u, 60),
        placementAt(CATALOG, 'pl-half-below', EDITOR_IDS.blank1u, -3),
      ],
    })
    const owned = recorded(outside)
    expect(placementOf(owned, 'pl-half-below').have).toBeDefined()
    expect(placementOf(owned, 'pl-above').have).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------
// Finish build

describe('finishBuild', () => {
  const plan = userRack({
    equipment: [
      { id: 'eq-ds', deviceId: EDITOR_IDS.ds224 },
      { id: 'eq-pi', deviceId: EDITOR_IDS.rpi5, have: true },
    ],
    extras: [
      { id: 'ex-feet', itemId: EDITOR_IDS.rubberFeet, qty: 4, haveQty: 1 },
      { id: 'ex-spare', itemId: EDITOR_IDS.rubberFeet, qty: 2, haveQty: 3 },
    ],
  })

  it('turns every Need into Have and counts each change', () => {
    const { plan: built, changed } = finishBuild(plan, KWS_FRAME, LATER, CATALOG)
    // 2 sections + 2 caps + 5 placements + 2 devices + 1 tray entry + 1 extra
    expect(changed).toBe(13)
    expect(built.frame.sections.map((section) => section.have?.at)).toEqual([LATER, LATER])
    expect(built.frame.caps.top.have?.at).toBe(LATER)
    expect(built.frame.caps.bottom.have?.at).toBe(LATER)
    expect(built.placements.every((placement) => placement.have?.at === LATER)).toBe(true)
    expect(built.placements.flatMap((placement) => placement.devices).every((d) => d.have)).toBe(
      true,
    )
    expect(built.equipment.map((entry) => entry.have)).toEqual([true, true])
    expect(built.extras.map((extra) => extra.haveQty)).toEqual([4, 3])
    expect(shopping(bom(built))).toEqual({})
  })

  it('changes nothing the second time', () => {
    const once = finishBuild(plan, KWS_FRAME, LATER, CATALOG).plan
    expect(finishBuild(once, KWS_FRAME, '2027-01-01T00:00:00.000Z', CATALOG)).toEqual({
      plan: once,
      changed: 0,
    })
    expect(finishBuild(once, KWS_FRAME, '2027-01-01T00:00:00.000Z').plan).toBe(once)
  })

  it('re-captures owned sections that the plan rebuilds as another type', () => {
    const built = markSection(kwsPlan({ sections: [3] }), 'sec-1', true, FIXTURE_NOW, KWS_FRAME)
    const rebuilt: Plan = {
      ...built.plan,
      frame: {
        ...built.plan.frame,
        sections: built.plan.frame.sections.map((section) => ({ ...section, typeId: 's6' })),
      },
    }
    expect(shopping(bom(rebuilt))[KEYS.leg6]).toBe(4)
    const finished = finishBuild(rebuilt, KWS_FRAME, LATER)
    expect(finished.plan.frame.sections[0]?.have).toMatchObject({ typeId: 's6', heightU: 6 })
    expect(shopping(bom(finished.plan))).toEqual({})
  })

  it('skips sections of unknown types and caps of an empty stack', () => {
    const odd = kwsPlan({ sections: [3, 6] })
    const withUnknown: Plan = {
      ...odd,
      frame: {
        ...odd.frame,
        sections: odd.frame.sections.map((section, index) =>
          index === 1 ? { ...section, typeId: 's9' } : section,
        ),
      },
    }
    const finished = finishBuild(withUnknown, KWS_FRAME, LATER)
    expect(finished.plan.frame.sections.map((section) => section.have !== undefined)).toEqual([
      true,
      false,
    ])
    expect(finished.changed).toBe(3) // 1 section + 2 caps

    const empty = kwsPlan({ equipment: [{ id: 'eq-ds', deviceId: EDITOR_IDS.ds224 }] })
    const emptyBuilt = finishBuild(empty, KWS_FRAME, LATER)
    expect(emptyBuilt.changed).toBe(1)
    expect(emptyBuilt.plan.frame.caps).toBe(empty.frame.caps)
  })

  it('returns the same plan when everything is already Have', () => {
    const owned = finishBuild(kwsPlan({ sections: [6] }), KWS_FRAME, LATER).plan
    expect(finishBuild(owned, KWS_FRAME, LATER)).toEqual({ plan: owned, changed: 0 })
    expect(finishBuild(owned, KWS_FRAME, LATER).plan).toBe(owned)
  })
})

// ---------------------------------------------------------------------------------------------
// Properties

const PLACEABLES = [
  EDITOR_IDS.tinyMount,
  EDITOR_IDS.blank1u,
  EDITOR_IDS.shelf2u,
  EDITOR_IDS.pdu,
  EDITOR_IDS.nasShelf,
] as const

const sectionsArb = fc.array(
  fc.record({ u: fc.constantFrom(3 as const, 6 as const), have: fc.boolean() }),
  { minLength: 1, maxLength: 4 },
)

const placementsArb = fc.array(
  fc.record({
    itemId: fc.constantFrom(...PLACEABLES),
    y: fc.integer({ min: -6, max: 90 }),
    have: fc.boolean(),
    deviceHave: fc.boolean(),
    lip: fc.option(fc.boolean(), { nil: undefined }),
  }),
  { maxLength: 8 },
)

const traysArb = fc.array(
  fc.record({
    deviceId: fc.constantFrom(EDITOR_IDS.ds224, EDITOR_IDS.rpi5, EDITOR_IDS.m720q),
    have: fc.boolean(),
  }),
  { maxLength: 3 },
)

const extrasArb = fc.array(fc.record({ qty: fc.nat({ max: 5 }), haveQty: fc.nat({ max: 6 }) }), {
  maxLength: 2,
})

const rackOptionsArb = fc.constantFrom<OptionValues>(
  {},
  { 'insert-policy': 'top-bottom' },
  { 'deep-320': true },
)

interface PlanSeed {
  sections: Array<{ u: 3 | 6; have: boolean }>
  placements: Array<{
    itemId: (typeof PLACEABLES)[number]
    y: number
    have: boolean
    deviceHave: boolean
    lip: boolean | undefined
  }>
  trays: Array<{ deviceId: string; have: boolean }>
  extras: Array<{ qty: number; haveQty: number }>
  rackOptions: OptionValues
}

function seededPlan(seed: PlanSeed): Plan {
  const plan = kwsPlan({
    sections: seed.sections,
    rackOptions: seed.rackOptions,
    placements: seed.placements.map((spec, index) => {
      const id = `pl-${index + 1}`
      const devices =
        spec.itemId === EDITOR_IDS.tinyMount
          ? [
              {
                id: `dv-${index + 1}`,
                deviceId: EDITOR_IDS.m720q,
                slotId: 'bay',
                have: spec.deviceHave,
              },
            ]
          : spec.itemId === EDITOR_IDS.nasShelf
            ? [
                {
                  id: `dv-${index + 1}`,
                  deviceId: EDITOR_IDS.ds224,
                  slotId: 'deck',
                  have: spec.deviceHave,
                },
              ]
            : []
      return placementAt(CATALOG, id, spec.itemId, spec.y, {
        devices,
        ...(spec.lip === undefined ? {} : { options: { lip: spec.lip } }),
        ...(spec.have ? { have: { at: FIXTURE_NOW, itemId: spec.itemId, options: {} } } : {}),
      })
    }),
    equipment: seed.trays.map((tray, index) => ({ id: `eq-${index + 1}`, ...tray })),
    extras: seed.extras.map((extra, index) => ({
      id: `ex-${index + 1}`,
      itemId: EDITOR_IDS.rubberFeet,
      ...extra,
    })),
  })
  return plan
}

const seedArb: fc.Arbitrary<PlanSeed> = fc.record({
  sections: sectionsArb,
  placements: placementsArb,
  trays: traysArb,
  extras: extrasArb,
  rackOptions: rackOptionsArb,
})

describe('properties', () => {
  test.prop([seedArb])('Finish build leaves nothing to get and is idempotent', (seed) => {
    const plan = seededPlan(seed)
    const { plan: built } = finishBuild(plan, KWS_FRAME, LATER, CATALOG)
    expect(shoppingLines(bom(built))).toEqual([])
    expect(finishBuild(built, KWS_FRAME, LATER, CATALOG)).toEqual({ plan: built, changed: 0 })
  })

  test.prop([seedArb])('marking every section Have owns everything inside the rack', (seed) => {
    const plan = seededPlan(seed)
    const top = totalHeightSixths(plan, KWS_FRAME)
    const owned = recorded(plan, LATER)
    expect(owned.frame.sections.every((section) => section.have !== undefined)).toBe(true)
    for (const placement of owned.placements) {
      const original = placementOf(plan, placement.id)
      const inside = placement.y >= 0 && placement.y < top
      if (inside) {
        expect(placement.have).toBeDefined()
        expect(placement.devices.every((device) => device.have)).toBe(true)
      } else {
        // Entirely outside the stack: no section owns it (one hanging below U1 can be marked).
        if (placement.y >= top) expect(placement).toBe(original)
      }
    }
    if (seed.sections.every((section) => !section.have)) {
      expect(owned.frame.caps.top.have?.at).toBe(LATER)
      expect(owned.frame.caps.bottom.have?.at).toBe(LATER)
    }
  })

  test.prop([seedArb, fc.nat()])(
    'Have then Need on a section restores its section, placements and devices',
    (seed, pick) => {
      const plan = seededPlan({
        ...seed,
        sections: seed.sections.map((section) => ({ ...section, have: false })),
        placements: seed.placements.map((placement) => ({
          ...placement,
          have: false,
          deviceHave: false,
        })),
      })
      const section = plan.frame.sections[pick % plan.frame.sections.length]
      if (section === undefined) return
      const marked = markSectionContents(plan, KWS_FRAME, section.id, true, LATER, CATALOG)
      const unmarked = markSectionContents(marked, KWS_FRAME, section.id, false, LATER, CATALOG)
      expect(unmarked.frame.sections).toEqual(plan.frame.sections)
      expect(unmarked.placements).toEqual(plan.placements)
    },
  )
})
