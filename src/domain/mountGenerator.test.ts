import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { sixthsToMm } from './geometry'
import {
  generatorParamsText,
  generatorSuggestions,
  GENERATOR_TOLERANCE_MM,
  MERKLE_MAX_U,
  mountStepSixths,
  mountWarnings,
  suggestedMountSixths,
  type GeneratorSuggestion,
} from './mountGenerator'
import type { Device, Frame } from './schema/catalog'
import type { Thread } from './schema/common'
import { EDITOR_IDS, editorCatalog } from './__fixtures__/editorFixtures'
import { KWS_FRAME } from './__fixtures__/kws'

const CATALOG = editorCatalog()

function device(id: string): Device {
  const found = CATALOG.device(id)
  if (found === undefined) throw new Error(`No device "${id}"`)
  return found
}

/** A fixture device with only its size changed. */
function sized(w: number, d: number, h: number): Device {
  return { ...device(EDITOR_IDS.m720q), id: 'sized-box', model: 'Sized box', dims: { w, d, h } }
}

function withThread(thread: Thread): Frame {
  return { ...KWS_FRAME, equipmentFastener: { ...KWS_FRAME.equipmentFastener, thread } }
}

/** Rails with one hole per U: mounts come in whole U only. */
const ONE_HOLE_FRAME: Frame = {
  ...KWS_FRAME,
  rail: { ...KWS_FRAME.rail, holeOffsetsPerUMm: [22.225] },
}

function byId(suggestions: readonly GeneratorSuggestion[], id: string): GeneratorSuggestion {
  const found = suggestions.find((suggestion) => suggestion.id === id)
  if (found === undefined) throw new Error(`No suggestion "${id}"`)
  return found
}

function params(suggestion: GeneratorSuggestion): Record<string, string> {
  return Object.fromEntries(suggestion.params.map((param) => [param.name, param.value]))
}

describe('suggestedMountSixths', () => {
  it('adds 6 mm to the height and rounds up to half a U on EIA rails', () => {
    expect(mountStepSixths(KWS_FRAME)).toBe(3)
    // 34.5 + 6 = 40.5 mm: 1U (44.45 mm).
    expect(suggestedMountSixths(device(EDITOR_IDS.m720q), KWS_FRAME)).toBe(6)
    // 17 + 6 = 23 mm is just over ½U (22.225 mm): 1U.
    expect(suggestedMountSixths(device(EDITOR_IDS.rpi5), KWS_FRAME)).toBe(6)
    // 40 + 6 = 46 mm: 1½U.
    expect(suggestedMountSixths(device(EDITOR_IDS.bigMiniPc), KWS_FRAME)).toBe(9)
    // 165 + 6 = 171 mm: 4U (177.8 mm).
    expect(suggestedMountSixths(device(EDITOR_IDS.ds224), KWS_FRAME)).toBe(24)
    // 230 + 6 = 236 mm: 5½U (244.475 mm).
    expect(suggestedMountSixths(device(EDITOR_IDS.towerUps), KWS_FRAME)).toBe(33)
  })

  it('suggests half a U for thin gear and keeps exact whole U exact', () => {
    // 10 + 6 = 16 mm: ½U.
    expect(suggestedMountSixths(sized(65, 30, 10), KWS_FRAME)).toBe(3)
    // 38.45 + 6 = 44.45 mm: exactly 1U, not 1½U.
    expect(suggestedMountSixths(sized(100, 100, 38.45), KWS_FRAME)).toBe(6)
    expect(suggestedMountSixths(sized(100, 100, 38.46), KWS_FRAME)).toBe(9)
  })

  it('rounds to whole U on rails with one hole per U', () => {
    expect(mountStepSixths(ONE_HOLE_FRAME)).toBe(6)
    expect(suggestedMountSixths(device(EDITOR_IDS.bigMiniPc), ONE_HOLE_FRAME)).toBe(12)
    expect(suggestedMountSixths(sized(65, 30, 10), ONE_HOLE_FRAME)).toBe(6)
  })

  test.prop([fc.double({ min: 0.1, max: 2000, noNaN: true })])(
    'always holds the device with its clearance, in at most one step more',
    (heightMm) => {
      const sixths = suggestedMountSixths(sized(100, 100, heightMm), KWS_FRAME)
      expect(sixths % 3).toBe(0)
      expect(sixthsToMm(sixths)).toBeGreaterThanOrEqual(heightMm + 6 - 1e-6)
      expect(sixthsToMm(sixths - 3)).toBeLessThan(heightMm + 6 + 1e-6)
    },
  )
})

