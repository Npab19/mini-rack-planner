import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { brickKey, computeBom } from '@/domain/bom'
import { deviceKey, hardwareKey, printKey } from '@/domain/ids'
import { defaultSettings } from '@/domain/schema/settings'
import { KWS_FRAME_ID, KWS_IDS, kwsCatalog, kwsPlan, parseEntries } from '@/domain/__fixtures__/kws'
import {
  filterGroups,
  hardwareGroups,
  keyInfo,
  matchesQuery,
  NO_PLAN_NEEDS,
  onHandTotals,
  otherRows,
  planNeedsFrom,
  quantityWithUnit,
  rowCount,
  totalsText,
  type HardwareGroup,
} from './inventoryModel'

const CATALOG = kwsCatalog(
  parseEntries([
    {
      kind: 'hardware',
      id: 'extrusion-2020',
      name: '2020 extrusion',
      category: 'extrusion',
      unit: 'mm',
    },
    {
      kind: 'hardware',
      id: 'custom:m3-standoff',
      name: 'M3×10 brass standoff',
      category: 'standoff',
      packSizes: [20],
    },
  ]),
)
const SETTINGS = { ...defaultSettings(), sparePct: { default: 0 } }

const KEYS = {
  inserts: hardwareKey(KWS_IDS.inserts),
  m6x8: hardwareKey(KWS_IDS.m6x8),
  m6x10: hardwareKey(KWS_IDS.m6x10),
  magnets: hardwareKey(KWS_IDS.magnets),
  extrusion: hardwareKey('extrusion-2020'),
  cut: hardwareKey('extrusion-2020', 133.35),
  standoff: hardwareKey('custom:m3-standoff'),
}

function groups(inventory: Record<string, number> = {}, needs = NO_PLAN_NEEDS) {
  return hardwareGroups({ hardware: CATALOG.allHardware(), inventory, needs })
}

function rowOf(all: readonly HardwareGroup[], key: string) {
  const row = all.flatMap((group) => group.rows).find((candidate) => candidate.key === key)
  if (row === undefined) throw new Error(`no row ${key}`)
  return row
}

/** The user's KWS rack: 3U + 6U built, one more 3U planned on top. */
const USER_PLAN = kwsPlan({ sections: [{ u: 3, have: true }, { u: 6, have: true }, 3] })

describe('hardwareGroups', () => {
  it('lists every hardware part by category, numbers in order, with what is on hand', () => {
    const all = groups({ [KEYS.inserts]: 20 })
    expect(all.map((group) => group.title)).toEqual([
      'Screws',
      'Nuts',
      'Heat-set inserts',
      'Cage nuts',
      'Magnets',
      'Feet',
      'Standoffs',
      'Extrusion',
    ])
    expect(all[0]?.rows.map((row) => row.label)).toEqual([
      'M5×10 socket head cap screw',
      'M5×12 socket head cap screw',
      'M5×16 socket head cap screw',
      'M6×8 socket head cap screw',
      'M6×10 socket head cap screw',
    ])
    expect(rowOf(all, KEYS.inserts)).toMatchObject({
      label: 'M5 heat-set insert (M5x8x7)',
      qty: 20,
      unit: 'pcs',
      custom: false,
      unknown: false,
    })
    expect(rowOf(all, KEYS.m6x8).qty).toBe(0)
    expect(rowCount(all)).toBe(CATALOG.allHardware().length)
  })

  it('describes packs, stock by length, cut pieces and My parts', () => {
    const all = groups({ [KEYS.cut]: 4, [KEYS.extrusion]: 1000 })
    expect(rowOf(all, KEYS.standoff)).toMatchObject({ custom: true, details: 'Packs of 20' })
    expect(rowOf(all, KEYS.extrusion)).toMatchObject({ unit: 'mm', qty: 1000 })
    expect(rowOf(all, KEYS.cut)).toMatchObject({
      label: '2020 extrusion, cut to 133.35 mm',
      unit: 'pcs',
      qty: 4,
      cutLengthMm: 133.35,
    })
    // Cut pieces follow their stock.
    expect(all.find((group) => group.id === 'extrusion')?.rows.map((row) => row.key)).toEqual([
      KEYS.extrusion,
      KEYS.cut,
    ])
    // The fixture hardware has no pack sizes.
    expect(rowOf(all, KEYS.inserts).details).toBe('Sold one by one')
  })

  it('keeps hardware on hand that the catalog no longer has', () => {
    const all = groups({ 'hw:old-screw': 6 })
    expect(rowOf(all, 'hw:old-screw')).toMatchObject({
      label: 'old-screw',
      group: 'other',
      unknown: true,
      details: 'Not in the catalog',
      qty: 6,
    })
  })

  it('shows what each saved plan needs and buys after what is on hand', () => {
    const inventory = { [KEYS.inserts]: 20 }
    const needs = planNeedsFrom([
      {
        planId: 'plan-a',
        planName: 'Grow to 12U',
        bom: computeBom(USER_PLAN, CATALOG, SETTINGS, inventory),
      },
      {
        planId: 'plan-b',
        planName: 'Built',
        bom: computeBom(
          kwsPlan({ sections: [{ u: 3, have: true }] }),
          CATALOG,
          SETTINGS,
          inventory,
        ),
      },
    ])
    const row = rowOf(groups(inventory, needs), KEYS.inserts)
    // 36 to install, 20 on hand: buy 16 (the fixture has no packs).
    expect(row.plans).toEqual([{ planId: 'plan-a', planName: 'Grow to 12U', toGet: 36, buy: 16 }])
    const covered = rowOf(
      groups(
        { [KEYS.m6x8]: 100 },
        planNeedsFrom([
          {
            planId: 'plan-a',
            planName: 'Grow to 12U',
            bom: computeBom(USER_PLAN, CATALOG, SETTINGS, { [KEYS.m6x8]: 100 }),
          },
        ]),
      ),
      KEYS.m6x8,
    )
    expect(covered.plans).toEqual([
      { planId: 'plan-a', planName: 'Grow to 12U', toGet: 16, buy: 0 },
    ])
  })
})

