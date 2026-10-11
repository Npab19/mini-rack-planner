/**
 * Frozen fixture catalog and the KWS 9U -> 12U sample plan for domain tests.
 *
 * The numbers are test approximations, not curated catalog facts: logic tests run on this
 * fixture and never read `catalog/`.
 *
 * Sample: KWS v2 stack [3U Have, 6U Have, 3U Need] (the user's built 9U plus one 3U on top),
 * six placements with devices, two unplaced devices, a spare blank panel and a custom NAS.
 */
import {
  CatalogEntrySchema,
  catalogBundle,
  createCatalogLookup,
  type CatalogEntry,
  type CatalogLookup,
} from '../schema/catalog'
import { PlanSchema, type Plan } from '../schema/plan'

export const SAMPLE_TIME = '2026-10-11T09:30:00.000Z'

const verified = { by: 'fixture', date: '2026-10-11', method: 'unverified' }
const ALL_CORNERS = ['fl', 'fr', 'rl', 'rr']

function exampleSource(slug: string): { platform: string; url: string } {
  return { platform: 'other', url: `https://example.com/mini-rack/${slug}` }
}

// ---------------------------------------------------------------------------------------------
// Catalog

const kwsFrame = {
  kind: 'frame',
  id: 'kws-v2',
  name: 'KWS Rack v2 (fixture)',
  source: {
    platform: 'makerworld',
    url: 'https://makerworld.com/en/models/2139130',
    modelId: '2139130',
  },
  verified,
  standard: { panelWidthMm: 254, innerWidthMm: 222, depthMm: 230, rearOpen: true },
  rail: { earSpacingMm: 236.525, holeOffsetsPerUMm: [6.35, 22.225, 38.1], holeTolMm: 0.5 },
  equipmentFastener: { thread: 'M5', perHole: 'screw', screwIds: ['m5x10-shcs'], engagementMm: 5 },
  sectionTypes: [
    { id: 's3', label: '3U section', heightU: 3 },
    { id: 's6', label: '6U section', heightU: 6 },
  ],
  stack: { minU: 3, maxU: 30, joint: { gapMm: 0, deadSixths: 0 } },
  options: [
    { id: 'magnets', label: 'Magnets', scope: 'section', kind: 'boolean', default: true },
    {
      id: 'top',
      label: 'Top',
      scope: 'top',
      kind: 'choice',
      choices: [
        { id: 'handle', label: 'Handles' },
        { id: 'flat', label: 'Flat top' },
      ],
      default: 'handle',
    },
    {
      id: 'deep',
      label: '320 mm-deep connectors',
      scope: 'rack',
      kind: 'boolean',
      default: false,
      effects: { depthMm: 320 },
    },
  ],
  parts3d: [
    { id: 'leg-3u', label: '3U leg', role: 'leg', envelopeMm: { w: 24, d: 24, h: 133.35 } },
    { id: 'leg-6u', label: '6U leg', role: 'leg', envelopeMm: { w: 24, d: 24, h: 266.7 } },
    {
      id: 'connector',
      label: 'Frame connector',
      role: 'connector',
      envelopeMm: { w: 30, d: 30, h: 12 },
    },
    { id: 'top-handle', label: 'Top handle', role: 'cap', envelopeMm: { w: 24, d: 200, h: 30 } },
    { id: 'top-flat', label: 'Flat top', role: 'cap', envelopeMm: { w: 250, d: 230, h: 6 } },
    { id: 'base-leg', label: 'Base leg', role: 'leg', envelopeMm: { w: 30, d: 30, h: 20 } },
  ],
  // Each rule describes the front-left instance; the other corners mirror it (see assembly.ts).
  assembly3d: [
    {
      partId: 'leg-3u',
      at: 'section',
      sectionTypes: ['s3'],
      corners: ALL_CORNERS,
      transform: { offsetMm: [12, 0, -12], mirrorX: true },
    },
    {
      partId: 'leg-6u',
      at: 'section',
      sectionTypes: ['s6'],
      corners: ALL_CORNERS,
      transform: { offsetMm: [12, 0, -12], mirrorX: true },
    },
    {
      partId: 'connector',
      at: 'joint',
      corners: ALL_CORNERS,
      transform: { offsetMm: [12, -6, -12] },
    },
    {
      partId: 'top-handle',
      at: 'top',
      corners: ['fl', 'fr'],
      transform: { offsetMm: [12, 0, -115], mirrorX: true },
      when: { option: { top: 'handle' } },
    },
    {
      partId: 'top-flat',
      at: 'top',
      transform: { offsetMm: [0, 0, -115] },
      when: { option: { top: 'flat' } },
    },
    {
      partId: 'base-leg',
      at: 'bottom',
      corners: ALL_CORNERS,
      transform: { offsetMm: [12, -20, -12] },
    },
  ],
}

