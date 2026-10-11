import { describe, expect, it } from 'vitest'
import { CatalogEntrySchema } from './catalog'
import { checkEntryIntegrity } from './integrity'

const verified = { by: 'test', date: '2026-10-11', method: 'unverified' }

const frame = {
  kind: 'frame',
  id: 'kws-test',
  name: 'KWS-like test frame',
  source: { platform: 'makerworld', url: 'https://makerworld.com/en/models/2139130' },
  verified,
  standard: { panelWidthMm: 254, innerWidthMm: 222, depthMm: 250, rearOpen: true },
  rail: { earSpacingMm: 236.525, holeOffsetsPerUMm: [6.35, 22.225, 38.1], holeTolMm: 0.5 },
  equipmentFastener: { thread: 'M5', perHole: 'screw', screwIds: ['m5x10-shcs'], engagementMm: 5 },
  sectionTypes: [
    { id: 's3', label: '3U section', heightU: 3 },
    { id: 's6', label: '6U section', heightU: 6 },
  ],
  stack: { minU: 3, maxU: 24 },
  options: [{ id: 'magnets', label: 'Magnets', scope: 'section', kind: 'boolean', default: true }],
  prints: [
    {
      id: 'leg-6u',
      plate: '6U leg',
      label: '6U leg',
      pieces: [{ partId: 'leg', perPrint: 1 }],
      embeds: [{ hardwareId: 'magnet-10x5', perPrint: 14, when: { option: { magnets: true } } }],
    },
  ],
  recipe: [
    { id: 'legs', unit: 'section', ref: { print: 'leg-6u' }, count: { perSection: { s6: 4 } } },
    {
      id: 'top-bolts',
      unit: 'top',
      ref: { hardware: 'm6x8-shcs' },
      count: 4,
      when: { stack: { topTypeId: 's3' } },
    },
  ],
  parts3d: [{ id: 'leg', label: 'Leg', role: 'leg', envelopeMm: { w: 20, d: 30, h: 266 } }],
  assembly3d: [
    { partId: 'leg', at: 'section', sectionTypes: ['s6'], corners: ['fl', 'fr', 'rl', 'rr'] },
  ],
}

const item = {
  kind: 'item',
  id: 'blank-1u',
  name: 'Blank panel 1U',
  category: 'panel',
  source: { platform: 'printables', url: 'https://www.printables.com/model/2' },
  verified,
  heightSixths: 6,
  depthMm: 3,
  mount: { front: 4, holeOffsetsMm: [6.35, 38.1] },
}

function problems(input: unknown): string[] {
  return checkEntryIntegrity(CatalogEntrySchema.parse(input))
}

describe('checkEntryIntegrity', () => {
  it('accepts consistent entries', () => {
    expect(problems(frame)).toEqual([])
    expect(problems(item)).toEqual([])
  })

  it('finds broken references inside a frame', () => {
    const broken = {
      ...frame,
      options: [
        ...frame.options,
        { id: 'magnets', label: 'Again', scope: 'item', kind: 'boolean', default: false },
      ],
      recipe: [
        { id: 'legs', unit: 'section', ref: { print: 'leg-9u' }, count: { perSection: { s9: 4 } } },
        {
          id: 'legs',
          unit: 'item',
          ref: { hardware: 'm6x8-shcs' },
          count: 1,
          when: { option: { grill: true } },
        },
        {
          id: 'joints',
          unit: 'joint',
          ref: { print: 'leg-6u' },
          count: { perU: 1 },
          length: { perU: 1 },
        },
        {
          id: 'magnet-choice',
          unit: 'rack',
          ref: { hardware: 'magnet' },
          count: 1,
          when: { option: { magnets: 'yes' } },
        },
      ],
      assembly3d: [{ partId: 'arm', at: 'item', sectionTypes: ['s9'] }],
    }
    const found = problems(broken)
    expect(found).toEqual(
      expect.arrayContaining([
        'option id "magnets" is used more than once',
        'option "magnets": scope "item" is not allowed here (use rack / top / bottom / section)',
        'recipe line id "legs" is used more than once',
        'recipe line "legs": unknown print "leg-9u"',
        'recipe line "legs": unknown section type "s9"',
        'recipe line "legs": unit "item" is not allowed here (use rack / top / bottom / section / joint)',
        'recipe line "legs": condition uses unknown option "grill"',
        'recipe line "joints": only hardware lines can have a cut length',
        'recipe line "joints": perU has no meaning per joint',
        'recipe line "magnet-choice": condition value "yes" is not valid for option "magnets"',
        'assembly3d[0]: unknown 3D part "arm"',
        'assembly3d[0]: a frame rule cannot be placed "at: item"',
        'assembly3d[0]: unknown section type "s9"',
      ]),
    )
  })

  it('requires a source for curated frames and items only', () => {
    expect(problems({ ...frame, source: undefined })).toEqual(['a curated frame needs a source'])
    expect(problems({ ...frame, id: 'custom:my-frame', source: undefined })).toEqual([])
    expect(problems({ ...item, source: undefined })).toEqual(['a curated item needs a source'])
  })

  it('checks item kind, height and mount holes', () => {
    expect(problems({ ...item, mount: { front: 0 } })).toEqual([
      'an item needs mount holes (see defaultMountHoles)',
    ])
    expect(problems({ ...item, kind: 'extra' })).toEqual(['an extra must have heightSixths 0'])
    expect(problems({ ...item, mount: { front: 4, holeOffsetsMm: [50] } })).toEqual([
      "mount hole offset 50 mm is above the item's height",
    ])
    expect(
      problems({
        ...item,
        recipe: [{ id: 'x', unit: 'section', ref: { hardware: 'm3' }, count: 1 }],
      }),
    ).toEqual(['recipe line "x": unit "section" is not allowed here (use item)'])
  })

  it('checks print pieces against 3D parts', () => {
    expect(problems({ ...frame, parts3d: undefined, assembly3d: undefined })).toEqual([
      'print "leg-6u": unknown 3D part "leg"',
    ])
  })
})