describe('search and the filter', () => {
  it('finds parts by any word start: name, size, alias, category', () => {
    const insert = rowOf(groups(), KEYS.inserts)
    expect(matchesQuery(insert.tokens, 'm5 insert')).toBe(true)
    expect(matchesQuery(insert.tokens, 'M5x8')).toBe(true)
    expect(matchesQuery(insert.tokens, 'heat-set')).toBe(true)
    expect(matchesQuery(insert.tokens, '')).toBe(true)
    expect(matchesQuery(insert.tokens, 'magnet')).toBe(false)
    expect(matchesQuery(rowOf(groups(), KEYS.standoff).tokens, 'standoffs')).toBe(true)
  })

  it('shows only what is on hand, plus rows changed on this visit', () => {
    const all = groups({ [KEYS.inserts]: 20, [KEYS.magnets]: 0 })
    const only = filterGroups(all, { query: '', onlyOnHand: true })
    expect(only.flatMap((group) => group.rows.map((row) => row.key))).toEqual([KEYS.inserts])
    const kept = filterGroups(all, { query: '', onlyOnHand: true, keep: new Set([KEYS.m6x8]) })
    expect(kept.flatMap((group) => group.rows.map((row) => row.key))).toEqual([
      KEYS.m6x8,
      KEYS.inserts,
    ])
    expect(rowCount(filterGroups(all, { query: 'm6', onlyOnHand: false }))).toBe(4)
  })

  test.prop([
    fc.dictionary(fc.constantFrom(...Object.values(KEYS)), fc.integer({ min: 0, max: 500 })),
    fc.boolean(),
    fc.constantFrom('', 'm5', 'screw', 'extrusion', 'zzz'),
  ])('never invents rows, and hides nothing on hand that matches', (inventory, only, query) => {
    const all = groups(inventory)
    const shown = filterGroups(all, { query, onlyOnHand: only })
    const allKeys = new Set(all.flatMap((group) => group.rows.map((row) => row.key)))
    const shownRows = shown.flatMap((group) => group.rows)
    expect(shownRows.every((row) => allKeys.has(row.key))).toBe(true)
    if (only) expect(shownRows.every((row) => row.qty > 0)).toBe(true)
    const expected = all
      .flatMap((group) => group.rows)
      .filter((row) => row.qty > 0 && matchesQuery(row.tokens, query))
    for (const row of expected) expect(shownRows).toContainEqual(row)
  })
})

