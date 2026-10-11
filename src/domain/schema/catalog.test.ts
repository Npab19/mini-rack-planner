import { describe, expect, it } from 'vitest'
import {
  CatalogEntrySchema,
  catalogBundle,
  createCatalogLookup,
  defaultMountHoles,
  DeviceSchema,
  FrameSchema,
  HardwareSchema,
  isValidOptionValue,
  ItemSchema,
  optionDefault,
  OptionSchema,
  RecipeLineSchema,
  withCustomEntries,
  type CatalogEntry,
} from './catalog'
import {
  ConditionSchema,
  IdSchema,
  KeySchema,
  QtySchema,
  SourceSchema,
  VerifiedSchema,
} from './common'

const verified = { by: 'test', date: '2026-10-11', method: 'unverified' }

const minimalFrame = {
  kind: 'frame',
  id: 'generic-10',
  name: 'Generic 10" rack',
  source: { platform: 'other', url: 'https://example.com/rack' },
  verified,
  standard: { panelWidthMm: 254, innerWidthMm: 222.25, depthMm: 200, rearOpen: false },
  rail: { earSpacingMm: 236.525, holeOffsetsPerUMm: [6.35, 22.225, 38.1], holeTolMm: 0.3 },
  equipmentFastener: {
    thread: 'M6',
    perHole: 'screw+cage-nut',
    screwIds: ['m6x12-shcs'],
    engagementMm: 4,
  },
  sectionTypes: [{ id: 'body', label: 'Rack body', heightU: { min: 1, max: 20 } }],
  stack: { minU: 1, maxU: 20 },
}

const minimalItem = {
  kind: 'item',
  id: 'blank-1u',
  name: 'Blank panel 1U',
  category: 'panel',
  source: { platform: 'printables', url: 'https://www.printables.com/model/2' },
  verified,
  heightSixths: 6,
  depthMm: 3,
  mount: { front: 4 },
}

describe('ids', () => {
  it('accepts kebab-case ids with an optional custom: prefix', () => {
    for (const id of ['kws-v2', 'm6x8-shcs', '3u', 'custom:my-mount']) {
      expect(IdSchema.safeParse(id).success).toBe(true)
    }
  })

  it('rejects anything else', () => {
    for (const id of [
      '',
      'KWS',
      'a_b',
      '-a',
      'a-',
      'a--b',
      'custom:',
      'custom:A',
      'mine:x',
      'a b',
      'a/b',
    ]) {
      expect(IdSchema.safeParse(id).success).toBe(false)
    }
    expect(KeySchema.safeParse('custom:x').success).toBe(false)
  })
})

describe('source and verification', () => {
  it('accepts http(s) links', () => {
    const source = SourceSchema.parse({
      platform: 'makerworld',
      url: 'https://makerworld.com/en/models/2139130',
      modelId: '2139130',
      license: 'Standard Digital File License',
    })
    expect(source.license).toBe('Standard Digital File License')
  })

  it('rejects script and data URLs', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://example.com/x',
      'not a url',
    ]) {
      expect(SourceSchema.safeParse({ platform: 'other', url }).success).toBe(false)
    }
  })

  it('needs a YYYY-MM-DD date', () => {
    expect(VerifiedSchema.safeParse(verified).success).toBe(true)
    expect(VerifiedSchema.safeParse({ ...verified, date: '11/10/2026' }).success).toBe(false)
    expect(VerifiedSchema.safeParse({ ...verified, method: 'guess' }).success).toBe(false)
  })
})

