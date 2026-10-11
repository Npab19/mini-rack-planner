/**
 * KWS Rack v2 golden numbers on the real catalog data (catalog/frames/kws-rack-v2.json and
 * catalog/hardware). Logic tests use frozen fixtures; this is the one domain test that reads
 * catalog/, so a curation change that alters the designer's numbers or the user's shopping list
 * fails here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCatalogFromDisk, REPO_ROOT } from '../../scripts/lib/catalogFs'
import { shoppingJson } from '../../scripts/bom'
import type { BomResult } from './api'
import { computeBom, shoppingLines } from './bom'
import { hardwareKey, printKey } from './ids'
import { migratePlan } from './migrate'
import { PlanSchema, type Plan } from './schema/plan'
import { defaultSettings, type Settings } from './schema/settings'

const FRAME_ID = 'kws-rack-v2'
const AT = '2026-10-01T00:00:00.000Z'

const catalog = loadCatalogFromDisk({
  include: (path) => path === `frames/${FRAME_ID}.json` || path.startsWith('hardware/'),
})
/** No spares and an empty inventory, so quantities are exactly the designer's. */
const SETTINGS: Settings = { ...defaultSettings(), sparePct: { default: 0 } }

/** The designer table's columns: inserts / M6×8 / M6×10 / M6 nyloc / 10×5 magnets. */
const TABLE_KEYS = [
  hardwareKey('insert-m5x8x7'),
  hardwareKey('screw-m6x8-shcs'),
  hardwareKey('screw-m6x10-shcs'),
  hardwareKey('nut-m6-nyloc'),
  hardwareKey('magnet-10x5'),
]

function bom(plan: Plan): BomResult {
  return computeBom(plan, catalog.lookup, SETTINGS, {})
}

function tableRow(result: BomResult, field: 'target' | 'need'): number[] {
  return TABLE_KEYS.map((key) => result.lines.find((line) => line.key === key)?.[field] ?? 0)
}

function printsToMake(result: BomResult): Array<[string, number]> {
  return shoppingLines(result)
    .filter((line) => line.kind === 'print')
    .map((line): [string, number] => [line.refId, line.need])
}

/** A new rack: sections bottom to top, nothing built, every option at its default. */
function newRack(heights: readonly number[], options: Record<string, unknown> = {}): Plan {
  return PlanSchema.parse({
    schema: 1,
    id: 'plan-golden',
    rackId: 'rack-golden',
    name: 'Golden',
    createdAt: AT,
    updatedAt: AT,
    frame: {
      frameId: FRAME_ID,
      options,
      sections: heights.map((heightU, index) => ({
        id: `sec-${index + 1}`,
        typeId: `s${heightU}`,
      })),
    },
  })
}

function readFixture(path: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', path), 'utf8'))
}

function fixturePlan(name: string): Plan {
  return migratePlan(readFixture(`plans/${name}.json`)).plan
}

