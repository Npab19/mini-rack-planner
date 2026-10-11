import { describe, expect, it } from 'vitest'
import type { BomLine, BomResult } from '@/domain/api'
import { computeBom } from '@/domain/bom'
import { deviceKey, hardwareKey, printKey } from '@/domain/ids'
import { HardwareSchema, type CatalogLookup } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import { defaultSettings, type Inventory, type Settings } from '@/domain/schema/settings'
import { finishBuild } from '@/domain/build'
import { markSection } from '@/domain/frame'
import {
  FIXTURE_NOW,
  KWS_FRAME,
  KWS_FRAME_ID,
  KWS_IDS,
  kwsCatalog,
  kwsPlan,
} from '@/domain/__fixtures__/kws'
import {
  bomCsvFileName,
  bomSummary,
  buyText,
  formatCost,
  formatDuration,
  formatHours,
  formatPacks,
  gotItAddQty,
  gotItRemoveQty,
  groupByKind,
  isBomTab,
  isGotIt,
  linePacks,
  linesForTab,
  neededText,
  finishBuildChanges,
  pendingCount,
  printPlate,
  provenanceView,
  quantityText,
  shoppingRows,
  summaryText,
  toGetCount,
} from './bomView'

const NO_SPARES: Settings = { ...defaultSettings(), sparePct: { default: 0 } }
const CATALOG = kwsCatalog()
const KEYS = {
  inserts: hardwareKey(KWS_IDS.inserts),
  magnets: hardwareKey(KWS_IDS.magnets),
  m6x8: hardwareKey(KWS_IDS.m6x8),
  plate3: printKey(KWS_FRAME_ID, 'plate-3u'),
  connectors: printKey(KWS_FRAME_ID, 'frame-connectors'),
}

/** 3U + 6U built, one 3U to add on top. */
function userPlan(): Plan {
  return kwsPlan({ sections: [{ u: 3, have: true }, { u: 6, have: true }, 3] })
}

function bom(
  plan: Plan,
  settings: Settings = NO_SPARES,
  inventory: Inventory = {},
  catalog: CatalogLookup = CATALOG,
): BomResult {
  return computeBom(plan, catalog, settings, inventory)
}

function line(result: BomResult, key: string): BomLine {
  const found = result.lines.find((candidate) => candidate.key === key)
  if (found === undefined) throw new Error(`no line ${key}`)
  return found
}

describe('lines per tab', () => {
  it('lists the golden +3U shopping list in print, hardware, equipment order', () => {
    const result = bom(userPlan())
    const groups = groupByKind(linesForTab(result, 'shopping'))
    expect(groups.map((group) => [group.kind, group.lines.map((l) => [l.label, l.need])])).toEqual([
      [
        'print',
        [
          ['3U leg plate (4 legs)', 1],
          ['Frame connectors', 1],
        ],
      ],
      [
        'hardware',
        [
          ['M5 heat-set insert (M5x8x7)', 36],
          ['M6 nyloc nut', 40],
          ['M6×10 socket head cap screw', 24],
          ['M6×8 socket head cap screw', 16],
          ['Round neodymium magnet 10×5 mm', 16],
        ],
      ],
    ])
    expect(toGetCount(result)).toBe(7)
    expect(linesForTab(result, 'full').length).toBe(result.lines.length)
    expect(linesForTab(result, 'leftovers')).toEqual([])
  })

  it('keeps lines covered by spares on the shopping list as Got it', () => {
    const result = bom(userPlan(), NO_SPARES, { [KEYS.inserts]: 36, [KEYS.plate3]: 1 })
    expect(isGotIt(line(result, KEYS.inserts))).toBe(true)
    expect(isGotIt(line(result, KEYS.plate3))).toBe(true)
    expect(isGotIt(line(result, KEYS.m6x8))).toBe(false)
    expect(shoppingRows(result).map((l) => l.key)).toContain(KEYS.inserts)
    // Covered lines are not "to get".
    expect(toGetCount(result)).toBe(5)
  })

  it('never offers Got it for lines with nothing to install or included accessories', () => {
    const plan = kwsPlan({ sections: [6], equipment: [{ id: 'eq-1', deviceId: 'lenovo-m720q' }] })
    const result = bom(plan)
    const brick = result.lines.find((l) => l.included === true)
    expect(brick).toBeDefined()
    expect(isGotIt(brick as BomLine)).toBe(false)
    expect(shoppingRows(result).some((l) => l.included === true)).toBe(false)
    expect(shoppingRows(result).map((l) => l.key)).toContain(deviceKey('lenovo-m720q'))
  })

  it('lists surplus on the Leftovers tab', () => {
    const plan = kwsPlan({
      sections: [
        { u: 3, have: true },
        { u: 6, have: true },
      ],
      top: { options: { top: 'flat' }, builtOptions: { top: 'handle' } },
    })
    const groups = groupByKind(linesForTab(bom(plan), 'leftovers'))
    expect(groups.map((group) => group.lines.map((l) => [l.label, l.surplus]))).toEqual([
      [['Top frame handle', 2]],
    ])
  })

  it('recognises the tab ids', () => {
    expect(isBomTab('shopping')).toBe(true)
    expect(isBomTab('leftovers')).toBe(true)
    expect(isBomTab('surplus')).toBe(false)
    expect(isBomTab(1)).toBe(false)
  })
})

