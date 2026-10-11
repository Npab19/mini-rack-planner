import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { hardwareKey, printKey } from './ids'
import {
  expandFrameRecipe,
  expandItemRecipe,
  frameConfigFromPlan,
  optionEffects,
  resolveOptionValues,
  sectionHeightU,
  sumByLineKey,
  type ExpandedLine,
  type FrameConfig,
  type OptionInput,
} from './recipe'
import { FrameSchema, ItemSchema, OptionSchema } from './schema/catalog'
import { PlanFrameSchema } from './schema/plan'

// A small KWS-like frame: 3U/6U sections, per-section fasteners, legs that embed inserts and
// (optionally) magnets, one connector print per joint, a top choice and 7 rack-level magnets.
const frameInput = {
  kind: 'frame',
  id: 'kws-test',
  name: 'KWS-like test frame',
  source: { platform: 'makerworld', url: 'https://makerworld.com/en/models/2139130' },
  verified: { by: 'test', date: '2026-10-11', method: 'unverified' },
  standard: { panelWidthMm: 254, innerWidthMm: 222, depthMm: 250, rearOpen: true },
  rail: { earSpacingMm: 236.525, holeOffsetsPerUMm: [6.35, 22.225, 38.1], holeTolMm: 0.5 },
  equipmentFastener: { thread: 'M5', perHole: 'screw', screwIds: ['m5x10-shcs'], engagementMm: 5 },
  sectionTypes: [
    { id: 's3', label: '3U section', heightU: 3 },
    { id: 's6', label: '6U section', heightU: 6 },
  ],
  stack: { minU: 3, maxU: 24 },
  options: [
    { id: 'magnets', label: 'Magnets', scope: 'section', kind: 'boolean', default: true },
    {
      id: 'top',
      label: 'Top',
      scope: 'top',
      kind: 'choice',
      choices: [
        { id: 'handle', label: 'Handle' },
        { id: 'flat', label: 'Flat' },
      ],
      default: 'handle',
    },
  ],
  prints: [
    {
      id: 'leg-6u',
      plate: '6U leg [Print x4]',
      label: '6U leg',
      material: 'PETG',
      gramsPerPrint: 125,
      embeds: [
        { hardwareId: 'insert-m5x8x7', perPrint: 18 },
        { hardwareId: 'magnet-10x5', perPrint: 14, when: { option: { magnets: true } } },
      ],
    },
    {
      id: 'plate-3u',
      plate: '3U legs',
      label: '3U leg plate',
      gramsPerPrint: 214,
      embeds: [
        { hardwareId: 'insert-m5x8x7', perPrint: 36 },
        { hardwareId: 'magnet-10x5', perPrint: 16, when: { option: { magnets: true } } },
      ],
    },
    { id: 'connectors', plate: 'Frame connectors', label: 'Frame connectors', gramsPerPrint: 68 },
    { id: 'top-handle', plate: 'Top handle', label: 'Top handle' },
    { id: 'top-flat', plate: 'Flat top', label: 'Flat top' },
  ],
  recipe: [
    { id: 'legs-6u', unit: 'section', ref: { print: 'leg-6u' }, count: { perSection: { s6: 4 } } },
    {
      id: 'legs-3u',
      unit: 'section',
      ref: { print: 'plate-3u' },
      count: { perSection: { s3: 1 } },
    },
    { id: 'm6x8', unit: 'section', ref: { hardware: 'm6x8-shcs' }, count: 16 },
    { id: 'm6x10', unit: 'section', ref: { hardware: 'm6x10-shcs' }, count: 24 },
    { id: 'nyloc', unit: 'section', ref: { hardware: 'm6-nyloc' }, count: 40 },
    { id: 'connectors', unit: 'joint', ref: { print: 'connectors' }, count: 1 },
    {
      id: 'top-handle',
      unit: 'top',
      ref: { print: 'top-handle' },
      count: 2,
      when: { option: { top: 'handle' } },
    },
    {
      id: 'top-flat',
      unit: 'top',
      ref: { print: 'top-flat' },
      count: 2,
      when: { not: { option: { top: 'handle' } } },
    },
    {
      id: 'rack-magnets',
      unit: 'rack',
      ref: { hardware: 'magnet-10x5' },
      count: 7,
      when: { option: { magnets: true } },
    },
  ],
}
const FRAME = FrameSchema.parse(frameInput)

