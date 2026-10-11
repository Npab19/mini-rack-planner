/**
 * Frozen KWS Rack v2 fixture for logic tests: a copy of the frame entry, a few hardware entries,
 * items and devices, a catalog builder and a plan builder.
 *
 * Tests use this copy, never `catalog/`, so curating the real entry cannot silently change
 * expected numbers (`kws.data.test.ts` covers the real data). The frame is copied verbatim from
 * catalog/frames/kws-rack-v2.json as of 2026-10-11. Hardware copies ids, names and specs but not
 * pack sizes, so buy = need unless a test adds packs. Items and devices are illustrative fixture
 * values, not measurements.
 */
import type { z } from 'zod'
import { resolveOptionValues, sectionHeightU } from '../recipe'
import {
  catalogBundle,
  CatalogEntrySchema,
  createCatalogLookup,
  FrameSchema,
  type CatalogEntry,
  type CatalogLookup,
  type Frame,
} from '../schema/catalog'
import type { OptionValues } from '../schema/common'
import { PlanSchema, type Plan, type PlanSection, type Snapshot } from '../schema/plan'

export const FIXTURE_NOW = '2026-10-11T09:30:00.000Z'
const VERIFIED = { by: 'fixture', date: '2026-10-11', method: 'page' } as const
const EXAMPLE_SOURCE = (slug: string) => ({
  platform: 'other' as const,
  url: `https://example.com/mini-rack-fixtures/${slug}`,
})

export const KWS_FRAME_ID = 'kws-rack-v2'

/** Ids the tests assert on. */
export const KWS_IDS = {
  inserts: 'insert-m5x8x7',
  magnets: 'magnet-10x5',
  m6x8: 'screw-m6x8-shcs',
  m6x10: 'screw-m6x10-shcs',
  nyloc: 'nut-m6-nyloc',
  m5x10: 'screw-m5x10-shcs',
  m5x12: 'screw-m5x12-shcs',
  m5x16: 'screw-m5x16-shcs',
  m5Nut: 'nut-m5-hex',
  m6CageNut: 'cage-nut-m6',
  rubberFoot: 'rubber-foot-10x3',
} as const