describe('Got it quantities', () => {
  it('adds what is still missing, spares included, so a second cycle starts clean', () => {
    const result = bom(userPlan(), defaultSettings())
    const inserts = line(result, KEYS.inserts)
    expect([inserts.install, inserts.spare, inserts.need]).toEqual([36, 4, 40])
    expect(gotItAddQty(inserts)).toBe(40)
    const covered = line(bom(userPlan(), defaultSettings(), { [KEYS.inserts]: 40 }), KEYS.inserts)
    expect(isGotIt(covered)).toBe(true)
    // Unticking takes back what ticking added, never more than is there.
    expect(gotItRemoveQty(covered, 40)).toBe(40)
    expect(gotItRemoveQty(covered, 100)).toBe(40)
    expect(gotItRemoveQty(covered, 10)).toBe(10)
  })

  it('tops up a partial stock to exactly install + spare', () => {
    const inserts = line(bom(userPlan(), defaultSettings(), { [KEYS.inserts]: 15 }), KEYS.inserts)
    expect(inserts.need).toBe(25)
    expect(15 + gotItAddQty(inserts)).toBe(inserts.install + inserts.spare)
  })
})

describe('quantities as text', () => {
  it('shows spares apart and packs in Buy', () => {
    const packed = kwsCatalog([
      HardwareSchema.parse({
        kind: 'hardware',
        id: KWS_IDS.inserts,
        name: 'M5 heat-set insert (M5x8x7)',
        category: 'insert',
        packSizes: [25, 50, 100],
      }),
    ])
    const settings = defaultSettings()
    const inserts = line(bom(userPlan(), settings, {}, packed), KEYS.inserts)
    expect(neededText(inserts)).toBe('36 + 4 spare')
    const packs = linePacks(inserts, packed, settings)
    expect(packs).toEqual([{ size: 50, count: 1 }])
    expect(buyText(inserts, packs)).toBe('50 (1 pack of 50)')

    const plain = line(bom(userPlan()), KEYS.m6x8)
    expect(neededText(plain)).toBe('16')
    expect(buyText(plain, linePacks(plain, CATALOG, NO_SPARES))).toBe('16')
  })

  it('formats packs, counts, grams, durations, hours and money', () => {
    expect(
      formatPacks([
        { size: 50, count: 2 },
        { size: 25, count: 1 },
      ]),
    ).toBe('2 packs of 50 + 1 pack of 25')
    expect(quantityText(1, 'plates')).toBe('1 plate')
    expect(quantityText(4, 'plates')).toBe('4 plates')
    expect(quantityText(36, 'pcs')).toBe('36 pcs')
    expect(quantityText(400, 'mm')).toBe('400 mm')
    expect(formatDuration(528)).toBe('8 h 48 min')
    expect(formatDuration(0)).toBe('0 min')
    expect(formatHours(528, 'en')).toBe('8.8 h')
    expect(formatHours(708, 'en')).toBe('12 h')
    expect(formatCost(4.7, 'USD', 'en-US')).toBe('$4.70')
    expect(formatCost(142.5, 'EUR', 'en-US')).toBe('€143')
    expect(formatCost(3, 'not a currency', 'en-US')).toBe('3.00 not a currency')
  })

  it('summarises what to get for the header chip', () => {
    const result = bom(userPlan())
    const summary = bomSummary(result, NO_SPARES, 'en-US')
    expect(summary).toMatchObject({ lines: 7, grams: 282, minutes: 708 })
    // 282 g of PETG at 22/kg.
    expect(summary.cost).toBe('$6.20')
    expect(summaryText(summary, 'en-US')).toBe('To get: 7 lines · ~$6.20 · 282 g · 12 h')
    const nothing = bomSummary(bom(kwsPlan({ sections: [{ u: 3, have: true }] })), NO_SPARES)
    expect(summaryText(nothing)).toBe('Nothing to get')
  })

  it('splits provenance into the plan, your rack and notes', () => {
    const view = provenanceView(line(bom(userPlan()), KEYS.inserts))
    const byLabel = (entries: ReadonlyArray<{ label: string; qty: number }>) =>
      entries.map((entry) => [entry.label, entry.qty]).toSorted()
    expect(byLabel(view.planned)).toEqual([
      ['3U section #1', 36],
      ['3U section #3', 36],
      ['6U section #2', 72],
    ])
    expect(byLabel(view.owned)).toEqual([
      ['3U section #1', 36],
      ['6U section #2', 72],
    ])
    expect(view.owned.every((entry) => !entry.detail?.startsWith('Owned: '))).toBe(true)
    expect(view.notes.map((entry) => entry.label)).toEqual(['Designer table'])
  })
})

