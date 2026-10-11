import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import type { BomLine, BomResult } from './api'
import {
  brickKey,
  computeBom,
  consumeInventory,
  designerTableNote,
  explainQuantities,
  packRound,
  pickEquipmentScrew,
  shoppingLines,
  surplusLines,
} from './bom'
import { deviceKey, hardwareKey, printKey } from './ids'
import { DeviceSchema, type CatalogLookup } from './schema/catalog'
import { checkEntryIntegrity } from './schema/integrity'
import type { Plan } from './schema/plan'
import { defaultSettings, type Inventory, type Settings } from './schema/settings'
import {
  FIXTURE_NOW,
  KWS_ENTRIES,
  KWS_FRAME,
  KWS_FRAME_ID,
  KWS_FRAME_INPUT,
  KWS_IDS,
  kwsCatalog,
  kwsPlan,
  markEverythingHave,
  parseEntries,
  type KwsPlanSpec,
  type SectionSpec,
} from './__fixtures__/kws'

const NO_SPARES: Settings = { ...defaultSettings(), sparePct: { default: 0 } }
const CATALOG = kwsCatalog()

const frameKey = (printId: string) => printKey(KWS_FRAME_ID, printId)
const KEYS = {
  inserts: hardwareKey(KWS_IDS.inserts),
  m6x8: hardwareKey(KWS_IDS.m6x8),
  m6x10: hardwareKey(KWS_IDS.m6x10),
  nyloc: hardwareKey(KWS_IDS.nyloc),
  magnets: hardwareKey(KWS_IDS.magnets),
  m5x10: hardwareKey(KWS_IDS.m5x10),
  m5x12: hardwareKey(KWS_IDS.m5x12),
  m5x16: hardwareKey(KWS_IDS.m5x16),
  leg6: frameKey('leg-6u'),
  plate3: frameKey('plate-3u'),
  connectors: frameKey('frame-connectors'),
  topHandle: frameKey('top-handle'),
  topFlat: frameKey('top-flat'),
  topConnectors: frameKey('top-connectors'),
  baseLegs: frameKey('base-legs'),
  bottomConnectors: frameKey('bottom-connectors'),
  tinyMount: printKey('lenovo-tiny-mount', 'mount'),
  m720q: deviceKey('lenovo-m720q'),
}

interface BomOptions {
  settings?: Settings
  inventory?: Inventory
  catalog?: CatalogLookup
}

function bom(plan: Plan, options: BomOptions = {}): BomResult {
  return computeBom(
    plan,
    options.catalog ?? CATALOG,
    options.settings ?? NO_SPARES,
    options.inventory ?? {},
  )
}

function lineOf(result: BomResult, key: string): BomLine {
  const line = result.lines.find((candidate) => candidate.key === key)
  if (line === undefined) throw new Error(`no BOM line ${key}`)
  return line
}

type Field = 'target' | 'asBuilt' | 'install' | 'need' | 'buy' | 'surplus'

/** Inserts / M6×8 / M6×10 / nyloc / magnets: the designer table's columns. */
function row(result: BomResult, field: Field = 'target'): number[] {
  return [KEYS.inserts, KEYS.m6x8, KEYS.m6x10, KEYS.nyloc, KEYS.magnets].map(
    (key) => result.lines.find((line) => line.key === key)?.[field] ?? 0,
  )
}

/** The shopping list as { key: buy }. */
function shopping(result: BomResult): Record<string, number> {
  return Object.fromEntries(shoppingLines(result).map((line) => [line.key, line.buy]))
}

const BUILT: SectionSpec[] = [
  { u: 3, have: true },
  { u: 6, have: true },
]
const [BUILT_3U, BUILT_6U] = BUILT as [SectionSpec, SectionSpec]

describe('the frozen KWS fixture', () => {
  it('is internally consistent', () => {
    for (const entry of KWS_ENTRIES)
      expect([entry.id, checkEntryIntegrity(entry)]).toEqual([entry.id, []])
  })
})

describe('full BOM: the designer table rows (6U-first stacks)', () => {
  const rows: Array<[Array<3 | 6>, number[]]> = [
    [[3], [36, 16, 24, 40, 23]],
    [[6], [72, 16, 24, 40, 63]],
    [
      [6, 3],
      [108, 32, 48, 80, 79],
    ],
    [
      [6, 6],
      [144, 32, 48, 80, 119],
    ],
    [
      [6, 6, 3],
      [180, 48, 72, 120, 135],
    ],
    [
      [6, 6, 6],
      [216, 48, 72, 120, 175],
    ],
  ]

  it.each(rows)('%j', (sections, expected) => {
    const result = bom(kwsPlan({ sections }))
    expect(row(result)).toEqual(expected)
    // Nothing is owned yet, so every unit is to buy.
    expect(row(result, 'buy')).toEqual(expected)
    expect(row(result, 'asBuilt')).toEqual([0, 0, 0, 0, 0])
  })

  it('counts [3, 3] and [3, 6, 3] per section, not per height', () => {
    expect(row(bom(kwsPlan({ sections: [3, 3] })))).toEqual([72, 32, 48, 80, 39])
    expect(row(bom(kwsPlan({ sections: [3, 6, 3] })))).toEqual([144, 48, 72, 120, 95])
  })

  it('follows the top-and-bottom insert policy', () => {
    const result = bom(
      kwsPlan({ sections: [6, 3], rackOptions: { 'insert-policy': 'top-bottom' } }),
    )
    expect(lineOf(result, KEYS.inserts).target).toBe(4 * 12 + 24)
  })
})

