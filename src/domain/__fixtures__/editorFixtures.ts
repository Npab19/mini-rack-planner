/**
 * Editor fixtures (M3a) on top of the frozen KWS fixture (`kws.ts`): the user's gear for the
 * Have/Need and "Equipment to fit" tests (a Synology DS224+ and a KWS-only 4U module for it, a
 * generic NAS shelf, a mount for another frame, a half-width SBC mount) and devices that exercise
 * slot orientations and estimates. Illustrative fixture values, not measurements or catalog facts.
 */
import type { z } from 'zod'
import { resolvePlaceable } from '../placement'
import type { CatalogEntry, CatalogLookup } from '../schema/catalog'
import type { PlacementSchema } from '../schema/plan'
import { kwsCatalog, parseEntries } from './kws'

const VERIFIED = { by: 'fixture', date: '2026-10-11', method: 'page' } as const
const SOURCE = (slug: string) => ({
  platform: 'other' as const,
  url: `https://example.com/mini-rack-fixtures/${slug}`,
})

/** Ids the editor tests assert on (the KWS fixture's own ids are in `KWS_IDS`). */
export const EDITOR_IDS = {
  ds224: 'synology-ds224-plus',
  ds224Module: 'kws-ds224-module-4u',
  nasShelf: 'nas-shelf-3u',
  otherFrameMount: 'lab-rax-nas-mount',
  sbcHalf: 'sbc-half-mount',
  rotatedMiniPc: 'rotated-mini-pc',
  bigMiniPc: 'big-mini-pc',
  wideBox: 'wide-box',
  towerUps: 'tower-ups',
  // From kws.ts
  m720q: 'lenovo-m720q',
  tinyMount: 'lenovo-tiny-mount',
  shelf2u: 'shelf-2u',
  blank1u: 'blank-1u',
  rubberFeet: 'rubber-feet',
  pdu: 'pdu-4',
  rpi5: 'rpi-5',
  nas2bay: 'nas-2bay',
} as const

const ITEMS = [
  {
    kind: 'item',
    id: EDITOR_IDS.ds224Module,
    name: 'KWS DS224+ module 4U',
    category: 'nas-mount',
    source: SOURCE('kws-ds224-module'),
    verified: VERIFIED,
    heightSixths: 24,
    depthMm: 240,
    mount: { front: 4, holeOffsetsMm: [6.35, 171.45], clearance: 'M5', earThicknessMm: 4 },
    compat: { frames: ['kws-rack-v2'] },
    slots: [
      {
        id: 'cradle',
        label: 'DS224+ cradle',
        kind: 'fixed',
        maxW: 112,
        maxD: 236,
        maxH: 168,
        orientations: ['flat'],
        accepts: { deviceIds: ['synology-ds224-plus'] },
        layout: { xMm: 55, yMm: 4, zMm: 0 },
      },
    ],
    prints: [
      {
        id: 'module',
        plate: 'DS224+ module',
        label: 'DS224+ module',
        material: 'PETG',
        gramsPerPrint: 320,
        minutesPerPrint: 600,
      },
    ],
    recipe: [{ id: 'module', unit: 'item', ref: { print: 'module' }, count: 1 }],
  },
  {
    kind: 'item',
    id: EDITOR_IDS.nasShelf,
    name: 'NAS shelf 3U',
    category: 'shelf',
    source: SOURCE('nas-shelf-3u'),
    verified: VERIFIED,
    heightSixths: 18,
    depthMm: 245,
    mount: { front: 4, clearance: 'M5' },
    options: [
      { id: 'lip', label: 'Front lip', scope: 'item', kind: 'boolean', default: true },
      {
        id: 'feet',
        label: 'Feet',
        scope: 'item',
        kind: 'choice',
        choices: [
          { id: 'none', label: 'None' },
          { id: 'rubber', label: 'Rubber feet' },
        ],
        default: 'none',
      },
    ],
    slots: [
      {
        id: 'deck',
        label: 'NAS deck',
        kind: 'area',
        maxW: 215,
        maxD: 240,
        maxH: 120,
        orientations: ['on-side'],
        accepts: { categories: ['nas'] },
        layout: { xMm: 3, yMm: 5, zMm: 0 },
      },
    ],
  },
  {
    kind: 'item',
    id: EDITOR_IDS.otherFrameMount,
    name: 'Lab Rax NAS mount',
    category: 'nas-mount',
    source: SOURCE('lab-rax-nas-mount'),
    verified: VERIFIED,
    heightSixths: 12,
    depthMm: 240,
    mount: { front: 4 },
    compat: { frames: ['lab-rax'] },
    slots: [
      {
        id: 'bay',
        kind: 'fixed',
        maxW: 120,
        maxD: 240,
        maxH: 170,
        accepts: { categories: ['nas'] },
        layout: { xMm: 50, yMm: 2, zMm: 0 },
      },
    ],
  },
  {
    kind: 'item',
    id: EDITOR_IDS.sbcHalf,
    name: 'Half-width SBC mount',
    category: 'sbc-mount',
    source: SOURCE('sbc-half-mount'),
    verified: VERIFIED,
    heightSixths: 6,
    bay: 'half',
    depthMm: 100,
    mount: { front: 2, holeOffsetsMm: [6.35, 38.1] },
    slots: [
      {
        id: 'board',
        kind: 'fixed',
        maxW: 100,
        maxD: 100,
        maxH: 30,
        accepts: { categories: ['sbc'] },
        layout: { xMm: 5, yMm: 3, zMm: 0 },
      },
    ],
  },
]