const INSERTS = hardwareKey('insert-m5x8x7')
const MAGNETS = hardwareKey('magnet-10x5')
const M6X8 = hardwareKey('m6x8-shcs')
const M6X10 = hardwareKey('m6x10-shcs')
const NYLOC = hardwareKey('m6-nyloc')
const LEG_6U = printKey('kws-test', 'leg-6u')
const PLATE_3U = printKey('kws-test', 'plate-3u')
const CONNECTORS = printKey('kws-test', 'connectors')
const TOP_HANDLE = printKey('kws-test', 'top-handle')
const TOP_FLAT = printKey('kws-test', 'top-flat')

/** Stack of the given section heights (bottom -> top), caps present. */
function stack(
  heights: readonly number[],
  sectionOptions: Readonly<Record<number, OptionInput>> = {},
  patch: Partial<FrameConfig> = {},
): FrameConfig {
  return {
    sections: heights.map((heightU, index) => ({
      id: `sec-${index + 1}`,
      typeId: `s${heightU}`,
      heightU,
      options: sectionOptions[index] ?? {},
    })),
    rackOptions: {},
    top: { present: heights.length > 0, options: {} },
    bottom: { present: heights.length > 0, options: {} },
    ...patch,
  }
}

function totals(config: FrameConfig): Map<string, number> {
  return sumByLineKey(expandFrameRecipe(FRAME, config))
}

/** inserts / M6×8 / M6×10 / nyloc / magnets, the designer table's columns. */
function hardwareRow(lines: Map<string, number>): number[] {
  return [INSERTS, M6X8, M6X10, NYLOC, MAGNETS].map((key) => lines.get(key) ?? 0)
}