describe('KWS Rack v2 catalog data', () => {
  it('loads the frame and its hardware without errors', () => {
    expect(catalog.errors).toEqual([])
    expect(catalog.lookup.frame(FRAME_ID)?.name).toBe('KWS Rack v2')
  })

  // The designer's table assumes stacks built 6U-first (9U = 6U + 3U).
  it.each([
    { u: 3, heights: [3], row: [36, 16, 24, 40, 23] },
    { u: 6, heights: [6], row: [72, 16, 24, 40, 63] },
    { u: 9, heights: [6, 3], row: [108, 32, 48, 80, 79] },
    { u: 12, heights: [6, 6], row: [144, 32, 48, 80, 119] },
    { u: 15, heights: [6, 6, 3], row: [180, 48, 72, 120, 135] },
    { u: 18, heights: [6, 6, 6], row: [216, 48, 72, 120, 175] },
  ])('reproduces the designer row for $u U', ({ heights, row }) => {
    const result = bom(newRack(heights))
    expect(tableRow(result, 'target')).toEqual(row)
    expect(tableRow(result, 'need')).toEqual(row)
  })

  describe.each(['top', 'bottom', 'between'])('3U + 6U built, new 3U at the %s', (where) => {
    const result = bom(fixturePlan(`kws-3-6-plus3-${where}`))

    it('prints one 3U leg plate and one set of frame connectors', () => {
      expect(printsToMake(result)).toEqual([
        ['plate-3u', 1],
        ['frame-connectors', 1],
      ])
    })

    it('needs 36 inserts, 16 M6×8, 24 M6×10, 40 nyloc nuts and 16 magnets', () => {
      expect(tableRow(result, 'need')).toEqual([36, 16, 24, 40, 16])
      expect(shoppingLines(result)).toHaveLength(7)
    })

    it('counts the full [3, 6, 3] rack as 144 / 48 / 72 / 120 / 95', () => {
      expect(tableRow(result, 'target')).toEqual([144, 48, 72, 120, 95])
    })
  })

  it('counts a new [3, 3] rack per section: 72 / 32 / 48 / 80 / 39', () => {
    expect(tableRow(bom(newRack([3, 3])), 'need')).toEqual([72, 32, 48, 80, 39])
  })

  it('adds a 6U to the built 3U + 6U: 72 / 16 / 24 / 40 / 56, four legs and one connectors', () => {
    const built = fixturePlan('kws-3-6-plus3-top')
    const plan: Plan = {
      ...built,
      frame: {
        ...built.frame,
        sections: [...built.frame.sections.slice(0, 2), { id: 'sec-new-6u', typeId: 's6' }],
      },
    }
    const result = bom(plan)
    expect(tableRow(result, 'need')).toEqual([72, 16, 24, 40, 56])
    expect(printsToMake(result)).toEqual([
      ['leg-6u', 4],
      ['frame-connectors', 1],
    ])
  })

  it('builds a new 6U + 6U rack: the full row plus the once-per-rack prints', () => {
    const result = bom(fixturePlan('kws-new-6-6'))
    expect(tableRow(result, 'need')).toEqual([144, 32, 48, 80, 119])
    expect(new Map(printsToMake(result))).toEqual(
      new Map([
        ['leg-6u', 8],
        ['frame-connectors', 1],
        ['top-handle', 2],
        ['top-connectors', 2],
        ['base-legs', 2],
        ['bottom-connectors', 2],
      ]),
    )
  })

  it('follows the rack options', () => {
    const topBottom = bom(newRack([6, 6], { 'insert-policy': 'top-bottom' }))
    expect(tableRow(topBottom, 'need')[0]).toBe(96)

    const noMagnets = bom(newRack([6, 3], { magnets: false }))
    expect(tableRow(noMagnets, 'need')[4]).toBe(0)

    const flatTop = PlanSchema.parse({
      ...newRack([6]),
      frame: {
        frameId: FRAME_ID,
        caps: { top: { options: { top: 'flat' } } },
        sections: [{ id: 's', typeId: 's6' }],
      },
    })
    const prints = new Map(printsToMake(bom(flatTop)))
    expect(prints.get('top-flat')).toBe(2)
    expect(prints.has('top-handle')).toBe(false)
    const keys = bom(newRack([3], { 'high-rack': true })).lines.map((line) => line.key)
    expect(keys).toContain(printKey(FRAME_ID, 'high-rack-connector'))
  })

  it.each(['kws-3-6-plus3-top', 'kws-3-6-plus3-bottom', 'kws-3-6-plus3-between', 'kws-new-6-6'])(
    'matches fixtures/expected/%s.shopping.json',
    (name) => {
      const plan = fixturePlan(name)
      const expected = readFixture(`expected/${name}.shopping.json`)
      // On purpose changes, regenerate with:
      // npm run -s bom -- fixtures/plans/<name>.json --json --out fixtures/expected/<name>.shopping.json
      expect(shoppingJson(plan, bom(plan))).toEqual(expected)
    },
  )
})