/** Verbatim copy of catalog/frames/kws-rack-v2.json (2026-10-11). Do not sync it automatically. */
export const KWS_FRAME_INPUT = {
  kind: 'frame',
  id: 'kws-rack-v2',
  name: 'KWS Rack v2',
  source: {
    platform: 'makerworld',
    url: 'https://makerworld.com/en/models/2139130',
    modelId: '2139130',
    profileId: '2317125',
    designer: 'Ilan Kushnir',
  },
  verified: {
    by: 'seed research',
    date: '2026-10-09',
    method: 'unverified',
    note: 'designer profile data via research 2026-10-09; verify with user files. depthMm 250 is a placeholder; innerWidthMm 222, the 3D part envelopes and the connector pieces per plate are unverified; where the 7 rack-level magnets go is still to be checked.',
  },
  standard: {
    panelWidthMm: 254,
    innerWidthMm: 222,
    depthMm: 250,
    rearOpen: true,
  },
  rail: {
    earSpacingMm: 236.525,
    holeOffsetsPerUMm: [6.35, 22.225, 38.1],
    holeTolMm: 1,
  },
  equipmentFastener: {
    thread: 'M5',
    perHole: 'screw',
    screwIds: ['screw-m5x10-shcs', 'screw-m5x12-shcs', 'screw-m5x16-shcs'],
    engagementMm: 6,
  },
  sectionTypes: [
    {
      id: 's3',
      label: '3U section',
      heightU: 3,
    },
    {
      id: 's6',
      label: '6U section',
      heightU: 6,
    },
  ],
  stack: {
    minU: 3,
    maxU: 30,
  },
  options: [
    {
      id: 'magnets',
      label: 'Magnetic frame (10x5 mm magnets)',
      scope: 'section',
      kind: 'boolean',
      default: true,
    },
    {
      id: 'insert-policy',
      label: 'Heat-set inserts',
      scope: 'rack',
      kind: 'choice',
      choices: [
        {
          id: 'all',
          label: 'Every rail hole (designer table)',
        },
        {
          id: 'top-bottom',
          label: 'Top and bottom hole of each U',
        },
      ],
      default: 'all',
    },
    {
      id: 'top',
      label: 'Top',
      scope: 'top',
      kind: 'choice',
      choices: [
        {
          id: 'handle',
          label: 'Handle',
        },
        {
          id: 'flat',
          label: 'Flat connector',
        },
      ],
      default: 'handle',
    },
    {
      id: 'stoppers',
      label: 'Bottom base stoppers',
      scope: 'bottom',
      kind: 'boolean',
      default: false,
    },
    {
      id: 'high-rack',
      label: 'Connector for high racks',
      scope: 'rack',
      kind: 'boolean',
      default: false,
    },
    {
      id: 'side-panels',
      label: 'Side panels',
      scope: 'section',
      kind: 'choice',
      choices: [
        {
          id: 'none',
          label: 'None',
        },
        {
          id: 'printed',
          label: 'Printed side plates (grill)',
        },
      ],
      default: 'none',
    },
    {
      id: 'deep-320',
      label: '320 mm deep connectors',
      scope: 'rack',
      kind: 'boolean',
      default: false,
      effects: {
        depthMm: 320,
      },
    },
  ],
  prints: [
    {
      id: 'leg-6u',
      plate: '[Print x4] - Magnetic frame - 6U',
      label: '6U frame leg',
      material: 'PETG',
      gramsPerPrint: 125,
      minutesPerPrint: 323,
      pieces: [
        {
          partId: 'leg-6u',
          perPrint: 1,
        },
      ],
      embeds: [
        {
          hardwareId: 'insert-m5x8x7',
          perPrint: 18,
          when: {
            option: {
              'insert-policy': 'all',
            },
          },
        },
        {
          hardwareId: 'insert-m5x8x7',
          perPrint: 12,
          when: {
            option: {
              'insert-policy': 'top-bottom',
            },
          },
        },
        {
          hardwareId: 'magnet-10x5',
          perPrint: 14,
          when: {
            option: {
              magnets: true,
            },
          },
        },
      ],
    },
    {
      id: 'plate-3u',
      plate: '[Optional] - Magnetic frame - 3U',
      label: '3U leg plate (4 legs)',
      material: 'PETG',
      gramsPerPrint: 214,
      minutesPerPrint: 528,
      pieces: [
        {
          partId: 'leg-3u',
          perPrint: 4,
        },
      ],
      embeds: [
        {
          hardwareId: 'insert-m5x8x7',
          perPrint: 36,
          when: {
            option: {
              'insert-policy': 'all',
            },
          },
        },
        {
          hardwareId: 'insert-m5x8x7',
          perPrint: 24,
          when: {
            option: {
              'insert-policy': 'top-bottom',
            },
          },
        },
        {
          hardwareId: 'magnet-10x5',
          perPrint: 16,
          when: {
            option: {
              magnets: true,
            },
          },
        },
      ],
    },
    {
      id: 'frame-connectors',
      plate: 'Frame connectors',
      label: 'Frame connectors',
      material: 'PETG',
      gramsPerPrint: 68,
      minutesPerPrint: 180,
      pieces: [
        {
          partId: 'connector',
          perPrint: 4,
        },
      ],
    },
    {
      id: 'top-handle',
      plate: '[Print x2] - Top frame handle',
      label: 'Top frame handle',
      material: 'PETG',
      gramsPerPrint: 217,
      minutesPerPrint: 421,
      pieces: [
        {
          partId: 'top',
          perPrint: 1,
        },
      ],
    },
    {
      id: 'top-flat',
      plate: '[Optional] - [Print x2] - Top frame flat connector',
      label: 'Top frame flat connector',
      material: 'PETG',
      gramsPerPrint: 132,
      minutesPerPrint: 286,
    },
    {
      id: 'top-connectors',
      plate: '[Print x2] - Top frame connectors',
      label: 'Top frame connectors',
      material: 'PETG',
      gramsPerPrint: 44,
      minutesPerPrint: 85,
    },
    {
      id: 'base-legs',
      plate: '[Print x2] - Bottom frame base legs',
      label: 'Bottom frame base legs',
      material: 'PETG',
      gramsPerPrint: 131,
      minutesPerPrint: 248,
      pieces: [
        {
          partId: 'bottom',
          perPrint: 1,
        },
      ],
    },
    {
      id: 'bottom-connectors',
      plate: '[Print x2] - Bottom frame connectors',
      label: 'Bottom frame connectors',
      material: 'PETG',
      gramsPerPrint: 45,
      minutesPerPrint: 89,
    },
    {
      id: 'base-stoppers',
      plate: '[Optional] - Bottom base stoppers',
      label: 'Bottom base stoppers',
      material: 'PETG',
      gramsPerPrint: 43,
      minutesPerPrint: 99,
    },
    {
      id: 'high-rack-connector',
      plate: '[Optional] - connector for HIGH RACKS',
      label: 'Connector for high racks',
      material: 'PETG',
      gramsPerPrint: 52,
      minutesPerPrint: 117,
    },
    {
      id: 'side-plate-3u',
      plate: 'Side plate 3U (grill)',
      label: 'Side plate 3U (grill)',
      material: 'PETG',
      gramsPerPrint: 49,
      minutesPerPrint: 80,
    },
    {
      id: 'spacer-6u',
      plate: 'Spacer for 6U side plates',
      label: 'Spacer for 6U side plates',
      material: 'PETG',
      gramsPerPrint: 6,
      minutesPerPrint: 18,
    },
  ],
  recipe: [
    {
      id: 'legs-6u',
      unit: 'section',
      ref: {
        print: 'leg-6u',
      },
      count: {
        perSection: {
          s6: 4,
        },
      },
    },
    {
      id: 'plate-3u',
      unit: 'section',
      ref: {
        print: 'plate-3u',
      },
      count: {
        perSection: {
          s3: 1,
        },
      },
    },
    {
      id: 'm6x8',
      unit: 'section',
      ref: {
        hardware: 'screw-m6x8-shcs',
      },
      count: {
        perSectionAny: 16,
      },
    },
    {
      id: 'm6x10',
      unit: 'section',
      ref: {
        hardware: 'screw-m6x10-shcs',
      },
      count: {
        perSectionAny: 24,
      },
    },
    {
      id: 'm6-nyloc',
      unit: 'section',
      ref: {
        hardware: 'nut-m6-nyloc',
      },
      count: {
        perSectionAny: 40,
      },
    },
    {
      id: 'side-plates',
      unit: 'section',
      ref: {
        print: 'side-plate-3u',
      },
      count: {
        perSection: {
          s3: 2,
          s6: 4,
        },
      },
      when: {
        option: {
          'side-panels': 'printed',
        },
      },
    },
    {
      id: 'side-spacers',
      unit: 'section',
      ref: {
        print: 'spacer-6u',
      },
      count: {
        perSection: {
          s6: 2,
        },
      },
      when: {
        option: {
          'side-panels': 'printed',
        },
      },
    },
    {
      id: 'frame-connectors',
      unit: 'joint',
      ref: {
        print: 'frame-connectors',
      },
      count: 1,
    },
    {
      id: 'top-handle',
      unit: 'top',
      ref: {
        print: 'top-handle',
      },
      count: 2,
      when: {
        option: {
          top: 'handle',
        },
      },
    },
    {
      id: 'top-flat',
      unit: 'top',
      ref: {
        print: 'top-flat',
      },
      count: 2,
      when: {
        option: {
          top: 'flat',
        },
      },
    },
    {
      id: 'top-connectors',
      unit: 'top',
      ref: {
        print: 'top-connectors',
      },
      count: 2,
    },
    {
      id: 'base-legs',
      unit: 'bottom',
      ref: {
        print: 'base-legs',
      },
      count: 2,
    },
    {
      id: 'bottom-connectors',
      unit: 'bottom',
      ref: {
        print: 'bottom-connectors',
      },
      count: 2,
    },
    {
      id: 'base-stoppers',
      unit: 'bottom',
      ref: {
        print: 'base-stoppers',
      },
      count: 1,
      when: {
        option: {
          stoppers: true,
        },
      },
    },
    {
      id: 'rack-magnets',
      unit: 'rack',
      ref: {
        hardware: 'magnet-10x5',
      },
      count: 7,
      when: {
        option: {
          magnets: true,
        },
      },
      note: '7 per rack (designer table; where they go is still to be checked)',
    },
    {
      id: 'high-rack-connector',
      unit: 'rack',
      ref: {
        print: 'high-rack-connector',
      },
      count: 1,
      when: {
        option: {
          'high-rack': true,
        },
      },
    },
  ],
  parts3d: [
    {
      id: 'leg-6u',
      label: '6U frame leg',
      role: 'leg',
      envelopeMm: {
        w: 20,
        d: 20,
        h: 266.7,
      },
      nameHints: ['Magnetic frame - 6U'],
    },
    {
      id: 'leg-3u',
      label: '3U frame leg',
      role: 'leg',
      envelopeMm: {
        w: 20,
        d: 20,
        h: 133.35,
      },
      nameHints: ['Magnetic frame - 3U'],
    },
    {
      id: 'connector',
      label: 'Frame connector',
      role: 'connector',
      envelopeMm: {
        w: 20,
        d: 20,
        h: 20,
      },
      nameHints: ['Frame connectors'],
    },
    {
      id: 'top',
      label: 'Top frame handle',
      role: 'cap',
      envelopeMm: {
        w: 20,
        d: 250,
        h: 30,
      },
      nameHints: ['Top frame handle'],
    },
    {
      id: 'bottom',
      label: 'Bottom frame base leg',
      role: 'cap',
      envelopeMm: {
        w: 20,
        d: 250,
        h: 30,
      },
      nameHints: ['Bottom frame base legs'],
    },
  ],
}