describe('naming keys like the BOM', () => {
  it('names prints, devices and power bricks as the bill of materials does', () => {
    const plan = kwsPlan({
      sections: [6],
      placements: [
        {
          id: 'pl-1',
          itemId: 'lenovo-tiny-mount',
          y: 0,
          devices: [{ id: 'dv-1', deviceId: 'lenovo-m720q', slotId: 'bay' }],
        },
      ],
      equipment: [{ id: 'eq-1', deviceId: 'rpi-5' }],
    })
    const bom = computeBom(plan, CATALOG, SETTINGS, {})
    const keys = [
      printKey(KWS_FRAME_ID, 'leg-6u'),
      printKey('lenovo-tiny-mount', 'mount'),
      deviceKey('lenovo-m720q'),
      brickKey('rpi-5'),
      KEYS.m6x10,
    ]
    for (const key of keys) {
      const line = bom.lines.find((candidate) => candidate.key === key)
      expect(line, key).toBeDefined()
      expect(keyInfo(key, CATALOG).label).toBe(line?.label)
    }
    expect(keyInfo(printKey('lenovo-tiny-mount', 'mount'), CATALOG).label).toBe(
      'Lenovo Tiny mount: Tiny mount',
    )
    expect(keyInfo(brickKey('rpi-5'), CATALOG)).toMatchObject({ kind: 'brick', unit: 'pcs' })
  })

  it('falls back to the plans’ names, then to the ids', () => {
    const lines = new Map([
      [
        'print:custom:my-mount/body',
        { label: 'My mount: Body', kind: 'print' as const, unit: 'plates' as const },
      ],
    ])
    expect(keyInfo('print:custom:my-mount/body', CATALOG, lines).label).toBe('My mount: Body')
    expect(keyInfo('print:gone/plate', CATALOG).label).toBe('gone: plate')
    expect(keyInfo('device:gone-pc', CATALOG).label).toBe('gone-pc')
    expect(keyInfo('weird', CATALOG)).toMatchObject({ kind: 'unknown', label: 'weird' })
  })
})

describe('other things on hand', () => {
  it('lists prints, equipment and bricks on hand by kind, then name', () => {
    const inventory = {
      [KEYS.inserts]: 10,
      [deviceKey('rpi-5')]: 1,
      [brickKey('rpi-5')]: 2,
      [printKey(KWS_FRAME_ID, 'plate-3u')]: 4,
      [deviceKey('lenovo-m720q')]: 1,
    }
    const rows = otherRows(inventory, CATALOG)
    expect(rows.map((row) => [row.kindLabel, row.label, row.qty])).toEqual([
      ['Printed part', '3U leg plate (4 legs)', 4],
      ['Equipment', 'Lenovo ThinkCentre M720q Tiny', 1],
      ['Equipment', 'Raspberry Pi 5', 1],
      ['Power brick', 'Power brick for Raspberry Pi 5', 2],
    ])
  })

  it('keeps a row changed to 0 on this visit', () => {
    const key = deviceKey('rpi-5')
    expect(otherRows({}, CATALOG)).toEqual([])
    expect(otherRows({}, CATALOG, undefined, new Set([key, KEYS.inserts]))).toEqual([
      { key, kind: 'device', kindLabel: 'Equipment', label: 'Raspberry Pi 5', unit: 'pcs', qty: 0 },
    ])
  })
})

describe('totals', () => {
  it('counts kinds and pieces of hardware, stock by length apart', () => {
    const totals = onHandTotals(
      {
        [KEYS.inserts]: 300,
        [KEYS.m6x8]: 40,
        [KEYS.extrusion]: 1200,
        [KEYS.cut]: 2,
        [deviceKey('rpi-5')]: 1,
      },
      CATALOG,
    )
    expect(totals).toEqual({ kinds: 4, pieces: 342, mm: 1200, other: 1 })
    expect(totalsText(totals, 'en')).toBe('4 kinds, 342 pieces, 1,200 mm of stock')
    expect(totalsText({ kinds: 1, pieces: 1, mm: 0, other: 0 }, 'en')).toBe('1 kind, 1 piece')
  })

  it('writes counts with their unit', () => {
    expect(quantityWithUnit(1, 'plates', 'en')).toBe('1 plate')
    expect(quantityWithUnit(3, 'plates', 'en')).toBe('3 plates')
    expect(quantityWithUnit(20, 'pcs', 'en')).toBe('20 pcs')
    expect(quantityWithUnit(1500, 'mm', 'en')).toBe('1,500 mm')
  })
})

describe('planNeedsFrom', () => {
  it('leaves out lines a plan already has and accessories that ship with a device', () => {
    const plan = kwsPlan({
      sections: [{ u: 3, have: true }],
      equipment: [{ id: 'eq-1', deviceId: 'lenovo-m720q' }],
    })
    const needs = planNeedsFrom([
      { planId: 'p', planName: 'P', bom: computeBom(plan, CATALOG, SETTINGS, {}) },
    ])
    expect([...needs.byKey.keys()]).toEqual([deviceKey('lenovo-m720q')])
    expect(needs.lines.get(brickKey('lenovo-m720q'))?.label).toBe(
      'Power brick for Lenovo ThinkCentre M720q Tiny',
    )
  })
})