describe("extending the user's rack (3U + 6U built)", () => {
  const stacks: Array<[string, Array<SectionSpec | 3 | 6>]> = [
    ['top', [BUILT_3U, BUILT_6U, 3]],
    ['bottom', [3, BUILT_3U, BUILT_6U]],
    ['between', [BUILT_3U, 3, BUILT_6U]],
  ]

  it.each(stacks)('adds one 3U at the %s: 1 plate, 1 connectors, 36/16/24/40/16', (_, sections) => {
    const result = bom(kwsPlan({ sections }))
    expect(shopping(result)).toEqual({
      [KEYS.plate3]: 1,
      [KEYS.connectors]: 1,
      [KEYS.inserts]: 36,
      [KEYS.m6x8]: 16,
      [KEYS.m6x10]: 24,
      [KEYS.nyloc]: 40,
      [KEYS.magnets]: 16,
    })
    expect(row(result, 'install')).toEqual([36, 16, 24, 40, 16])
    expect(row(result)).toEqual([144, 48, 72, 120, 95])
    expect(row(result, 'asBuilt')).toEqual([108, 32, 48, 80, 79])
    expect(surplusLines(result)).toEqual([])
  })

  it('explains the sum in plain language', () => {
    const result = bom(kwsPlan({ sections: [BUILT_3U, BUILT_6U, 3] }))
    expect(lineOf(result, KEYS.inserts).why).toBe('36 = 144 in plan − 108 in your rack − 0 spares')
    expect(lineOf(result, KEYS.plate3).why).toBe('1 = 2 in plan − 1 in your rack − 0 spares')
  })

  it('adds one 6U: 72/16/24/40/56, 4 legs and 1 connectors', () => {
    const result = bom(kwsPlan({ sections: [BUILT_3U, BUILT_6U, 6] }))
    expect(shopping(result)).toEqual({
      [KEYS.leg6]: 4,
      [KEYS.connectors]: 1,
      [KEYS.inserts]: 72,
      [KEYS.m6x8]: 16,
      [KEYS.m6x10]: 24,
      [KEYS.nyloc]: 40,
      [KEYS.magnets]: 56,
    })
  })

  it('buys no magnets for a new section without magnets, while Full still counts the built 79', () => {
    const result = bom(
      kwsPlan({ sections: [BUILT_3U, BUILT_6U, { u: 3, options: { magnets: false } }] }),
    )
    const magnets = lineOf(result, KEYS.magnets)
    expect(magnets).toMatchObject({ target: 79, asBuilt: 79, install: 0, need: 0, buy: 0 })
    expect(shopping(result)[KEYS.magnets]).toBeUndefined()
    expect(shopping(result)[KEYS.inserts]).toBe(36)
  })

  it('switches the top: buys 2 flat tops and lists the 2 handles as surplus', () => {
    const result = bom(
      kwsPlan({
        sections: BUILT,
        top: { options: { top: 'flat' }, builtOptions: { top: 'handle' } },
      }),
    )
    expect(shopping(result)).toEqual({ [KEYS.topFlat]: 2 })
    expect(surplusLines(result).map((line) => [line.key, line.surplus])).toEqual([
      [KEYS.topHandle, 2],
    ])
    expect(lineOf(result, KEYS.topHandle).why).toBe(
      '0 to get: 0 in plan, 2 in your rack (2 surplus)',
    )
  })

  it('needs the once-per-rack prints when the caps were not captured', () => {
    const result = bom(kwsPlan({ sections: BUILT, top: { have: false }, bottom: { have: false } }))
    expect(shopping(result)).toEqual({
      [KEYS.topHandle]: 2,
      [KEYS.topConnectors]: 2,
      [KEYS.baseLegs]: 2,
      [KEYS.bottomConnectors]: 2,
    })
  })
})