const DEVICES = [
  {
    id: EDITOR_IDS.ds224,
    brand: 'Synology',
    model: 'DiskStation DS224+',
    category: 'nas',
    dims: { w: 108, d: 232.2, h: 165 },
    power: {
      typW: 15,
      maxW: 30,
      input: { kind: 'dc', brick: { outputW: 60, included: true, plug: 'c7' } },
    },
  },
  // Fits the Lenovo Tiny mount's cradle only when turned (185 wide, 182 mm cradle).
  {
    id: EDITOR_IDS.rotatedMiniPc,
    brand: 'Fixture',
    model: 'Square mini PC',
    category: 'mini-pc',
    dims: { w: 185, d: 175, h: 30 },
  },
  {
    id: EDITOR_IDS.bigMiniPc,
    brand: 'Fixture',
    model: 'Big mini PC',
    category: 'mini-pc',
    dims: { w: 190, d: 190, h: 40 },
  },
  // Too wide for the 2U shelf flat (215 mm deck), fits turned.
  {
    id: EDITOR_IDS.wideBox,
    brand: 'Fixture',
    model: 'Wide box',
    category: 'other',
    dims: { w: 230, d: 150, h: 40 },
  },
  // Deeper than every shelf: only an estimate is possible.
  {
    id: EDITOR_IDS.towerUps,
    brand: 'Fixture',
    model: 'Tower UPS',
    category: 'ups',
    dims: { w: 150, d: 300, h: 230 },
  },
].map((entry) => ({ kind: 'device', verified: VERIFIED, ...entry }))

/** The editor's extra entries, parsed. */
export const EDITOR_ENTRIES: readonly CatalogEntry[] = parseEntries([...ITEMS, ...DEVICES])

/** The KWS fixture catalog plus the editor's entries (and `overrides`). */
export function editorCatalog(overrides: readonly CatalogEntry[] = []): CatalogLookup {
  return kwsCatalog([...EDITOR_ENTRIES, ...overrides])
}

type PlacementInput = z.input<typeof PlacementSchema>

/**
 * A placement input for `kwsPlan`, with the name and height denormalized from the catalog as
 * `addPlacement` stores them.
 */
export function placementAt(
  catalog: CatalogLookup,
  id: string,
  itemId: string,
  y: number,
  rest: Partial<PlacementInput> = {},
): PlacementInput {
  const placeable = resolvePlaceable(catalog, itemId)
  return {
    id,
    itemId,
    y,
    ...(placeable === undefined
      ? {}
      : { name: placeable.name, heightSixths: placeable.heightSixths }),
    ...rest,
  }
}