const HARDWARE_INPUTS = [
  {
    kind: 'hardware',
    id: 'insert-m5x8x7',
    name: 'M5 heat-set insert (M5x8x7)',
    category: 'insert',
    spec: {
      thread: 'M5',
      lengthMm: 8,
      odMm: 7,
      dims: 'M5x8x7',
    },
  },
  {
    kind: 'hardware',
    id: 'magnet-10x5',
    name: 'Round neodymium magnet 10×5 mm',
    category: 'magnet',
    spec: {
      odMm: 10,
      dims: '10x5',
    },
  },
  {
    kind: 'hardware',
    id: 'screw-m6x8-shcs',
    name: 'M6×8 socket head cap screw',
    category: 'screw',
    spec: {
      thread: 'M6',
      lengthMm: 8,
      head: 'shcs',
    },
  },
  {
    kind: 'hardware',
    id: 'screw-m6x10-shcs',
    name: 'M6×10 socket head cap screw',
    category: 'screw',
    spec: {
      thread: 'M6',
      lengthMm: 10,
      head: 'shcs',
    },
  },
  {
    kind: 'hardware',
    id: 'nut-m6-nyloc',
    name: 'M6 nyloc nut',
    category: 'nut',
    spec: {
      thread: 'M6',
      head: 'nyloc',
    },
  },
  {
    kind: 'hardware',
    id: 'screw-m5x10-shcs',
    name: 'M5×10 socket head cap screw',
    category: 'screw',
    spec: {
      thread: 'M5',
      lengthMm: 10,
      head: 'shcs',
    },
  },
  {
    kind: 'hardware',
    id: 'screw-m5x12-shcs',
    name: 'M5×12 socket head cap screw',
    category: 'screw',
    spec: {
      thread: 'M5',
      lengthMm: 12,
      head: 'shcs',
    },
  },
  {
    kind: 'hardware',
    id: 'screw-m5x16-shcs',
    name: 'M5×16 socket head cap screw',
    category: 'screw',
    spec: {
      thread: 'M5',
      lengthMm: 16,
      head: 'shcs',
    },
  },
  {
    kind: 'hardware',
    id: 'nut-m5-hex',
    name: 'M5 hex nut',
    category: 'nut',
    spec: {
      thread: 'M5',
      head: 'hex',
    },
  },
  {
    kind: 'hardware',
    id: 'cage-nut-m6',
    name: 'M6 cage nut',
    category: 'cage-nut',
    spec: {
      thread: 'M6',
      head: 'cage',
    },
  },
  {
    kind: 'hardware',
    id: 'rubber-foot-10x3',
    name: 'Adhesive rubber foot 10×3 mm',
    category: 'foot',
    spec: {
      odMm: 10,
      dims: '10x3',
    },
  },
]