describe('a new rack', () => {
  it('buys everything for [6, 6], once-per-rack prints included', () => {
    const result = bom(kwsPlan({ sections: [6, 6] }))
    expect(shopping(result)).toEqual({
      [KEYS.inserts]: 144,
      [KEYS.m6x8]: 32,
      [KEYS.m6x10]: 48,
      [KEYS.nyloc]: 80,
      [KEYS.magnets]: 119,
      [KEYS.leg6]: 8,
      [KEYS.connectors]: 1,
      [KEYS.topHandle]: 2,
      [KEYS.topConnectors]: 2,
      [KEYS.baseLegs]: 2,
      [KEYS.bottomConnectors]: 2,
    })
  })

  it('totals grams and minutes by material, and prices the filament', () => {
    const { totals } = bom(kwsPlan({ sections: [6, 6] }))
    // 8 legs, 1 connectors plate, 2 handles, 2 top connectors, 2 base legs, 2 bottom connectors.
    const grams = 8 * 125 + 68 + 2 * 217 + 2 * 44 + 2 * 131 + 2 * 45
    const minutes = 8 * 323 + 180 + 2 * 421 + 2 * 85 + 2 * 248 + 2 * 89
    expect(totals.printsGramsByMaterial).toEqual({ PETG: grams })
    expect(totals.needGramsByMaterial).toEqual({ PETG: grams })
    expect(totals.printMinutes).toBe(minutes)
    expect(totals.needMinutes).toBe(minutes)
    expect(totals.cost).toBe(Math.round(grams * 22 * 0.1) / 100)
  })

  it('counts only prints still to make in the "to get" totals', () => {
    const { totals } = bom(kwsPlan({ sections: [BUILT_3U, BUILT_6U, 3] }))
    expect(totals.needGramsByMaterial).toEqual({ PETG: 214 + 68 })
    const caps = 2 * 217 + 2 * 44 + 2 * 131 + 2 * 45
    expect(totals.printsGramsByMaterial.PETG).toBe(2 * 214 + 4 * 125 + 2 * 68 + caps)
  })

  it('omits the cost when nothing has a price', () => {
    const settings = { ...NO_SPARES, filamentCostPerKg: {} }
    expect(bom(kwsPlan({ sections: [6] }), { settings }).totals.cost).toBeUndefined()
  })
})

describe('inventory, spares and packs', () => {
  const plan = kwsPlan({ sections: [BUILT_3U, BUILT_6U, 3] })
  const tenPercent: Settings = { ...NO_SPARES, sparePct: { insert: 0.1, default: 0 } }
  const packedCatalog = kwsCatalog(
    parseEntries([
      {
        kind: 'hardware',
        id: KWS_IDS.inserts,
        name: 'M5×8×7 heat-set insert',
        category: 'insert',
        packSizes: [50, 100],
      },
    ]),
  )

  it('adds 10 % spares and uses what is on hand', () => {
    const inserts = lineOf(
      bom(plan, { settings: tenPercent, inventory: { [KEYS.inserts]: 40 } }),
      KEYS.inserts,
    )
    expect(inserts).toMatchObject({ install: 36, spare: 4, need: 0, buy: 0 })
    expect(inserts.why).toBe('0 = 144 in plan − 108 in your rack + 4 extra (10%) − 40 spares')
  })

  it('rounds up to packs', () => {
    const inserts = lineOf(
      bom(plan, { settings: tenPercent, catalog: packedCatalog }),
      KEYS.inserts,
    )
    expect(inserts).toMatchObject({ install: 36, spare: 4, need: 40, buy: 50 })
    expect(inserts.why).toBe(
      '40 = 144 in plan − 108 in your rack + 4 extra (10%) − 0 spares; buy 50 (1 × 50)',
    )
  })

  it('prices the cheapest pack combination', () => {
    const settings: Settings = {
      ...tenPercent,
      filamentCostPerKg: {},
      packPrices: {
        [KWS_IDS.inserts]: [
          { size: 50, price: 6 },
          { size: 100, price: 10 },
        ],
      },
    }
    const result = bom(plan, { settings, catalog: packedCatalog })
    expect(lineOf(result, KEYS.inserts).buy).toBe(50)
    expect(result.totals.cost).toBe(6)
  })

  it('consumes what a build installs, keeping the leftovers', () => {
    const inventory = { [KEYS.inserts]: 50, [KEYS.m6x8]: 20, 'hw:unrelated': 3 }
    const before = bom(plan, { inventory })
    const built = kwsPlan({ sections: [BUILT_3U, BUILT_6U, { u: 3, have: true }] })
    const after = bom(built, { inventory })
    expect(shoppingLines(after)).toEqual([])
    expect(consumeInventory(before, after, inventory)).toEqual({
      [KEYS.inserts]: 14,
      [KEYS.m6x8]: 4,
      'hw:unrelated': 3,
    })
  })

  it('never consumes below zero and drops emptied entries', () => {
    const before = bom(plan)
    const after = bom(kwsPlan({ sections: [BUILT_3U, BUILT_6U, { u: 3, have: true }] }))
    expect(consumeInventory(before, after, { [KEYS.nyloc]: 10 })).toEqual({})
  })
})