/**
 * Have sections captured the way the wizard and the editor capture them (`markSection`: rack and
 * section options). The fixture's own snapshots also hold the cap options, which `finishBuild`
 * would re-capture.
 */
function recorded(plan: Plan): Plan {
  let next = plan
  for (const section of plan.frame.sections) {
    if (section.have !== undefined) {
      next = markSection(next, section.id, true, FIXTURE_NOW, KWS_FRAME).plan
    }
  }
  return next
}

describe('finishBuildChanges', () => {
  function changes(input: Plan) {
    const plan = recorded(input)
    const after = finishBuild(plan, KWS_FRAME, FIXTURE_NOW, CATALOG)
    const groups = finishBuildChanges(plan, after.plan, KWS_FRAME, CATALOG)
    // The dialog lists exactly what finishBuild changes.
    expect(pendingCount(groups)).toBe(after.changed)
    return groups.map((group) => [
      group.id,
      group.items.map((item) => (item.rebuilt ? `${item.label} (rebuilt)` : item.label)),
    ])
  }

  it('lists what Finish build turns into In my rack', () => {
    const plan = kwsPlan({
      sections: [{ u: 3, have: true }, { u: 6, have: true }, 3],
      placements: [
        {
          id: 'pl-tiny',
          itemId: 'lenovo-tiny-mount',
          y: 18,
          have: { at: FIXTURE_NOW, itemId: 'lenovo-tiny-mount' },
          devices: [{ id: 'dv-1', deviceId: 'lenovo-m720q', slotId: 'bay', have: false }],
        },
        { id: 'pl-blank', itemId: 'blank-1u', y: 54 },
      ],
      equipment: [
        { id: 'eq-1', deviceId: 'nas-2bay' },
        { id: 'eq-2', deviceId: 'rpi-5', have: true },
      ],
      extras: [{ id: 'ex-1', itemId: 'rubber-feet', qty: 4, haveQty: 1 }],
    })
    expect(changes(plan)).toEqual([
      ['sections', ['Section 3 (3U)']],
      ['placements', ['1U blank @U10']],
      ['devices', ['Lenovo ThinkCentre M720q Tiny in Lenovo Tiny mount @U4']],
      ['equipment', ['Fixture 2-bay NAS']],
      ['extras', ['Rubber feet × 3']],
    ])
  })

  it('includes uncaptured caps and owned parts planned differently since', () => {
    const uncaptured = kwsPlan({ sections: [3], top: { have: false }, bottom: { have: false } })
    expect(changes(uncaptured)).toEqual([
      ['sections', ['Section 1 (3U)']],
      ['caps', ['Bottom', 'Top']],
    ])
    const switchedTop = kwsPlan({
      sections: [{ u: 3, have: true }],
      top: { options: { top: 'flat' }, builtOptions: { top: 'handle' } },
    })
    expect(changes(switchedTop)).toEqual([['caps', ['Top (rebuilt)']]])
  })

  it('lists nothing once everything is owned', () => {
    expect(changes(kwsPlan({ sections: [{ u: 3, have: true }] }))).toEqual([])
    expect(changes(kwsPlan())).toEqual([])
  })
})

describe('printPlate', () => {
  it('names the designer plate when it differs from the line label', () => {
    const result = bom(userPlan())
    expect(printPlate(line(result, KEYS.plate3), CATALOG)).toBe('[Optional] - Magnetic frame - 3U')
    expect(printPlate(line(result, KEYS.connectors), CATALOG)).toBeUndefined()
    expect(printPlate(line(result, KEYS.inserts), CATALOG)).toBeUndefined()
  })
})

describe('bomCsvFileName', () => {
  it('names the file after the plan, the list and the local date', () => {
    const date = new Date(2026, 9, 11, 23, 30)
    expect(bomCsvFileName('KWS 9U → 12U', 'shopping', date)).toBe(
      'kws-9u-12u-shopping-list-2026-10-11.csv',
    )
    expect(bomCsvFileName('Garage', 'full', date)).toBe('garage-bom-2026-10-11.csv')
  })
})