const ITEM_INPUTS = [
  {
    kind: 'item',
    id: 'lenovo-tiny-mount',
    name: 'Lenovo Tiny mount',
    category: 'mini-pc-mount',
    source: EXAMPLE_SOURCE('lenovo-tiny-mount'),
    verified: VERIFIED,
    heightSixths: 6,
    depthMm: 190,
    mount: { front: 4, holeOffsetsMm: [6.35, 38.1], clearance: 'M5', earThicknessMm: 4 },
    slots: [
      {
        id: 'bay',
        kind: 'fixed',
        maxW: 182,
        maxD: 186,
        maxH: 37,
        accepts: { categories: ['mini-pc'] },
        layout: { xMm: 20, yMm: 3, zMm: 0 },
      },
    ],
    prints: [
      {
        id: 'mount',
        plate: 'Tiny mount',
        label: 'Tiny mount',
        material: 'PETG',
        gramsPerPrint: 150,
        minutesPerPrint: 260,
      },
    ],
    recipe: [
      { id: 'mount', unit: 'item', ref: { print: 'mount' }, count: 1 },
      // The designer's own list; the BOM derives rack screws from the mount holes instead.
      {
        id: 'rack-screws',
        unit: 'item',
        ref: { hardware: KWS_IDS.m5x10 },
        count: 4,
        role: 'rack-mount',
      },
    ],
    render: { style: 'device' },
  },
  {
    kind: 'item',
    id: 'shelf-2u',
    name: '2U shelf',
    category: 'shelf',
    source: EXAMPLE_SOURCE('shelf-2u'),
    verified: VERIFIED,
    heightSixths: 12,
    depthMm: 245,
    mount: { front: 4, holeOffsetsMm: [6.35, 82.55], clearance: 'M5', earThicknessMm: 5 },
    requiresRearSupport: true,
    slots: [
      {
        id: 'deck',
        kind: 'area',
        maxW: 215,
        maxD: 240,
        maxH: 80,
        orientations: ['flat', 'flat-rotated', 'on-side'],
        layout: { xMm: 3, yMm: 5, zMm: 0 },
      },
    ],
    prints: [
      {
        id: 'shelf',
        plate: 'Shelf halves',
        label: 'Shelf halves',
        material: 'PLA',
        gramsPerPrint: 180,
        minutesPerPrint: 300,
        embeds: [{ hardwareId: KWS_IDS.inserts, perPrint: 4 }],
      },
    ],
    recipe: [
      { id: 'shelf', unit: 'item', ref: { print: 'shelf' }, count: 1 },
      { id: 'joiners', unit: 'item', ref: { hardware: KWS_IDS.m6x10 }, count: 2 },
    ],
  },
  {
    kind: 'item',
    id: 'blank-1u',
    name: '1U blank',
    category: 'panel',
    source: EXAMPLE_SOURCE('blank-1u'),
    verified: VERIFIED,
    heightSixths: 6,
    depthMm: 4,
    mount: { front: 4 },
    prints: [
      {
        id: 'panel',
        plate: 'Blank',
        label: 'Blank',
        material: 'PLA',
        gramsPerPrint: 25,
        minutesPerPrint: 40,
      },
    ],
    recipe: [{ id: 'panel', unit: 'item', ref: { print: 'panel' }, count: 1 }],
  },
  {
    kind: 'extra',
    id: 'rubber-feet',
    name: 'Rubber feet',
    category: 'accessory',
    source: EXAMPLE_SOURCE('rubber-feet'),
    verified: VERIFIED,
    heightSixths: 0,
    depthMm: 0,
    recipe: [{ id: 'feet', unit: 'item', ref: { hardware: KWS_IDS.rubberFoot }, count: 4 }],
  },
]