describe('packRound', () => {
  it('keeps the quantity without packs', () => {
    expect(packRound(7)).toEqual({ buy: 7, packs: [] })
    expect(packRound(0, [50])).toEqual({ buy: 0, packs: [] })
  })

  it('takes the smallest pack that covers the need', () => {
    expect(packRound(40, [100, 50])).toEqual({ buy: 50, packs: [{ size: 50, count: 1 }] })
    expect(packRound(100, [50, 100])).toEqual({ buy: 100, packs: [{ size: 100, count: 1 }] })
  })

  it('fills larger needs with the largest pack and tops up', () => {
    expect(packRound(250, [50, 100])).toEqual({
      buy: 250,
      packs: [
        { size: 100, count: 2 },
        { size: 50, count: 1 },
      ],
    })
    expect(packRound(300, [100])).toEqual({ buy: 300, packs: [{ size: 100, count: 3 }] })
  })

  it('finds the cheapest combination when prices are known', () => {
    const prices = [
      { size: 50, price: 6 },
      { size: 100, price: 10 },
    ]
    expect(packRound(120, [], prices)).toEqual({
      buy: 150,
      packs: [
        { size: 100, count: 1 },
        { size: 50, count: 1 },
      ],
      cost: 16,
    })
    expect(packRound(40, [], prices)).toEqual({ buy: 50, packs: [{ size: 50, count: 1 }], cost: 6 })
  })

  it('prefers fewer pieces, then fewer packs, at the same price', () => {
    const even = [
      { size: 50, price: 5 },
      { size: 100, price: 10 },
    ]
    expect(packRound(100, [], even)).toMatchObject({ buy: 100, packs: [{ size: 100, count: 1 }] })
    expect(
      packRound(
        40,
        [],
        [
          { size: 40, price: 5 },
          { size: 50, price: 5 },
        ],
      ),
    ).toMatchObject({
      buy: 40,
    })
  })

  test.prop([
    fc.integer({ min: 1, max: 500 }),
    fc.uniqueArray(fc.integer({ min: 1, max: 120 }), { minLength: 1, maxLength: 4 }),
  ])('always covers the need', (need, sizes) => {
    const plain = packRound(need, sizes)
    expect(plain.buy).toBeGreaterThanOrEqual(need)
    expect(plain.packs.reduce((sum, pack) => sum + pack.size * pack.count, 0)).toBe(plain.buy)
    const priced = packRound(
      need,
      [],
      sizes.map((size) => ({ size, price: size / 10 + 1 })),
    )
    expect(priced.buy).toBeGreaterThanOrEqual(need)
    expect(priced.packs.reduce((sum, pack) => sum + pack.size * pack.count, 0)).toBe(priced.buy)
  })
})

describe('rack screws', () => {
  const tiny = (id: string, y: number, extra: Record<string, unknown> = {}) => ({
    id,
    itemId: 'lenovo-tiny-mount',
    y,
    ...extra,
  })

  it('counts mount holes × 1 screw and keeps the designer list as a note only', () => {
    const result = bom(kwsPlan({ sections: [6], placements: [tiny('pl-1', 6), tiny('pl-2', 18)] }))
    const screws = lineOf(result, KEYS.m5x10)
    expect(screws).toMatchObject({ target: 8, need: 8, reusable: true })
    expect(screws.provenance.filter((entry) => entry.qty > 0)).toEqual([
      expect.objectContaining({ label: 'Lenovo Tiny mount @U2', qty: 4 }),
      expect.objectContaining({ label: 'Lenovo Tiny mount @U4', qty: 4 }),
    ])
    const notes = screws.provenance.filter((entry) => entry.qty === 0)
    expect(notes).toHaveLength(2)
    expect(notes[0]?.detail).toContain('The designer lists 4 × M5×10 socket head cap screw')
  })

  it('picks the shortest stock screw that is long enough', () => {
    expect(pickEquipmentScrew(KWS_FRAME, CATALOG)).toMatchObject({
      hardwareId: KWS_IDS.m5x10,
      requiredMm: 10,
    })
    expect(pickEquipmentScrew(KWS_FRAME, CATALOG, 5)?.hardwareId).toBe(KWS_IDS.m5x12)
    expect(pickEquipmentScrew(KWS_FRAME, CATALOG, 10)?.hardwareId).toBe(KWS_IDS.m5x16)
    expect(pickEquipmentScrew(KWS_FRAME, CATALOG, 12)).toMatchObject({
      hardwareId: KWS_IDS.m5x16,
      lengthMm: 16,
      requiredMm: 18,
    })
  })

  it('uses the front holes at the back for rear-supported items without rear holes', () => {
    const result = bom(
      kwsPlan({ sections: [6], placements: [{ id: 'pl-1', itemId: 'shelf-2u', y: 0 }] }),
    )
    expect(lineOf(result, KEYS.m5x12).target).toBe(8)
    expect(result.lines.some((line) => line.key === KEYS.m5x10)).toBe(false)
  })

  it('warns when no stock screw is long enough', () => {
    const thick = parseEntries([
      {
        kind: 'item',
        id: 'custom:thick-ears',
        name: 'Thick ears',
        category: 'panel',
        verified: { by: 'test', date: '2026-10-11', method: 'unverified' },
        heightSixths: 6,
        depthMm: 10,
        mount: { front: 2, earThicknessMm: 12 },
      },
    ])
    const result = bom(
      kwsPlan({ sections: [3], placements: [{ id: 'pl-1', itemId: 'custom:thick-ears', y: 0 }] }),
      {
        catalog: kwsCatalog(thick),
      },
    )
    expect(lineOf(result, KEYS.m5x16).target).toBe(2)
    expect(result.warnings.join('\n')).toContain('no stock M5 screw is 18 mm or longer')
  })

  it('adds a nut or cage nut per hole when the frame needs one', () => {
    const cageFrame = parseEntries([
      {
        ...KWS_FRAME_INPUT,
        equipmentFastener: {
          thread: 'M6',
          perHole: 'screw+cage-nut',
          screwIds: [KWS_IDS.m6x10],
          engagementMm: 6,
        },
      },
    ])
    const plan = kwsPlan({ sections: [3], placements: [tiny('pl-1', 0)] })
    const caged = bom(plan, { catalog: kwsCatalog(cageFrame) })
    expect(lineOf(caged, hardwareKey(KWS_IDS.m6CageNut)).target).toBe(4)
    expect(lineOf(caged, KEYS.m6x10).target).toBe(24 + 4)

    const nutFrame = parseEntries([
      {
        ...KWS_FRAME_INPUT,
        equipmentFastener: {
          ...KWS_FRAME_INPUT.equipmentFastener,
          perHole: 'screw+nut',
          nutId: KWS_IDS.m5Nut,
        },
      },
    ])
    const nutted = bom(plan, { catalog: kwsCatalog(nutFrame) })
    expect(lineOf(nutted, hardwareKey(KWS_IDS.m5Nut)).target).toBe(4)
  })

  it('mounts ear-mounted gear placed directly, with screws', () => {
    const result = bom(
      kwsPlan({ sections: [3], placements: [{ id: 'pl-pdu', itemId: 'pdu-4', y: 0 }] }),
    )
    expect(lineOf(result, deviceKey('pdu-4')).target).toBe(1)
    expect(lineOf(result, KEYS.m5x10).target).toBe(4)
  })
})