describe('generatorSuggestions', () => {
  // Big mini PC: 190 × 190 × 40 mm, so 1½U.
  const suggestions = generatorSuggestions(device(EDITOR_IDS.bigMiniPc), KWS_FRAME)

  it('offers the three generators with their pages and licence labels', () => {
    expect(
      suggestions.map(({ id, name, designer, url, license }) => ({
        id,
        name,
        designer,
        url,
        license,
      })),
    ).toEqual([
      {
        id: 'spuder-10-inch-rack',
        name: '10 Inch Mini Rack Generator',
        designer: 'spuder',
        url: 'https://makerworld.com/en/models/1765102',
        license: 'Standard Digital File License',
      },
      {
        id: 'kellerlab-unimount',
        name: 'Customizable Rackmount [ANY RACKSIZE]',
        designer: 'KellerLab',
        url: 'https://makerworld.com/en/models/2128492',
        license: 'Standard Digital File License',
      },
      {
        id: 'merkle-parametric-mount',
        name: 'Fully Parametric Server/Network Device Rack Mount',
        designer: 'Clayton Merkle',
        url: 'https://makerworld.com/en/models/1488064',
        license: 'Standard Digital File License',
      },
    ])
    expect(byId(suggestions, 'spuder-10-inch-rack').sourceCode).toEqual({
      url: 'https://github.com/spuder/10-Inch-Rack-OpenSCAD',
      license: 'MIT',
      label: 'OpenSCAD source on GitHub (spuder/10-Inch-Rack-OpenSCAD)',
    })
  })

  it('sizes spuder’s generator in half U, with 2 mm of tolerance on each side', () => {
    expect(GENERATOR_TOLERANCE_MM).toBe(2)
    const spuder = byId(suggestions, 'spuder-10-inch-rack')
    expect(spuder.heightSixths).toBe(9)
    expect(params(spuder)).toEqual({
      rack_width: '254',
      rack_height: '1.5',
      component_width: '192',
      component_height: '42',
      component_depth: '192',
      air_holes: 'true',
    })
  })

  it('uses whole U for the other two', () => {
    const keller = byId(suggestions, 'kellerlab-unimount')
    expect(keller.heightSixths).toBe(12)
    expect(params(keller)).toEqual({
      'device width': '192',
      'device height': '42',
      'device depth': '192',
      'rack size': '10in',
      U: '2',
    })
    const merkle = byId(suggestions, 'merkle-parametric-mount')
    expect(merkle.heightSixths).toBe(12)
    expect(params(merkle)).toEqual({
      'rack units': '2',
      'rail holes': 'M6',
      'device cutout width': '192',
      'device cutout height': '42',
      'shelf depth': '192',
    })
  })

  it('keeps decimals of a millimetre', () => {
    const spuder = byId(
      generatorSuggestions(device(EDITOR_IDS.m720q), KWS_FRAME),
      'spuder-10-inch-rack',
    )
    // 179 × 183 × 34.5 mm.
    expect(params(spuder)).toMatchObject({
      rack_height: '1',
      component_width: '181',
      component_height: '36.5',
      component_depth: '185',
    })
  })

  it('picks the rail holes that pass the frame’s screws', () => {
    const holes = (thread: Thread) => {
      const merkle = byId(
        generatorSuggestions(sized(100, 100, 30), withThread(thread)),
        'merkle-parametric-mount',
      )
      return { value: params(merkle)['rail holes'], notes: merkle.notes ?? [] }
    }
    expect(holes('M6')).toEqual({ value: 'M6', notes: [] })
    expect(holes('10-32')).toEqual({ value: '10-32', notes: [] })
    // KWS takes M5 screws.
    expect(holes('M5')).toEqual({
      value: 'M6',
      notes: ['Your frame takes M5 screws: M6 holes let them through.'],
    })
    expect(holes('12-24').value).toBe('M6')
    expect(holes('M4')).toEqual({
      value: '10-32',
      notes: ['Your frame takes M4 screws: the smaller 10-32 holes let them through.'],
    })
  })

  it('leaves out the 1U–8U generator for taller gear', () => {
    // 349 + 6 = 355 mm: exactly 8U.
    const eightU = generatorSuggestions(sized(150, 150, 349), KWS_FRAME)
    expect(byId(eightU, 'merkle-parametric-mount').heightSixths).toBe(MERKLE_MAX_U * 6)
    const taller = generatorSuggestions(sized(150, 150, 350), KWS_FRAME)
    expect(taller.map((suggestion) => suggestion.id)).toEqual([
      'spuder-10-inch-rack',
      'kellerlab-unimount',
    ])
  })

  it('follows a 6-inch frame’s panel width', () => {
    const sixInch: Frame = {
      ...KWS_FRAME,
      standard: { ...KWS_FRAME.standard, panelWidthMm: 152.4 },
    }
    const [spuder, keller] = generatorSuggestions(sized(100, 100, 30), sixInch)
    expect(spuder?.params[0]).toEqual({
      name: 'rack_width',
      label: 'Rack width (6-inch)',
      value: '152.4',
    })
    expect(keller === undefined ? undefined : params(keller)['rack size']).toBe('6in')
  })
})

describe('generatorParamsText', () => {
  it('writes one `name = value` per line under the generator’s name', () => {
    const [spuder] = generatorSuggestions(device(EDITOR_IDS.bigMiniPc), KWS_FRAME)
    expect(spuder === undefined ? '' : generatorParamsText(spuder)).toBe(
      [
        '10 Inch Mini Rack Generator (spuder)',
        'rack_width = 254',
        'rack_height = 1.5',
        'component_width = 192',
        'component_height = 42',
        'component_depth = 192',
        'air_holes = true',
      ].join('\n'),
    )
  })
})

describe('mountWarnings', () => {
  it('says when a device is wider than the opening or deeper than the rack', () => {
    expect(mountWarnings(device(EDITOR_IDS.m720q), KWS_FRAME)).toEqual([])
    expect(mountWarnings(device(EDITOR_IDS.wideBox), KWS_FRAME)).toEqual([
      'The Fixture Wide box is 230 mm wide, wider than the 222 mm opening of the KWS Rack v2: it would have to stand on its side.',
    ])
    expect(mountWarnings(device(EDITOR_IDS.towerUps), KWS_FRAME)).toEqual([
      'The Fixture Tower UPS is 300 mm deep, deeper than the KWS Rack v2 (250 mm): it would stick out at the back.',
    ])
  })

  it('uses the rack’s size after its options when given', () => {
    // KWS with the 320 mm connectors.
    const space = { innerWidthMm: 222, depthMm: 320 }
    expect(mountWarnings(device(EDITOR_IDS.towerUps), KWS_FRAME, space)).toEqual([])
  })
})