const DEVICE_INPUTS = [
  {
    id: 'lenovo-m720q',
    brand: 'Lenovo',
    model: 'ThinkCentre M720q Tiny',
    category: 'mini-pc',
    dims: { w: 179, d: 183, h: 34.5 },
    power: {
      typW: 15,
      maxW: 65,
      input: { kind: 'dc', brick: { outputW: 65, included: true, plug: 'c5' } },
    },
  },
  {
    id: 'nas-2bay',
    brand: 'Fixture',
    model: '2-bay NAS',
    category: 'nas',
    dims: { w: 100, d: 220, h: 165 },
    power: {
      typW: 18,
      maxW: 40,
      input: { kind: 'dc', brick: { outputW: 60, included: true, plug: 'wall' } },
    },
  },
  {
    id: 'rpi-5',
    brand: 'Raspberry Pi',
    model: '5',
    category: 'sbc',
    dims: { w: 85, d: 56, h: 17 },
    power: {
      typW: 5,
      maxW: 27,
      input: { kind: 'usb-c-pd', brick: { outputW: 27, included: false, plug: 'wall' } },
    },
  },
  {
    id: 'pi-zero-usb',
    brand: 'Fixture',
    model: 'USB-C powered board',
    category: 'sbc',
    dims: { w: 65, d: 30, h: 10 },
    power: { typW: 2, maxW: 5, input: { kind: 'usb-c-pd' } },
  },
  {
    id: 'pdu-4',
    brand: 'Fixture',
    model: '4-outlet 10" PDU',
    category: 'pdu',
    dims: { w: 215, d: 60, h: 44 },
    power: { input: { kind: 'ac' }, outputs: [{ kind: 'ac', count: 4 }] },
    rackmount: { heightSixths: 6, face: 'front', depthMm: 60 },
  },
  {
    id: 'poe-switch-8',
    brand: 'Fixture',
    model: '8-port PoE switch',
    category: 'switch',
    dims: { w: 200, d: 120, h: 30 },
    power: {
      typW: 8,
      maxW: 75,
      input: { kind: 'ac' },
      outputs: [{ kind: 'poe', count: 4, budgetW: 60 }],
    },
  },
  {
    id: 'poe-camera',
    brand: 'Fixture',
    model: 'PoE camera',
    category: 'other',
    dims: { w: 60, d: 60, h: 60 },
    power: { typW: 4, maxW: 7, input: { kind: 'poe' } },
  },
  {
    id: 'usb-c-charger',
    brand: 'Fixture',
    model: '4-port USB-C charger',
    category: 'power-brick',
    dims: { w: 70, d: 70, h: 30 },
    power: { input: { kind: 'ac' }, outputs: [{ kind: 'usb-c', count: 4, maxWEach: 30 }] },
  },
].map((entry) => ({ kind: 'device', verified: VERIFIED, ...entry }))