describe('devices', () => {
  const placements = [
    {
      id: 'pl-1',
      itemId: 'lenovo-tiny-mount',
      y: 0,
      have: { at: FIXTURE_NOW, itemId: 'lenovo-tiny-mount' },
      devices: [{ id: 'dv-1', deviceId: 'lenovo-m720q', slotId: 'bay', have: true }],
    },
    {
      id: 'pl-2',
      itemId: 'lenovo-tiny-mount',
      y: 6,
      devices: [{ id: 'dv-2', deviceId: 'lenovo-m720q', slotId: 'bay' }],
    },
  ]

  it('needs the devices you do not own yet', () => {
    const result = bom(kwsPlan({ sections: BUILT, placements }))
    expect(lineOf(result, KEYS.m720q)).toMatchObject({ target: 2, asBuilt: 1, need: 1, buy: 1 })
    expect(lineOf(result, KEYS.tinyMount)).toMatchObject({ target: 2, asBuilt: 1, need: 1 })
    expect(lineOf(result, KEYS.m5x10)).toMatchObject({ target: 8, asBuilt: 4, need: 4 })
  })

  it('lists included power bricks without ever buying them', () => {
    const result = bom(kwsPlan({ sections: BUILT, placements }))
    const brick = lineOf(result, brickKey('lenovo-m720q'))
    expect(brick).toMatchObject({
      included: true,
      target: 2,
      asBuilt: 1,
      need: 0,
      buy: 0,
      surplus: 0,
    })
    expect(brick.label).toBe('Power brick for Lenovo ThinkCentre M720q Tiny')
    expect(shoppingLines(result).some((line) => line.key === brick.key)).toBe(false)
  })

  it('buys power bricks that do not ship with the device', () => {
    const result = bom(kwsPlan({ sections: [3], equipment: [{ id: 'eq-1', deviceId: 'rpi-5' }] }))
    expect(shopping(result)).toMatchObject({ [deviceKey('rpi-5')]: 1, [brickKey('rpi-5')]: 1 })
  })

  it('counts owned equipment and inventory', () => {
    const plan = kwsPlan({
      sections: [3],
      equipment: [
        { id: 'eq-1', deviceId: 'nas-2bay', have: true },
        { id: 'eq-2', deviceId: 'nas-2bay' },
        { id: 'eq-3', deviceId: 'nas-2bay' },
      ],
    })
    const nas = lineOf(
      bom(plan, { inventory: { [deviceKey('nas-2bay')]: 1 } }),
      deviceKey('nas-2bay'),
    )
    expect(nas).toMatchObject({ target: 3, asBuilt: 1, install: 2, need: 1 })
    expect(nas.why).toBe('1 = 3 in plan − 1 in your rack − 1 spares')
  })

  it('keeps unknown devices as id-only lines with a warning', () => {
    const result = bom(
      kwsPlan({ sections: [3], equipment: [{ id: 'eq-1', deviceId: 'mystery-box' }] }),
    )
    expect(lineOf(result, deviceKey('mystery-box'))).toMatchObject({
      label: 'mystery-box',
      need: 1,
    })
    expect(result.warnings.join('\n')).toContain('"mystery-box" is not in the catalog')
  })
})