describe('quantities and conditions', () => {
  it('accepts numbers and formulas, rejects negatives and unknown terms', () => {
    expect(QtySchema.safeParse(16).success).toBe(true)
    expect(QtySchema.safeParse({ base: 7, perSection: { s6: 56 }, perJoint: 1 }).success).toBe(true)
    expect(QtySchema.safeParse(-1).success).toBe(false)
    expect(QtySchema.safeParse({ perU: -2 }).success).toBe(false)
    expect(QtySchema.safeParse({ perUnit: 2 }).success).toBe(false)
    expect(QtySchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false)
  })

  it('parses nested conditions', () => {
    const condition = {
      all: [
        { option: { magnets: true, top: ['handle', 'flat'] } },
        { not: { stack: { minU: 12, topTypeId: 's3' } } },
        { any: [] },
      ],
    }
    expect(ConditionSchema.parse(condition)).toEqual(condition)
  })

  it('rejects conditions with more than one key or unknown keys', () => {
    expect(ConditionSchema.safeParse({ option: { a: true }, stack: { minU: 1 } }).success).toBe(
      false,
    )
    expect(ConditionSchema.safeParse({ none: [] }).success).toBe(false)
    expect(ConditionSchema.safeParse({ stack: { minHeight: 3 } }).success).toBe(false)
  })
})

describe('options', () => {
  it('requires a default that fits the kind', () => {
    const base = { id: 'top', label: 'Top', scope: 'top' }
    expect(OptionSchema.safeParse({ ...base, kind: 'boolean', default: true }).success).toBe(true)
    expect(OptionSchema.safeParse({ ...base, kind: 'boolean', default: 'yes' }).success).toBe(false)
    const choices = [
      { id: 'handle', label: 'Handle' },
      { id: 'flat', label: 'Flat' },
    ]
    expect(
      OptionSchema.safeParse({ ...base, kind: 'choice', choices, default: 'flat' }).success,
    ).toBe(true)
    expect(
      OptionSchema.safeParse({ ...base, kind: 'choice', choices, default: 'fan' }).success,
    ).toBe(false)
    expect(OptionSchema.safeParse({ ...base, kind: 'choice', default: 'flat' }).success).toBe(false)
  })

  it('validates values and defaults', () => {
    const option = OptionSchema.parse({
      id: 'top',
      label: 'Top',
      scope: 'top',
      kind: 'choice',
      choices: [{ id: 'handle', label: 'Handle' }],
      default: 'handle',
    })
    expect(isValidOptionValue(option, 'handle')).toBe(true)
    expect(isValidOptionValue(option, 'flat')).toBe(false)
    expect(isValidOptionValue(option, true)).toBe(false)
    expect(optionDefault(option)).toBe('handle')
    expect(optionDefault({ ...option, default: 'gone' })).toBe('handle')
  })
})

describe('recipe lines', () => {
  it('defaults the role to assembly and checks references', () => {
    const line = RecipeLineSchema.parse({
      id: 'm6x8',
      unit: 'section',
      ref: { hardware: 'm6x8-shcs' },
      count: 16,
    })
    expect(line.role).toBe('assembly')
    expect(
      RecipeLineSchema.safeParse({ ...line, ref: { print: 'a', hardware: 'b' } }).success,
    ).toBe(false)
    expect(RecipeLineSchema.safeParse({ ...line, unit: 'u' }).success).toBe(false)
  })
})