const items = [
  {
    kind: 'item',
    id: 'kws-power-strip-1u',
    name: 'Power strip 1U',
    category: 'power',
    source: exampleSource('power-strip-1u'),
    verified,
    heightSixths: 6,
    depthMm: 60,
    mount: { front: 4 },
    render: { style: 'power' },
  },
  {
    kind: 'item',
    id: 'kws-tiny-mount-1u',
    name: 'Lenovo Tiny mount 1U',
    category: 'mount',
    source: exampleSource('tiny-mount-1u'),
    verified,
    heightSixths: 6,
    depthMm: 190,
    mount: { front: 4 },
    render: { style: 'tray' },
    slots: [
      {
        id: 'cradle',
        kind: 'fixed',
        maxW: 182,
        maxD: 186,
        maxH: 38,
        orientations: ['flat'],
        accepts: { categories: ['mini-pc'] },
        layout: { xMm: 20, yMm: 3, zMm: -2 },
      },
    ],
  },
  {
    kind: 'item',
    id: 'kws-shelf-2u',
    name: 'Shelf 2U',
    category: 'shelf',
    source: exampleSource('shelf-2u'),
    verified,
    heightSixths: 12,
    depthMm: 200,
    mount: { front: 4 },
    render: { style: 'shelf' },
    slots: [
      {
        id: 'deck',
        kind: 'area',
        maxW: 210,
        maxD: 195,
        maxH: 82,
        layout: { xMm: 6, yMm: 3, zMm: -2 },
      },
    ],
  },
  {
    kind: 'item',
    id: 'kws-patch-panel-1u',
    name: 'Keystone patch panel 1U',
    category: 'panel',
    source: exampleSource('patch-panel-1u'),
    verified,
    heightSixths: 6,
    depthMm: 30,
    mount: { front: 4 },
    render: { style: 'keystone' },
  },
  {
    kind: 'item',
    id: 'kws-nas-tray-2u',
    name: 'NAS tray 2U',
    category: 'tray',
    source: exampleSource('nas-tray-2u'),
    verified,
    heightSixths: 12,
    depthMm: 225,
    mount: { front: 4 },
    requiresRearSupport: true,
    render: { style: 'tray' },
    slots: [
      {
        id: 'bay',
        kind: 'fixed',
        maxW: 200,
        maxD: 220,
        maxH: 82,
        orientations: ['flat', 'flat-rotated'],
        layout: { xMm: 11, yMm: 3, zMm: -2 },
      },
    ],
  },
  {
    kind: 'item',
    id: 'kws-blank-1u',
    name: 'Blank panel 1U',
    category: 'panel',
    source: exampleSource('blank-1u'),
    verified,
    heightSixths: 6,
    depthMm: 4,
    mount: { front: 4 },
    render: { style: 'blank' },
  },
  {
    kind: 'extra',
    id: 'rubber-feet',
    name: 'Rubber feet',
    category: 'accessory',
    source: exampleSource('rubber-feet'),
    verified,
    heightSixths: 0,
    depthMm: 0,
  },
]

const devices = [
  {
    kind: 'device',
    id: 'lenovo-m920q',
    brand: 'Lenovo',
    model: 'ThinkCentre M920q',
    category: 'mini-pc',
    dims: { w: 179, d: 183, h: 34.5 },
    power: { typW: 15, input: { kind: 'dc', brick: { included: true, outputW: 65, plug: 'c5' } } },
    verified,
  },
  {
    kind: 'device',
    id: 'raspberry-pi-5',
    brand: 'Raspberry Pi',
    model: '5 (cased)',
    category: 'sbc',
    dims: { w: 94, d: 63, h: 30 },
    verified,
  },
  {
    kind: 'device',
    id: 'ubiquiti-usw-flex-mini',
    brand: 'Ubiquiti',
    model: 'USW Flex Mini',
    category: 'switch',
    dims: { w: 107, d: 70, h: 21 },
    verified,
  },
  {
    kind: 'device',
    id: 'mac-mini-m4',
    brand: 'Apple',
    model: 'Mac mini (M4)',
    category: 'mini-pc',
    dims: { w: 127, d: 127, h: 50 },
    verified,
  },
]

/** Every fixture catalog entry, parsed (defaults filled). */
export const SAMPLE_CATALOG_ENTRIES: readonly CatalogEntry[] = [kwsFrame, ...items, ...devices].map(
  (entry) => CatalogEntrySchema.parse(entry),
)

export function sampleCatalog(): CatalogLookup {
  return createCatalogLookup(catalogBundle(SAMPLE_CATALOG_ENTRIES))
}

// ---------------------------------------------------------------------------------------------
// Plan