describe('retired parts stay owned', () => {
  const retiredMount = {
    id: 'rt-1',
    kind: 'placement' as const,
    sourceId: 'pl-old',
    snapshot: { at: FIXTURE_NOW, itemId: 'lenovo-tiny-mount', options: {} },
    devices: ['lenovo-m720q'],
  }
  const replaced = {
    id: 'pl-new',
    itemId: 'lenovo-tiny-mount',
    y: 24,
    devices: [{ id: 'dv-1', deviceId: 'lenovo-m720q', slotId: 'bay' }],
  }

  it('reuses a deleted built placement when it is placed again', () => {
    const result = bom(
      kwsPlan({ sections: BUILT, placements: [replaced], retired: [retiredMount] }),
    )
    expect(shoppingLines(result)).toEqual([])
    expect(lineOf(result, KEYS.tinyMount)).toMatchObject({ target: 1, asBuilt: 1, need: 0 })
    expect(lineOf(result, KEYS.m720q)).toMatchObject({ target: 1, asBuilt: 1, need: 0 })
    expect(lineOf(result, KEYS.m5x10)).toMatchObject({ target: 4, asBuilt: 4, need: 0 })
  })

  it('shows retired parts as surplus while nothing uses them', () => {
    const result = bom(kwsPlan({ sections: BUILT, retired: [retiredMount] }))
    expect(lineOf(result, KEYS.tinyMount).surplus).toBe(1)
    expect(lineOf(result, KEYS.m720q).surplus).toBe(1)
  })

  it('keeps a retired section and its joint, but never its embedded hardware, as surplus', () => {
    const plan = kwsPlan({
      sections: BUILT,
      retired: [
        {
          id: 'rt-2',
          kind: 'section',
          sourceId: 'sec-3',
          snapshot: { at: FIXTURE_NOW, typeId: 's3', heightU: 3, options: { magnets: true } },
        },
      ],
    })
    const result = bom(plan)
    expect(shoppingLines(result)).toEqual([])
    expect(lineOf(result, KEYS.plate3).surplus).toBe(1)
    expect(lineOf(result, KEYS.connectors).surplus).toBe(1)
    expect(row(result, 'surplus')).toEqual([0, 16, 24, 40, 0])
  })

  it('reuses a retired 3U for a new 3U elsewhere, inserts included', () => {
    const plan = kwsPlan({
      sections: [BUILT_3U, BUILT_6U, 3],
      retired: [
        {
          id: 'rt-2',
          kind: 'section',
          snapshot: { at: FIXTURE_NOW, typeId: 's3', heightU: 3, options: {} },
        },
      ],
    })
    expect(shoppingLines(bom(plan))).toEqual([])
  })

  it('counts retired caps', () => {
    const plan = kwsPlan({
      sections: BUILT,
      top: { options: { top: 'flat' }, builtOptions: { top: 'flat' } },
      retired: [
        {
          id: 'rt-3',
          kind: 'cap',
          sourceId: 'top',
          snapshot: { at: FIXTURE_NOW, options: { top: 'handle' } },
        },
      ],
    })
    const result = bom(plan)
    expect(lineOf(result, KEYS.topHandle).surplus).toBe(2)
    expect(lineOf(result, KEYS.topConnectors)).toMatchObject({ target: 2, asBuilt: 4, surplus: 2 })
  })
})

describe('extras and cut-to-length stock', () => {
  it('multiplies an extra by its quantity and owns haveQty', () => {
    const plan = kwsPlan({
      sections: [3],
      extras: [{ id: 'ex-1', itemId: 'rubber-feet', qty: 2, haveQty: 1 }],
    })
    expect(lineOf(bom(plan), hardwareKey(KWS_IDS.rubberFoot))).toMatchObject({
      target: 8,
      asBuilt: 4,
      need: 4,
    })
  })

  it('keys cut pieces per length and never rounds them to packs', () => {
    const railFrame = parseEntries([
      {
        ...KWS_FRAME_INPUT,
        recipe: [
          ...KWS_FRAME_INPUT.recipe,
          {
            id: 'rails',
            unit: 'section',
            ref: { hardware: 'extrusion-2020' },
            count: 4,
            length: { base: -2, perU: 44.45 },
          },
        ],
      },
      {
        kind: 'hardware',
        id: 'extrusion-2020',
        name: '2020 extrusion',
        category: 'extrusion',
        unit: 'mm',
        packSizes: [10],
      },
    ])
    const result = bom(kwsPlan({ sections: [3, 6, 3] }), { catalog: kwsCatalog(railFrame) })
    expect(lineOf(result, hardwareKey('extrusion-2020', 131.35))).toMatchObject({
      target: 8,
      buy: 8,
      unit: 'pcs',
      cutLengthMm: 131.35,
      label: '2020 extrusion, cut to 131.35 mm',
    })
    expect(lineOf(result, hardwareKey('extrusion-2020', 264.7)).target).toBe(4)
  })
})

