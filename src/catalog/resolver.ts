/**
 * Catalog lookups: the bundled catalog plus the user's private parts.
 */
import {
  catalogBundle,
  createCatalogLookup,
  withCustomEntries,
  type CatalogEntry,
  type CatalogLookup,
  type CustomEntries,
} from '../domain/schema/catalog'
import { isCustomId } from '../domain/schema/common'

/** Private parts (a plan's own entries and the user's library) use `custom:` ids. */
export { CUSTOM_ID_PREFIX, isCustomId } from '../domain/schema/common'

export function createLookup(entries: Iterable<CatalogEntry>): CatalogLookup {
  return createCatalogLookup(catalogBundle(entries))
}

/** Groups a flat list of entries (such as library rows) the way `plan.custom` stores them. */
export function groupCustomEntries(entries: Iterable<CatalogEntry>): CustomEntries {
  const bundle = catalogBundle(entries)
  return {
    frames: [...bundle.frames.values()],
    items: [...bundle.items.values()],
    devices: [...bundle.devices.values()],
    hardware: [...bundle.hardware.values()],
  }
}

function customOnly(source: Partial<CustomEntries> | undefined): CustomEntries {
  const keep = <T extends { id: string }>(entries: readonly T[] | undefined): T[] =>
    (entries ?? []).filter((entry) => isCustomId(entry.id))
  return {
    frames: keep(source?.frames),
    items: keep(source?.items),
    devices: keep(source?.devices),
    hardware: keep(source?.hardware),
  }
}

/**
 * The lookup the app works with, lowest priority first: the bundled catalog, the user's library,
 * then the plan's own entries. The plan wins so it computes the same BOM on every device and in
 * share links, where the library is absent. Only `custom:` ids are taken from the library and the
 * plan, so neither can shadow a curated entry.
 */
export function mergeLookups(
  base: CatalogLookup,
  planCustom?: Partial<CustomEntries>,
  library?: Partial<CustomEntries>,
): CatalogLookup {
  return withCustomEntries(withCustomEntries(base, customOnly(library)), customOnly(planCustom))
}
