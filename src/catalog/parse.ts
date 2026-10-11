/**
 * Turns catalog JSON documents into validated entries. The app loader (`import.meta.glob`), Node
 * scripts (scripts/lib/catalogFs.ts) and tests all go through here, so it does no I/O.
 */
import {
  CatalogEntrySchema,
  type CatalogEntry,
  type CatalogKind,
  type CatalogLookup,
} from '../domain/schema/catalog'
import { checkEntryIntegrity } from '../domain/schema/integrity'
import { createLookup, isCustomId } from './resolver'
import { catalogRevision } from './revision'

/** Entry folders under `catalog/` and the kinds each one holds. */
export const ENTRY_FOLDERS: Readonly<Record<string, readonly CatalogKind[]>> = {
  frames: ['frame'],
  items: ['item', 'extra'],
  devices: ['device'],
  hardware: ['hardware'],
}

export interface CatalogDocument {
  /** Path inside `catalog/` with forward slashes, e.g. "frames/kws-rack-v2.json". */
  path: string
  /** The parsed JSON. */
  data: unknown
}

export interface CatalogProblem {
  /** Path inside `catalog/` of the file the problem is in. */
  path: string
  message: string
}

export interface ParsedEntry {
  path: string
  entry: CatalogEntry
  /** The document as written, before schema defaults. */
  raw: unknown
}

export interface LoadedCatalog {
  lookup: CatalogLookup
  entries: readonly CatalogEntry[]
  /** Stable hash of every loaded entry (see `catalogRevision`). */
  revision: string
  /** Files that were skipped, with the reasons. Empty for a healthy catalog. */
  errors: readonly CatalogProblem[]
}

const ENTRY_PATH = /^([^/]+)\/([^/]+)\.json$/

/** Folder and file name (without `.json`) of an entry file; undefined for any other path. */
export function entryPathParts(path: string): { folder: string; name: string } | undefined {
  const match = ENTRY_PATH.exec(path)
  const folder = match?.[1]
  const name = match?.[2]
  if (folder === undefined || name === undefined || !Object.hasOwn(ENTRY_FOLDERS, folder)) {
    return undefined
  }
  return { folder, name }
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  let text = ''
  for (const segment of path) {
    if (typeof segment === 'number') text += `[${segment}]`
    else text += text === '' ? String(segment) : `.${String(segment)}`
  }
  return text
}

function placementProblems(entry: CatalogEntry, folder: string, name: string): string[] {
  const problems: string[] = []
  const kinds = ENTRY_FOLDERS[folder] ?? []
  if (!kinds.includes(entry.kind)) {
    const home = Object.keys(ENTRY_FOLDERS).find((key) => ENTRY_FOLDERS[key]?.includes(entry.kind))
    problems.push(`kind "${entry.kind}" does not belong in ${folder}/ (move it to ${home}/)`)
  }
  if (isCustomId(entry.id)) {
    problems.push(
      `"custom:" ids are for private parts; the shared catalog uses plain kebab-case ids`,
    )
  } else if (entry.id !== name) {
    problems.push(`id "${entry.id}" must match the file name (${name}.json)`)
  }
  return problems
}

/**
 * Validates one document: schema, kind vs folder, id vs file name and the entry's own integrity
 * rules. Cross-entry references are checked by `npm run validate-catalog`.
 */
export function parseCatalogDocument(doc: CatalogDocument): {
  entry?: CatalogEntry
  problems: string[]
} {
  const parts = entryPathParts(doc.path)
  if (parts === undefined) {
    const folders = Object.keys(ENTRY_FOLDERS).join('/, ')
    return { problems: [`not an entry file: entries live in ${folders}/ as <id>.json`] }
  }
  const result = CatalogEntrySchema.safeParse(doc.data)
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const at = formatIssuePath(issue.path)
      return at === '' ? issue.message : `${at}: ${issue.message}`
    })
    return { problems }
  }
  const entry = result.data
  const problems = [
    ...placementProblems(entry, parts.folder, parts.name),
    ...checkEntryIntegrity(entry),
  ]
  return problems.length > 0 ? { problems } : { entry, problems }
}

/** Validates every document; a file with any problem is skipped, and the first of two equal ids wins. */
export function parseCatalogDocuments(docs: readonly CatalogDocument[]): {
  parsed: ParsedEntry[]
  problems: CatalogProblem[]
} {
  const parsed: ParsedEntry[] = []
  const problems: CatalogProblem[] = []
  const pathById = new Map<string, string>()
  const sorted = docs.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const doc of sorted) {
    const result = parseCatalogDocument(doc)
    for (const message of result.problems) problems.push({ path: doc.path, message })
    const entry = result.entry
    if (entry === undefined) continue
    const firstPath = pathById.get(entry.id)
    if (firstPath !== undefined) {
      problems.push({ path: doc.path, message: `id "${entry.id}" is already used by ${firstPath}` })
      continue
    }
    pathById.set(entry.id, doc.path)
    parsed.push({ path: doc.path, entry, raw: doc.data })
  }
  return { parsed, problems }
}

export function loadCatalogFromDocuments(docs: readonly CatalogDocument[]): LoadedCatalog {
  const { parsed, problems } = parseCatalogDocuments(docs)
  const entries = parsed.map((item) => item.entry)
  return {
    lookup: createLookup(entries),
    entries,
    revision: catalogRevision(parsed.map((item) => ({ id: item.entry.id, raw: item.raw }))),
    errors: problems,
  }
}