describe('designer table note', () => {
  const note = (sections: Array<3 | 6>) => designerTableNote(KWS_FRAME, kwsPlan({ sections }))

  it('explains why a non-6U-first stack differs from the designer row', () => {
    expect(note([3, 6, 3])).toBe("The designer's 12U row assumes 6U+6U; this rack has 3 sections")
    expect(note([3, 3])).toBe("The designer's 6U row assumes 6U; this rack has 2 sections")
    expect(note([6, 6])).toBeUndefined()
    expect(note([3, 6])).toBeUndefined()
    expect(note([])).toBeUndefined()
  })

  it('is attached to the per-section hardware lines', () => {
    const result = bom(kwsPlan({ sections: [3, 6, 3] }))
    expect(lineOf(result, KEYS.m6x8).provenance).toContainEqual({
      label: 'Designer table',
      qty: 0,
      detail: "The designer's 12U row assumes 6U+6U; this rack has 3 sections",
    })
    expect(
      lineOf(result, KEYS.plate3).provenance.some((entry) => entry.label === 'Designer table'),
    ).toBe(false)
  })
})

describe('provenance and warnings', () => {
  it('labels sections by height and position, and owned parts as such', () => {
    const result = bom(kwsPlan({ sections: [BUILT_3U, BUILT_6U, 3] }))
    expect(lineOf(result, KEYS.m6x8).provenance).toEqual([
      { label: '3U section #1', qty: 16, detail: '16 per section' },
      { label: '6U section #2', qty: 16, detail: '16 per section' },
      { label: '3U section #3', qty: 16, detail: '16 per section' },
      { label: '3U section #1', qty: 16, detail: 'Owned: 16 per section' },
      { label: '6U section #2', qty: 16, detail: 'Owned: 16 per section' },
      {
        label: 'Designer table',
        qty: 0,
        detail: "The designer's 12U row assumes 6U+6U; this rack has 3 sections",
      },
    ])
    expect(lineOf(result, KEYS.connectors).provenance[0]?.label).toBe('Joint 3U #1 / 6U #2')
  })

  it('warns about unknown frames and parts without throwing', () => {
    const plan = kwsPlan({
      sections: [3],
      placements: [{ id: 'pl-1', itemId: 'gone-part', y: 0, name: 'Old mount' }],
    })
    const result = bom(plan)
    expect(result.warnings.join('\n')).toContain(
      'Part "gone-part" (Old mount @U1) is not in the catalog',
    )
    const noFrame = bom({ ...plan, frame: { ...plan.frame, frameId: 'unknown-frame' } })
    expect(noFrame.lines).toEqual([])
    expect(noFrame.warnings[0]).toContain('Frame "unknown-frame" is not in the catalog')
  })

  it('resolves the plan’s own custom entries', () => {
    const custom = DeviceSchema.parse({
      kind: 'device',
      id: 'custom:my-box',
      brand: 'Me',
      model: 'Box',
      category: 'other',
      dims: { w: 100, d: 100, h: 40 },
      verified: { by: 'me', date: '2026-10-11', method: 'calipers' },
    })
    const plan = kwsPlan({
      sections: [3],
      equipment: [{ id: 'eq-1', deviceId: 'custom:my-box' }],
      custom: { devices: [custom] },
    })
    expect(lineOf(bom(plan), deviceKey('custom:my-box')).label).toBe('Me Box')
  })
})