describe('expandFrameRecipe on a KWS-like frame', () => {
  it('expands [6, 3]', () => {
    const lines = totals(stack([6, 3]))
    expect(lines.get(INSERTS)).toBe(108)
    expect(lines.get(MAGNETS)).toBe(79)
    expect(lines.get(M6X8)).toBe(32)
    expect(lines.get(CONNECTORS)).toBe(1)
    expect(lines.get(LEG_6U)).toBe(4)
    expect(lines.get(PLATE_3U)).toBe(1)
    expect(lines.get(TOP_HANDLE)).toBe(2)
    expect(lines.has(TOP_FLAT)).toBe(false)
  })

  it('expands [3, 6, 3]', () => {
    const lines = totals(stack([3, 6, 3]))
    expect(hardwareRow(lines)).toEqual([144, 48, 72, 120, 95])
    expect(lines.get(CONNECTORS)).toBe(2)
    expect(lines.get(PLATE_3U)).toBe(2)
    expect(lines.get(LEG_6U)).toBe(4)
  })

  it('expands [3, 3]', () => {
    expect(hardwareRow(totals(stack([3, 3])))).toEqual([72, 32, 48, 80, 39])
  })

  it('adds 36/16/24/40/16 for one more 3U at the top or the bottom', () => {
    const before = hardwareRow(totals(stack([3, 6])))
    for (const after of [stack([3, 6, 3]), stack([3, 3, 6])]) {
      const row = hardwareRow(totals(after))
      expect(row.map((value, index) => value - (before[index] ?? 0))).toEqual([36, 16, 24, 40, 16])
    }
  })

  it('aggregates the same print across sections under one key', () => {
    const lines = expandFrameRecipe(FRAME, stack([6, 6]))
    const legs = lines.filter((line) => line.lineKey === LEG_6U)
    expect(legs).toHaveLength(2)
    expect(sumByLineKey(lines).get(LEG_6U)).toBe(8)
  })

  it('honours a section-scoped option on one section', () => {
    const lines = totals(stack([6, 3], { 0: { magnets: false } }))
    expect(lines.get(MAGNETS)).toBe(7 + 16)
    expect(lines.get(INSERTS)).toBe(108)
  })

  it('lets a rack-wide value switch a section option off, with per-section overrides on top', () => {
    expect(totals(stack([6, 3], {}, { rackOptions: { magnets: false } })).has(MAGNETS)).toBe(false)
    const oneOn = totals(
      stack([6, 3], { 1: { magnets: true } }, { rackOptions: { magnets: false } }),
    )
    expect(oneOn.get(MAGNETS)).toBe(16)
  })

  it('switches the top choice', () => {
    const flat = totals(stack([6, 3], {}, { top: { present: true, options: { top: 'flat' } } }))
    expect(flat.get(TOP_FLAT)).toBe(2)
    expect(flat.has(TOP_HANDLE)).toBe(false)
  })

  it('falls back to defaults for invalid option values', () => {
    const lines = totals(
      stack([6], { 0: { magnets: 'yes' } }, { top: { present: true, options: { top: 'nope' } } }),
    )
    expect(lines.get(TOP_HANDLE)).toBe(2)
    expect(lines.get(MAGNETS)).toBe(7 + 56)
  })

  it('skips caps that are not present and returns nothing for an empty stack', () => {
    const noTop = totals(stack([6], {}, { top: { present: false, options: {} } }))
    expect(noTop.has(TOP_HANDLE)).toBe(false)
    expect(noTop.get(MAGNETS)).toBe(63)
    expect(expandFrameRecipe(FRAME, stack([]))).toEqual([])
  })

  it('marks embedded hardware as non-reusable and links it to its print', () => {
    const lines = expandFrameRecipe(FRAME, stack([6]))
    const inserts = lines.find((line) => line.lineKey === INSERTS)
    expect(inserts).toMatchObject({
      kind: 'hardware',
      refId: 'insert-m5x8x7',
      qty: 72,
      unit: 'section',
      role: 'embedded',
      reusable: false,
      ownerId: 'kws-test',
      recipeLineId: 'legs-6u',
      embeddedIn: { printKey: LEG_6U, printId: 'leg-6u', perPrint: 18 },
    })
    const screws = lines.find((line) => line.lineKey === M6X8)
    expect(screws).toMatchObject({ role: 'assembly', reusable: true, unit: 'section' })
    const legs = lines.find((line) => line.lineKey === LEG_6U)
    expect(legs).toMatchObject({ kind: 'print', refId: 'leg-6u', role: 'assembly', reusable: true })
  })

  it('records where each quantity comes from', () => {
    const lines = expandFrameRecipe(FRAME, stack([3, 6]))
    const provenance = (key: string): ExpandedLine['provenance'] =>
      lines.filter((line) => line.lineKey === key).flatMap((line) => line.provenance)
    expect(provenance(INSERTS)).toEqual([
      {
        unitLabel: 'Section 2 (6U)',
        unitId: 'sec-2',
        detail: 'embedded in 6U leg: 18 per print × 4',
        qty: 72,
      },
      {
        unitLabel: 'Section 1 (3U)',
        unitId: 'sec-1',
        detail: 'embedded in 3U leg plate: 36 per print × 1',
        qty: 36,
      },
    ])
    expect(provenance(CONNECTORS)).toEqual([
      { unitLabel: 'Joint 1 (3U / 6U)', unitId: 'sec-1/sec-2', detail: '1 per joint', qty: 1 },
    ])
    expect(provenance(M6X8)[0]).toMatchObject({
      unitLabel: 'Section 1 (3U)',
      detail: '16 per section',
    })
    expect(provenance(LEG_6U)[0]?.detail).toBe('4 per 6U section')
    expect(provenance(MAGNETS).find((entry) => entry.unitLabel === 'Rack')?.qty).toBe(7)
    expect(provenance(TOP_HANDLE)[0]).toMatchObject({ unitLabel: 'Top', unitId: 'top', qty: 2 })
  })

  test.prop([fc.array(fc.constantFrom(3, 6), { minLength: 1, maxLength: 8 })])(
    'follows the designer formulas for any stack of 3U/6U sections',
    (heights) => {
      const lines = totals(stack(heights))
      const n3 = heights.filter((height) => height === 3).length
      const n6 = heights.length - n3
      const u = 3 * n3 + 6 * n6
      expect(lines.get(INSERTS)).toBe(12 * u)
      expect(lines.get(MAGNETS)).toBe(7 + 16 * n3 + 56 * n6)
      expect(lines.get(M6X8)).toBe(16 * heights.length)
      expect(lines.get(CONNECTORS) ?? 0).toBe(heights.length - 1)
      expect(lines.get(LEG_6U) ?? 0).toBe(4 * n6)
      expect(lines.get(PLATE_3U) ?? 0).toBe(n3)
      for (const line of expandFrameRecipe(FRAME, stack(heights)))
        expect(line.qty).toBeGreaterThan(0)
    },
  )
})