/** The frozen KWS frame, parsed (defaults applied). */
export const KWS_FRAME: Frame = FrameSchema.parse(KWS_FRAME_INPUT)

/** Every fixture entry: the frame, hardware, items, extras and devices. */
export const KWS_ENTRIES: readonly CatalogEntry[] = [
  KWS_FRAME,
  ...[...HARDWARE_INPUTS, ...ITEM_INPUTS, ...DEVICE_INPUTS].map((input) =>
    CatalogEntrySchema.parse(input),
  ),
]

/** Parses raw entries (as a catalog file would hold them) for `kwsCatalog` overrides. */
export function parseEntries(inputs: readonly unknown[]): CatalogEntry[] {
  return inputs.map((input) => CatalogEntrySchema.parse(input))
}

/** Catalog lookup over the fixture; `overrides` add entries or replace ones with the same id. */
export function kwsCatalog(overrides: readonly CatalogEntry[] = []): CatalogLookup {
  return createCatalogLookup(catalogBundle([...KWS_ENTRIES, ...overrides]))
}

// ---------------------------------------------------------------------------------------------
// Plans

type PlanInput = z.input<typeof PlanSchema>

export interface SectionSpec {
  u: 3 | 6
  have?: boolean
  options?: OptionValues
  /** Options the section was built with (snapshot); defaults to its resolved current options. */
  builtOptions?: OptionValues
}

export interface CapSpec {
  options?: OptionValues
  /** Cap snapshot. By default caps are captured when any section is Have (the caller rule). */
  have?: boolean
  builtOptions?: OptionValues
}

export interface KwsPlanSpec {
  /** Bottom -> top: 3 or 6 for a planned section, or a full spec. */
  sections?: ReadonlyArray<3 | 6 | SectionSpec>
  rackOptions?: OptionValues
  top?: CapSpec
  bottom?: CapSpec
  placements?: PlanInput['placements']
  equipment?: PlanInput['equipment']
  extras?: PlanInput['extras']
  retired?: PlanInput['retired']
  custom?: PlanInput['custom']
}

