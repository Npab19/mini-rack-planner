/**
 * Fixtures for the mount chooser, "Needs a mount?" and the equipment tray's tests: the editor's
 * fixture catalog plus copies of the catalog's generic shelves, and the user's built 9U with the
 * front filled up to U7. Illustrative fixture values, not catalog facts (the shelf sizes copy
 * catalog/items/generic-shelf-*.json as of 2026-10-11).
 */
import type { CatalogEntry, CatalogLookup, Device } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import { EDITOR_IDS, editorCatalog, placementAt } from '@/domain/__fixtures__/editorFixtures'
import { kwsPlan, parseEntries, type KwsPlanSpec } from '@/domain/__fixtures__/kws'

const VERIFIED = { by: 'fixture', date: '2026-10-11', method: 'unverified' }

/** Copies of the catalog's generic 1U and 2U shelves. */
export const GENERIC_SHELVES: readonly CatalogEntry[] = parseEntries(
  [
    { id: 'generic-shelf-1u', name: 'Shelf 1U', u: 6, maxH: 38, yMm: 3, holes: [6.35, 38.1] },
    { id: 'generic-shelf-2u', name: 'Shelf 2U', u: 12, maxH: 80, yMm: 4, holes: undefined },
  ].map((shelf) => ({
    kind: 'item',
    id: shelf.id,
    name: shelf.name,
    category: 'shelf',
    source: { platform: 'other', url: 'https://example.com/mini-rack-fixtures/generic-shelf' },
    verified: VERIFIED,
    heightSixths: shelf.u,
    depthMm: 205,
    mount: {
      front: 4,
      ...(shelf.holes === undefined ? {} : { holeOffsetsMm: shelf.holes }),
      clearance: 'M6',
    },
    slots: [
      {
        id: 'shelf',
        label: 'Shelf',
        kind: 'area',
        maxW: 210,
        maxD: 200,
        maxH: shelf.maxH,
        layout: { xMm: 6, yMm: shelf.yMm, zMm: 0 },
      },
    ],
  })),
)

/** The editor's fixture catalog with the generic shelves (and `extra` entries). */
export function mountCatalog(extra: readonly CatalogEntry[] = []): CatalogLookup {
  return editorCatalog([...GENERIC_SHELVES, ...extra])
}

export function fixtureDevice(catalog: CatalogLookup, id: string): Device {
  const found = catalog.device(id)
  if (found === undefined) throw new Error(`No device "${id}"`)
  return found
}

/**
 * The user's built 3U + 6U (sections captured as Have) with 1U blanks at U1–U`blanks` on the
 * front (default U1–U7, leaving U8 and U9 free).
 */
export function builtRack(spec: KwsPlanSpec & { blanks?: number } = {}): Plan {
  const { blanks = 7, ...rest } = spec
  const catalog = mountCatalog()
  return kwsPlan({
    sections: [
      { u: 3, have: true },
      { u: 6, have: true },
    ],
    placements: Array.from({ length: blanks }, (_, index) =>
      placementAt(catalog, `pl-blank-${index + 1}`, EDITOR_IDS.blank1u, index * 6),
    ),
    ...rest,
  })
}