describe('expandFrameRecipe: joints, stack conditions and cut lengths', () => {
  const variant = FrameSchema.parse({
    ...frameInput,
    recipe: [
      {
        id: 'joint-bolts',
        unit: 'joint',
        ref: { hardware: 'm6x30-shcs' },
        count: { base: 4, jointFilter: { notAdjacentTo: ['s3'] } },
      },
      {
        id: 'tall-brace',
        unit: 'rack',
        ref: { hardware: 'brace' },
        count: 2,
        when: { stack: { minU: 12, topTypeId: 's3' } },
      },
      {
        id: 'rails',
        unit: 'section',
        ref: { hardware: 'extrusion-2020' },
        count: 4,
        length: { base: -2, perU: 44.45 },
      },
    ],
  })

  it('applies the joint filter per adjacent pair', () => {
    const lines = sumByLineKey(expandFrameRecipe(variant, stack([6, 6, 3])))
    expect(lines.get(hardwareKey('m6x30-shcs'))).toBe(4)
  })

  it('evaluates stack conditions against the whole stack', () => {
    const tall = sumByLineKey(expandFrameRecipe(variant, stack([6, 3, 3])))
    expect(tall.get(hardwareKey('brace'))).toBe(2)
    const short = sumByLineKey(expandFrameRecipe(variant, stack([6, 3])))
    expect(short.has(hardwareKey('brace'))).toBe(false)
  })

  it('keys cut-to-length hardware per rounded cut length', () => {
    const lines = expandFrameRecipe(variant, stack([3, 6, 3]))
    const rails = lines.filter((line) => line.refId === 'extrusion-2020')
    expect(rails.map((line) => line.cutLengthMm)).toEqual([131.35, 264.7, 131.35])
    const byKey = sumByLineKey(rails)
    expect(byKey.get(hardwareKey('extrusion-2020', 131.35))).toBe(8)
    expect(byKey.get(hardwareKey('extrusion-2020', 264.7))).toBe(4)
  })
})

describe('expandItemRecipe', () => {
  const item = ItemSchema.parse({
    kind: 'item',
    id: 'mini-pc-shelf',
    name: 'Mini PC shelf',
    category: 'shelf',
    source: { platform: 'printables', url: 'https://www.printables.com/model/1' },
    verified: { by: 'test', date: '2026-10-11', method: 'unverified' },
    heightSixths: 12,
    depthMm: 200,
    mount: { front: 4 },
    options: [
      { id: 'inserts', label: 'Heat-set inserts', scope: 'item', kind: 'boolean', default: false },
    ],
    prints: [
      {
        id: 'shelf',
        plate: 'Shelf',
        label: 'Shelf',
        embeds: [{ hardwareId: 'insert-m3', perPrint: 4, when: { option: { inserts: true } } }],
      },
    ],
    recipe: [
      { id: 'shelf', unit: 'item', ref: { print: 'shelf' }, count: 1 },
      { id: 'screws', unit: 'item', ref: { hardware: 'm3x8-bhcs' }, count: { perU: 2 } },
      { id: 'ears', unit: 'item', ref: { hardware: 'm5x10-shcs' }, count: 4, role: 'rack-mount' },
    ],
  })

  it('expands item lines with defaults', () => {
    const lines = expandItemRecipe(item, {}, 'pl-1')
    const byKey = sumByLineKey(lines)
    expect(byKey.get(printKey('mini-pc-shelf', 'shelf'))).toBe(1)
    expect(byKey.get(hardwareKey('m3x8-bhcs'))).toBe(4)
    expect(byKey.has(hardwareKey('insert-m3'))).toBe(false)
    const ears = lines.find((line) => line.refId === 'm5x10-shcs')
    expect(ears).toMatchObject({ role: 'rack-mount', unit: 'item', ownerId: 'mini-pc-shelf' })
    expect(ears?.provenance[0]).toMatchObject({
      unitLabel: 'Mini PC shelf',
      unitId: 'pl-1',
      detail: '4 per item',
    })
  })

  it('applies item options to embeds', () => {
    const lines = expandItemRecipe(item, { inserts: true }, 'pl-2')
    const inserts = lines.find((line) => line.refId === 'insert-m3')
    expect(inserts).toMatchObject({ qty: 4, role: 'embedded', reusable: false, unit: 'item' })
  })

  it('keys prints by item id so placements aggregate', () => {
    const lines = [...expandItemRecipe(item, {}, 'pl-1'), ...expandItemRecipe(item, {}, 'pl-2')]
    expect(sumByLineKey(lines).get(printKey('mini-pc-shelf', 'shelf'))).toBe(2)
  })
})