describe('catalog entries', () => {
  it('parses a frame with defaults', () => {
    const frame = FrameSchema.parse(minimalFrame)
    expect(frame.options).toEqual([])
    expect(frame.prints).toEqual([])
    expect(frame.recipe).toEqual([])
  })

  it('fills item defaults', () => {
    const item = ItemSchema.parse(minimalItem)
    expect(item.faces).toEqual(['front'])
    expect(item.bay).toBe('full')
    expect(item.options).toEqual([])
    expect(item.recipe).toEqual([])
    expect(item.slots).toEqual([])
    expect(item.mount).toEqual({ front: 4, rear: 0 })
  })

  it('gives extras an empty mount and slots their default orientations', () => {
    const extra = ItemSchema.parse({
      ...minimalItem,
      kind: 'extra',
      id: 'rubber-feet',
      heightSixths: 0,
      depthMm: 0,
      mount: undefined,
    })
    expect(extra.mount).toEqual({ front: 0, rear: 0 })
    const tray = ItemSchema.parse({
      ...minimalItem,
      slots: [
        { id: 'bay', kind: 'area', maxW: 210, maxD: 180, layout: { xMm: 0, yMm: 3, zMm: 0 } },
      ],
    })
    expect(tray.slots[0]?.orientations).toEqual(['flat', 'flat-rotated'])
  })

  it('rejects unsafe render colours', () => {
    expect(
      ItemSchema.safeParse({ ...minimalItem, render: { style: 'blank', color: '#1a2b3c' } })
        .success,
    ).toBe(true)
    expect(
      ItemSchema.safeParse({ ...minimalItem, render: { style: 'blank', color: 'url(x)' } }).success,
    ).toBe(false)
  })

  it('parses devices and hardware', () => {
    const device = DeviceSchema.parse({
      kind: 'device',
      id: 'lenovo-m920q',
      brand: 'Lenovo',
      model: 'ThinkCentre M920q',
      category: 'mini-pc',
      dims: { w: 179, d: 183, h: 34.5 },
      power: {
        typW: 15,
        input: { kind: 'dc', brick: { included: true, outputW: 65, plug: 'c5' } },
      },
      verified,
    })
    expect(device.power?.input.brick?.included).toBe(true)
    const hardware = HardwareSchema.parse({
      kind: 'hardware',
      id: 'm6x8-shcs',
      name: 'M6×8 SHCS',
      category: 'screw',
    })
    expect(hardware.unit).toBe('pcs')
    expect(hardware.spec).toEqual({})
  })

  it('discriminates entries on kind', () => {
    const entries = [
      minimalFrame,
      minimalItem,
      { ...minimalItem, kind: 'extra', id: 'feet', heightSixths: 0 },
    ]
    expect(entries.map((entry) => CatalogEntrySchema.parse(entry).kind)).toEqual([
      'frame',
      'item',
      'extra',
    ])
    expect(CatalogEntrySchema.safeParse({ ...minimalItem, kind: 'gadget' }).success).toBe(false)
  })
})

describe('defaultMountHoles', () => {
  it('uses 2 holes for ½U or less and half-bay items, else 4', () => {
    expect(defaultMountHoles(2, 'full')).toBe(2)
    expect(defaultMountHoles(3, 'full')).toBe(2)
    expect(defaultMountHoles(4, 'full')).toBe(4)
    expect(defaultMountHoles(6, 'full')).toBe(4)
    expect(defaultMountHoles(12, 'half')).toBe(2)
  })
})

describe('catalog lookup', () => {
  const frame = FrameSchema.parse(minimalFrame)
  const item = ItemSchema.parse(minimalItem)
  const hardware = HardwareSchema.parse({
    kind: 'hardware',
    id: 'm6x8-shcs',
    name: 'M6×8',
    category: 'screw',
  })
  const base = createCatalogLookup(catalogBundle([frame, item, hardware] satisfies CatalogEntry[]))

  it('finds entries by kind and returns undefined for unknown ids', () => {
    expect(base.frame('generic-10')?.name).toBe('Generic 10" rack')
    expect(base.item('blank-1u')?.heightSixths).toBe(6)
    expect(base.hardware('m6x8-shcs')?.category).toBe('screw')
    expect(base.item('nope')).toBeUndefined()
    expect(base.device('generic-10')).toBeUndefined()
    expect(base.allItems()).toHaveLength(1)
  })

  it('overlays the custom entries of a plan', () => {
    const custom = ItemSchema.parse({ ...minimalItem, id: 'custom:my-panel', name: 'My panel' })
    const lookup = withCustomEntries(base, {
      frames: [],
      items: [custom],
      devices: [],
      hardware: [],
    })
    expect(lookup.item('custom:my-panel')?.name).toBe('My panel')
    expect(lookup.item('blank-1u')).toBe(item)
    expect(lookup.allItems().map((entry) => entry.id)).toEqual(['custom:my-panel', 'blank-1u'])
    expect(withCustomEntries(base, { frames: [], items: [], devices: [], hardware: [] })).toBe(base)
  })
})