describe('explainQuantities', () => {
  const base = {
    target: 0,
    asBuilt: 0,
    install: 0,
    spare: 0,
    sparePct: 0,
    inventory: 0,
    need: 0,
    buy: 0,
    surplus: 0,
    packs: [],
  }

  it('describes embedded hardware that only follows prints still to make', () => {
    expect(explainQuantities({ ...base, target: 79, asBuilt: 23, install: 0 })).toBe(
      '0 to get: 79 in plan, 23 in your rack; the prints that hold them are already made',
    )
    expect(
      explainQuantities({ ...base, target: 95, asBuilt: 23, install: 16, need: 16, buy: 16 }),
    ).toBe('16 = 16 for what you still build (95 in plan, 23 in your rack) − 0 spares')
  })

  it('shows how much of a larger inventory is used', () => {
    expect(explainQuantities({ ...base, target: 10, asBuilt: 4, install: 6, inventory: 9 })).toBe(
      '0 = 10 in plan − 4 in your rack − 6 of your 9 spares',
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Properties

const sectionArb: fc.Arbitrary<SectionSpec> = fc.record({
  u: fc.constantFrom(3 as const, 6 as const),
  have: fc.boolean(),
  options: fc.record(
    { magnets: fc.boolean(), 'side-panels': fc.constantFrom('none', 'printed') },
    { requiredKeys: [] },
  ),
})

const rackOptionsArb = fc.record(
  {
    magnets: fc.boolean(),
    'insert-policy': fc.constantFrom('all', 'top-bottom'),
    'high-rack': fc.boolean(),
    'deep-320': fc.boolean(),
  },
  { requiredKeys: [] },
)

const placementArb = fc.record({
  itemId: fc.constantFrom('lenovo-tiny-mount', 'shelf-2u', 'blank-1u', 'pdu-4'),
  y: fc.integer({ min: 0, max: 60 }),
  device: fc.boolean(),
})

function planFromArbs(
  sections: SectionSpec[],
  rackOptions: Record<string, string | boolean>,
  placements: Array<{ itemId: string; y: number; device: boolean }>,
): Plan {
  const spec: KwsPlanSpec = {
    sections,
    rackOptions,
    placements: placements.map((placement, index) => ({
      id: `pl-${index}`,
      itemId: placement.itemId,
      y: placement.y,
      devices:
        placement.device && placement.itemId === 'lenovo-tiny-mount'
          ? [{ id: `dv-${index}`, deviceId: 'lenovo-m720q', slotId: 'bay' }]
          : [],
    })),
    equipment: [
      { id: 'eq-1', deviceId: 'rpi-5' },
      { id: 'eq-2', deviceId: 'nas-2bay' },
    ],
    extras: [{ id: 'ex-1', itemId: 'rubber-feet', qty: 2 }],
  }
  return kwsPlan(spec)
}

function targets(result: BomResult): Map<string, number> {
  return new Map(result.lines.map((line) => [line.key, line.target]))
}

describe('properties', () => {
  test.prop([
    fc.array(sectionArb, { maxLength: 6 }),
    rackOptionsArb,
    fc.array(placementArb, { maxLength: 4 }),
    fc.dictionary(fc.constantFrom(...Object.values(KEYS)), fc.integer({ min: 0, max: 200 })),
    fc.double({ min: 0, max: 1, noNaN: true }),
  ])('never asks for negative quantities', (sections, rackOptions, placements, inventory, pct) => {
    const settings: Settings = { ...NO_SPARES, sparePct: { default: pct } }
    const result = bom(planFromArbs(sections, rackOptions, placements), { settings, inventory })
    for (const line of result.lines) {
      for (const value of [line.install, line.spare, line.need, line.buy, line.surplus]) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(Number.isInteger(value)).toBe(true)
      }
      expect(line.buy).toBeGreaterThanOrEqual(line.need)
      expect(line.need).toBeLessThanOrEqual(line.install + line.spare)
    }
  })

  test.prop([
    fc.array(sectionArb, { minLength: 1, maxLength: 6 }),
    rackOptionsArb,
    fc.array(placementArb, { maxLength: 4 }),
  ])('has an empty shopping list when everything is Have', (sections, rackOptions, placements) => {
    const plan = markEverythingHave(planFromArbs(sections, rackOptions, placements))
    const result = computeBom(plan, CATALOG, defaultSettings(), {})
    expect(shoppingLines(result)).toEqual([])
    expect(surplusLines(result)).toEqual([])
  })

  test.prop([
    fc
      .array(sectionArb, { minLength: 1, maxLength: 6 })
      .chain((sections) =>
        fc.tuple(
          fc.constant(sections),
          fc.shuffledSubarray(sections, { minLength: sections.length, maxLength: sections.length }),
        ),
      ),
    rackOptionsArb,
  ])('keeps the target BOM when sections are reordered', ([sections, reordered], rackOptions) => {
    const before = bom(planFromArbs(sections, rackOptions, []))
    const after = bom(planFromArbs(reordered, rackOptions, []))
    expect(targets(after)).toEqual(targets(before))
  })
})

describe('performance budget', () => {
  /** The plan's budget: a BOM recompute on a 30U / 40-placement rack takes at most 5 ms. */
  const BUDGET_MS = 5

  it('recomputes a 30U rack with 40 placements within the budget (median)', () => {
    const items = ['lenovo-tiny-mount', 'blank-1u', 'shelf-2u', 'pdu-4']
    const plan = planFromArbs(
      [{ u: 6, have: true }, { u: 6, have: true }, { u: 6 }, { u: 6 }, { u: 6 }],
      { magnets: true },
      Array.from({ length: 40 }, (_, index) => ({
        itemId: items[index % items.length] ?? 'blank-1u',
        y: (index % 30) * 6,
        device: true,
      })),
    )
    expect(plan.placements).toHaveLength(40)
    for (let warmUp = 0; warmUp < 20; warmUp++) bom(plan)
    const times: number[] = []
    for (let run = 0; run < 101; run++) {
      const start = performance.now()
      bom(plan)
      times.push(performance.now() - start)
    }
    const median = times.toSorted((a, b) => a - b)[50] ?? Number.POSITIVE_INFINITY
    expect(median).toBeLessThan(BUDGET_MS)
  })
})