/** The user's own device, carried by the plan (and by share links). */
const customNas = {
  kind: 'device',
  id: 'custom:diy-n100-nas',
  brand: 'DIY',
  model: 'N100 NAS',
  category: 'nas',
  dims: { w: 180, d: 200, h: 70 },
  weightG: 2400,
  power: {
    typW: 20,
    maxW: 45,
    input: { kind: 'dc', brick: { included: true, outputW: 60, plug: 'c7' } },
  },
  verified: { by: 'me', date: '2026-10-01', method: 'calipers' },
}

function owned(itemId: string): { at: string; itemId: string } {
  return { at: SAMPLE_TIME, itemId }
}

const samplePlanInput = {
  schema: 1,
  id: 'plan-kws-sample',
  rackId: 'rack-kws-sample',
  name: 'KWS 9U → 12U',
  notes: 'Built 3U + 6U. One more 3U on top for the NAS.',
  createdAt: SAMPLE_TIME,
  updatedAt: SAMPLE_TIME,
  rev: 12,
  catalogRev: 'fixture-1',
  frame: {
    frameId: 'kws-v2',
    options: { magnets: true },
    caps: {
      top: { options: { top: 'handle' }, have: { at: SAMPLE_TIME, options: { top: 'handle' } } },
      bottom: { have: { at: SAMPLE_TIME } },
    },
    sections: [
      {
        id: 'sec-bottom-3u',
        typeId: 's3',
        have: { at: SAMPLE_TIME, typeId: 's3', heightU: 3, options: { magnets: true } },
      },
      {
        id: 'sec-middle-6u',
        typeId: 's6',
        have: { at: SAMPLE_TIME, typeId: 's6', heightU: 6, options: { magnets: true } },
      },
      { id: 'sec-top-3u', typeId: 's3' },
    ],
  },
  placements: [
    {
      id: 'pl-power',
      itemId: 'kws-power-strip-1u',
      name: 'Power strip 1U',
      heightSixths: 6,
      y: 0,
      have: owned('kws-power-strip-1u'),
    },
    {
      id: 'pl-tiny-1',
      itemId: 'kws-tiny-mount-1u',
      name: 'Lenovo Tiny mount 1U',
      heightSixths: 6,
      y: 6,
      have: owned('kws-tiny-mount-1u'),
      label: 'Proxmox 1',
      devices: [
        {
          id: 'dev-tiny-1',
          deviceId: 'lenovo-m920q',
          slotId: 'cradle',
          orientation: 'flat',
          have: true,
        },
      ],
    },
    {
      id: 'pl-tiny-2',
      itemId: 'kws-tiny-mount-1u',
      name: 'Lenovo Tiny mount 1U',
      heightSixths: 6,
      y: 12,
      have: owned('kws-tiny-mount-1u'),
      label: 'Proxmox 2',
      devices: [{ id: 'dev-tiny-2', deviceId: 'lenovo-m920q', slotId: 'cradle', have: true }],
    },
    {
      id: 'pl-shelf',
      itemId: 'kws-shelf-2u',
      name: 'Shelf 2U',
      heightSixths: 12,
      y: 24,
      have: owned('kws-shelf-2u'),
      devices: [
        { id: 'dev-pi', deviceId: 'raspberry-pi-5', slotId: 'deck', have: true },
        { id: 'dev-switch', deviceId: 'ubiquiti-usw-flex-mini', slotId: 'deck', xMm: 100 },
      ],
    },
    {
      id: 'pl-patch',
      itemId: 'kws-patch-panel-1u',
      name: 'Keystone patch panel 1U',
      heightSixths: 6,
      y: 42,
      have: owned('kws-patch-panel-1u'),
    },
    {
      id: 'pl-nas',
      itemId: 'kws-nas-tray-2u',
      name: 'NAS tray 2U',
      heightSixths: 12,
      y: 54,
      options: {},
      devices: [{ id: 'dev-nas', deviceId: 'custom:diy-n100-nas', slotId: 'bay' }],
    },
  ],
  equipment: [
    { id: 'eq-mac', deviceId: 'mac-mini-m4', note: 'Maybe later' },
    { id: 'eq-pi', deviceId: 'raspberry-pi-5', have: true },
  ],
  extras: [{ id: 'ex-feet', itemId: 'rubber-feet', qty: 4, haveQty: 4 }],
  retired: [
    {
      id: 'ret-blank',
      kind: 'placement',
      snapshot: owned('kws-blank-1u'),
      sourceId: 'pl-old-blank',
    },
  ],
  custom: { devices: [customNas] },
}

/** A fresh copy of the sample plan on every call (parsing never shares objects). */
export function samplePlan(): Plan {
  return PlanSchema.parse(samplePlanInput)
}
