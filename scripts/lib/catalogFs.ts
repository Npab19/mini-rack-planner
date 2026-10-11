/**
 * Reads the shared catalog from disk for Node scripts and tests (`npm run validate-catalog`,
 * `npm run bom`, src/domain/kws.data.test.ts). The app bundles the same files with
 * `import.meta.glob` (src/catalog/loader.ts); both go through src/catalog/parse.ts, so they load
 * the same entries and compute the same revision.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  entryPathParts,
  loadCatalogFromDocuments,
  type CatalogDocument,
  type CatalogProblem,
  type LoadedCatalog,
} from '../../src/catalog/parse'

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const CATALOG_DIR = join(REPO_ROOT, 'catalog')

/** Every file under `dir`, as sorted paths relative to it with forward slashes. */
export function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((dirent) => dirent.isFile())
    .map((dirent) => relative(dir, join(dirent.parentPath, dirent.name)).split(sep).join('/'))
    .toSorted()
}

const BYTE_ORDER_MARK = 0xfeff

/** Drops a UTF-8 byte order mark, which JSON.parse rejects (Vite's JSON import ignores it). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text
}

export type JsonReadResult = { ok: true; data: unknown } | { ok: false; error: string }

export function readJsonFile(path: string): JsonReadResult {
  try {
    return { ok: true, data: JSON.parse(stripBom(readFileSync(path, 'utf8'))) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface CatalogDiskOptions {
  /** Defaults to the repository's catalog/ folder. */
  catalogDir?: string
  /** Loads only the entry files this returns true for (paths like "frames/kws-rack-v2.json"). */
  include?: (path: string) => boolean
}

/** The JSON documents in the entry folders (frames/, items/, devices/, hardware/). */
export function readEntryDocuments(options: CatalogDiskOptions = {}): {
  documents: CatalogDocument[]
  problems: CatalogProblem[]
} {
  const catalogDir = options.catalogDir ?? CATALOG_DIR
  const include = options.include ?? (() => true)
  const documents: CatalogDocument[] = []
  const problems: CatalogProblem[] = []
  for (const path of listFiles(catalogDir)) {
    if (entryPathParts(path) === undefined || !include(path)) continue
    const result = readJsonFile(join(catalogDir, path))
    if (result.ok) documents.push({ path, data: result.data })
    else problems.push({ path, message: `invalid JSON: ${result.error}` })
  }
  return { documents, problems }
}

/** The catalog as the app would load it; files that fail validation are listed in `errors`. */
export function loadCatalogFromDisk(options: CatalogDiskOptions = {}): LoadedCatalog {
  const { documents, problems } = readEntryDocuments(options)
  const loaded = loadCatalogFromDocuments(documents)
  return { ...loaded, errors: [...problems, ...loaded.errors] }
}
