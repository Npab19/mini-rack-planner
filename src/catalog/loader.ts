/**
 * The catalog bundled with the app: every entry file in catalog/{frames,items,devices,hardware},
 * imported at build time. This is the only module that uses `import.meta.glob`.
 *
 * The glob names the four entry folders instead of `catalog/**`, so generated JSON Schemas
 * (catalog/schema), alignment records (catalog/alignments) and catalog/replaced.json stay out.
 */
import { loadCatalogFromDocuments, type CatalogDocument, type LoadedCatalog } from './parse'

export type { CatalogProblem, LoadedCatalog } from './parse'

const MODULE_PREFIX = '/catalog/'

/** Builds a catalog from JSON modules keyed by module path, e.g. "/catalog/frames/x.json". */
export function loadCatalogFromModules(modules: Readonly<Record<string, unknown>>): LoadedCatalog {
  const docs = Object.entries(modules).map(([modulePath, data]): CatalogDocument => ({
    path: modulePath.startsWith(MODULE_PREFIX)
      ? modulePath.slice(MODULE_PREFIX.length)
      : modulePath,
    data,
  }))
  return loadCatalogFromDocuments(docs)
}

let bundled: LoadedCatalog | undefined

/** The bundled catalog, validated once. Files that fail validation are skipped and listed in `errors`. */
export function loadBundledCatalog(): LoadedCatalog {
  bundled ??= loadCatalogFromModules(
    import.meta.glob<unknown>('/catalog/{frames,items,devices,hardware}/*.json', {
      eager: true,
      import: 'default',
    }),
  )
  return bundled
}
