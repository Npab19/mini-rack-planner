/**
 * Small in-memory catalog for src/catalog tests. Logic tests never read catalog/, so curating
 * the real entries cannot change what these tests expect. Values are illustrative.
 */
import { CatalogEntrySchema, type CatalogEntry } from '../../domain/schema/catalog'

export const VERIFIED = { by: 'test', date: '2026-10-11', method: 'page' } as const

const designSource = (modelId: string) => ({
  platform: 'makerworld',
  url: `https://makerworld.com/en/models/${modelId}`,
  modelId,
  designer: 'Test Designer',
  license: 'Standard Digital File License',
})
const vendorSource = { platform: 'vendor', url: 'https://example.com/spec' }

export function rawHardware(
  id: string,
  name: string,
  category: string,
  spec: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: 'hardware',
    id,
    name,
    category,
    spec,
    source: vendorSource,
    verified: VERIFIED,
    ...extra,
  }
}

export const RAW_FRAME = {
  kind: 'frame',
  id: 'test-frame',
  name: 'Test frame',
  source: designSource('100'),
  verified: VERIFIED,
  standard: { panelWidthMm: 254, innerWidthMm: 222, depthMm: 250, rearOpen: true },
  rail: { earSpacingMm: 236.525, holeOffsetsPerUMm: [6.35, 22.225, 38.1], holeTolMm: 1 },
  equipmentFastener: {
    thread: 'M5',
    perHole: 'screw',
    screwIds: ['screw-m5x10-shcs'],
    engagementMm: 6,
  },
  sectionTypes: [{ id: 's3', label: '3U section', heightU: 3 }],
  stack: { minU: 3, maxU: 12 },
  options: [
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
      id: 'leg',
      plate: 'Legs',
      label: 'Leg',
      pieces: [{ partId: 'leg', perPrint: 1 }],
      embeds: [{ hardwareId: 'insert-m5x8x7', perPrint: 9 }],
    },
  ],
  recipe: [
    { id: 'legs', unit: 'section', ref: { print: 'leg' }, count: 4 },
    { id: 'bolts', unit: 'section', ref: { hardware: 'screw-m6x8-shcs' }, count: 8 },
  ],
  parts3d: [{ id: 'leg', label: 'Leg', role: 'leg', envelopeMm: { w: 20, d: 20, h: 133.35 } }],
}

export const RAW_DEVICE = {
  kind: 'device',
  id: 'lenovo-m720q',
  brand: 'Lenovo',
  model: 'ThinkCentre M720q Tiny',
  category: 'mini-pc',
  dims: { w: 179, d: 183, h: 34.5 },
  source: vendorSource,
  verified: VERIFIED,
}

export const RAW_MOUNT = {
  kind: 'item',
  id: 'lenovo-tiny-mount',
  name: 'Lenovo Tiny mount 1U',
  category: 'mount',
  source: designSource('200'),
  verified: VERIFIED,
  heightSixths: 6,
  depthMm: 190,
  mount: { front: 4 },
  prints: [{ id: 'mount', plate: 'All plates', label: 'Lenovo Tiny mount' }],
  recipe: [{ id: 'mount', unit: 'item', ref: { print: 'mount' }, count: 1 }],
  slots: [
    {
      id: 'pc',
      kind: 'fixed',
      maxW: 180,
      maxD: 184,
      maxH: 36,
      accepts: { deviceIds: ['lenovo-m720q'] },
      layout: { xMm: 21, yMm: 4, zMm: 0 },
    },
  ],
  compat: { frames: ['test-frame'] },
}

export const RAW_SHELF = {
  kind: 'item',
  id: 'shelf-1u',
  name: 'Shelf 1U',
  category: 'shelf',
  source: designSource('300'),
  verified: VERIFIED,
  heightSixths: 6,
  depthMm: 205,
  mount: { front: 4 },
  slots: [{ id: 'shelf', kind: 'area', maxW: 210, maxD: 200, layout: { xMm: 6, yMm: 3, zMm: 0 } }],
}

export const RAW_HARDWARE = [
  rawHardware(
    'screw-m5x10-shcs',
    'M5×10 socket head cap screw',
    'screw',
    { thread: 'M5', lengthMm: 10, head: 'shcs' },
    { aliases: ['M5x10 SHCS', 'DIN 912 M5x10'], packSizes: [10, 50] },
  ),
  rawHardware('screw-m6x8-shcs', 'M6×8 socket head cap screw', 'screw', {
    thread: 'M6',
    lengthMm: 8,
    head: 'shcs',
  }),
  rawHardware('insert-m5x8x7', 'M5 heat-set insert (M5x8x7)', 'insert', { thread: 'M5' }),
  rawHardware('nut-m6-hex', 'M6 hex nut', 'nut', { thread: 'M6', head: 'hex' }),
]

/** Module paths as `import.meta.glob` returns them, mapped to the documents. */
export function testModules(): Record<string, unknown> {
  const modules: Record<string, unknown> = {
    '/catalog/frames/test-frame.json': RAW_FRAME,
    '/catalog/devices/lenovo-m720q.json': RAW_DEVICE,
    '/catalog/items/lenovo-tiny-mount.json': RAW_MOUNT,
    '/catalog/items/shelf-1u.json': RAW_SHELF,
  }
  for (const hardware of RAW_HARDWARE)
    modules[`/catalog/hardware/${String(hardware.id)}.json`] = hardware
  return modules
}

/** The same entries, parsed. */
export function testEntries(): CatalogEntry[] {
  return Object.values(testModules()).map((raw) => CatalogEntrySchema.parse(raw))
}