/** A section spec as a full spec. */
function sectionSpec(spec: 3 | 6 | SectionSpec): SectionSpec {
  return typeof spec === 'number' ? { u: spec } : spec
}

/** What Mark as Have captures for a section: type, height and resolved option values. */
export function sectionSnapshot(
  frame: Frame,
  rackOptions: OptionValues,
  section: Pick<PlanSection, 'typeId' | 'heightU' | 'options'>,
  builtOptions?: OptionValues,
): Snapshot {
  return {
    at: FIXTURE_NOW,
    typeId: section.typeId,
    heightU: sectionHeightU(frame, section.typeId, section.heightU),
    options: builtOptions ?? resolveOptionValues(frame.options, rackOptions, section.options),
  }
}

/** What Mark as Have captures for a cap: its resolved option values. */
export function capSnapshot(
  frame: Frame,
  rackOptions: OptionValues,
  capOptions: OptionValues | undefined,
  builtOptions?: OptionValues,
): Snapshot {
  return {
    at: FIXTURE_NOW,
    options: builtOptions ?? resolveOptionValues(frame.options, rackOptions, capOptions),
  }
}

function capState(spec: CapSpec | undefined, anyHave: boolean, rackOptions: OptionValues) {
  const have = spec?.have ?? anyHave
  return {
    ...(spec?.options ? { options: spec.options } : {}),
    ...(have
      ? { have: capSnapshot(KWS_FRAME, rackOptions, spec?.options, spec?.builtOptions) }
      : {}),
  }
}

/**
 * A KWS plan: sections `sec-1`, `sec-2`, ... bottom -> top. Have sections get snapshots of their
 * resolved options; caps are captured when any section is Have unless the cap spec says otherwise.
 */
export function kwsPlan(spec: KwsPlanSpec = {}): Plan {
  const rackOptions = spec.rackOptions ?? {}
  const sectionSpecs = (spec.sections ?? []).map(sectionSpec)
  const anyHave = sectionSpecs.some((section) => section.have === true)
  const sections = sectionSpecs.map((section, index) => {
    const planned = {
      id: `sec-${index + 1}`,
      typeId: `s${section.u}`,
      ...(section.options ? { options: section.options } : {}),
    }
    if (section.have !== true) return planned
    const have = sectionSnapshot(KWS_FRAME, rackOptions, planned, section.builtOptions)
    return { ...planned, have }
  })
  const input: PlanInput = {
    schema: 1,
    id: 'plan-fixture',
    rackId: 'rack-fixture',
    name: 'KWS fixture plan',
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    frame: {
      frameId: KWS_FRAME_ID,
      options: rackOptions,
      caps: {
        top: capState(spec.top, anyHave, rackOptions),
        bottom: capState(spec.bottom, anyHave, rackOptions),
      },
      sections,
    },
    placements: spec.placements ?? [],
    equipment: spec.equipment ?? [],
    extras: spec.extras ?? [],
    retired: spec.retired ?? [],
    ...(spec.custom ? { custom: spec.custom } : {}),
  }
  return PlanSchema.parse(input)
}

/** Marks every section, cap, placement, device and extra as Have (as the user would after building). */
export function markEverythingHave(plan: Plan, frame: Frame = KWS_FRAME): Plan {
  const rackOptions = plan.frame.options
  const sections = plan.frame.sections.map((section) => ({
    ...section,
    have: sectionSnapshot(frame, rackOptions, section),
  }))
  const capWithHave = (cap: Plan['frame']['caps']['top']) => ({
    ...cap,
    have: capSnapshot(frame, rackOptions, cap.options),
  })
  return {
    ...plan,
    frame: {
      ...plan.frame,
      sections,
      caps: { top: capWithHave(plan.frame.caps.top), bottom: capWithHave(plan.frame.caps.bottom) },
    },
    placements: plan.placements.map((placement) => ({
      ...placement,
      have: { at: FIXTURE_NOW, itemId: placement.itemId, options: { ...placement.options } },
      devices: placement.devices.map((device) => ({ ...device, have: true })),
    })),
    equipment: plan.equipment.map((entry) => ({ ...entry, have: true })),
    extras: plan.extras.map((extra) => ({ ...extra, haveQty: extra.qty })),
  }
}