describe('options', () => {
  const options = [
    OptionSchema.parse({
      id: 'magnets',
      label: 'Magnets',
      scope: 'section',
      kind: 'boolean',
      default: true,
    }),
    OptionSchema.parse({
      id: 'deep',
      label: '320 mm connectors',
      scope: 'rack',
      kind: 'boolean',
      default: false,
      effects: { depthMm: 320 },
    }),
    OptionSchema.parse({
      id: 'width',
      label: 'Width',
      scope: 'rack',
      kind: 'choice',
      choices: [
        { id: 'standard', label: 'Standard' },
        { id: 'wide', label: 'Wide', effects: { innerWidthMm: 230 } },
      ],
      default: 'standard',
    }),
  ]

  it('layers defaults, rack values and unit values', () => {
    expect(resolveOptionValues(options)).toEqual({ magnets: true, deep: false, width: 'standard' })
    expect(resolveOptionValues(options, { magnets: false }, { magnets: true })).toMatchObject({
      magnets: true,
    })
    expect(resolveOptionValues(options, { width: 'wide', unknown: 1 })).toEqual({
      magnets: true,
      deep: false,
      width: 'wide',
    })
    expect(resolveOptionValues(options, { width: 'huge', deep: 'yes' })).toMatchObject({
      deep: false,
      width: 'standard',
    })
  })

  it('collects geometry effects of active options', () => {
    expect(optionEffects(options)).toEqual({})
    expect(optionEffects(options, { deep: true, width: 'wide' })).toEqual({
      depthMm: 320,
      innerWidthMm: 230,
    })
  })
})

describe('frameConfigFromPlan', () => {
  it('builds the target configuration from the plan frame', () => {
    const planFrame = PlanFrameSchema.parse({
      frameId: 'kws-test',
      options: { magnets: false },
      caps: { top: { options: { top: 'flat' } } },
      sections: [
        { id: 'sec-a', typeId: 's3' },
        { id: 'sec-b', typeId: 's6', options: { magnets: true } },
      ],
    })
    const config = frameConfigFromPlan(planFrame, FRAME)
    expect(config.sections.map((section) => section.heightU)).toEqual([3, 6])
    expect(config.top).toEqual({ present: true, options: { top: 'flat' } })
    expect(config.bottom).toEqual({ present: true, options: {} })
    const lines = totals(config)
    expect(lines.get(MAGNETS)).toBe(56)
    expect(lines.get(TOP_FLAT)).toBe(2)
  })

  it('reads section heights from types, ranges and overrides', () => {
    const ranged = FrameSchema.parse({
      ...frameInput,
      sectionTypes: [{ id: 'any', label: 'Any height', heightU: { min: 2, max: 12 } }],
      recipe: [],
    })
    expect(sectionHeightU(FRAME, 's6')).toBe(6)
    expect(sectionHeightU(ranged, 'any')).toBe(2)
    expect(sectionHeightU(ranged, 'any', 9)).toBe(9)
    expect(sectionHeightU(FRAME, 'unknown')).toBe(0)
  })
})
