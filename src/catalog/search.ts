/**
 * Tokenised catalog search for the palette, the "Add a part" wizard and hardware pickers.
 *
 * Every query word must match the start of a word in the entry's name (devices: brand + model),
 * hardware aliases, category or id. Exact words and more important fields rank higher. Words are
 * also split at letter/digit boundaries, so "m5x10", "M5 x 10" and "M5×10" find the same screw.
 */
import {
  deviceName,
  type CatalogEntry,
  type CatalogKind,
  type CatalogLookup,
} from '../domain/schema/catalog'

export interface SearchFilters {
  /** One kind or several. Note that 'item' and 'extra' are separate kinds. */
  kind?: CatalogKind | readonly CatalogKind[]
  /** Item, device or hardware category. Frames have none, so a category filter excludes them. */
  category?: string | readonly string[]
  /** Hides items limited to other frames (`compat.frames`); everything else fits any frame. */
  fitsFrameId?: string
}

export interface SearchHit {
  entry: CatalogEntry
  /** Higher is better; 0 for an empty query. */
  score: number
}

export type CatalogSearch = (query: string, filters?: SearchFilters) => SearchHit[]

const FIELD_WEIGHTS = { name: 10, alias: 6, category: 3, id: 2 } as const
/** A word that only starts with the query word counts for this share of an exact match. */
const PREFIX_SHARE = 0.6

interface IndexedField {
  weight: number
  tokens: readonly string[]
}

interface IndexedEntry {
  entry: CatalogEntry
  name: string
  fields: readonly IndexedField[]
}

/** Lower case, accents removed, "×" read as "x". */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replaceAll('×', 'x')
    .toLowerCase()
}

/** Runs of letters and digits: "M5×10 SHCS" -> ["m5x10", "shcs"]. */
export function tokenize(text: string): string[] {
  return normalizeText(text).match(/[\p{L}\p{N}]+/gu) ?? []
}

function indexTokens(text: string): string[] {
  const words = tokenize(text)
  const parts = words.flatMap((word) => word.match(/\p{L}+|\p{N}+/gu) ?? [])
  return [...new Set([...words, ...parts])]
}

/** Display name: devices have a brand and a model instead of a name. */
export function entryName(entry: CatalogEntry): string {
  return entry.kind === 'device' ? deviceName(entry) : entry.name
}

export function entryCategory(entry: CatalogEntry): string | undefined {
  return entry.kind === 'frame' ? undefined : entry.category
}

/** Items list the frames they are made for in `compat.frames`; without one they fit any frame. */
export function fitsFrame(entry: CatalogEntry, frameId: string): boolean {
  if (entry.kind !== 'item' && entry.kind !== 'extra') return true
  const frames = entry.compat?.frames ?? []
  return frames.length === 0 || frames.includes(frameId)
}

export function allEntries(lookup: CatalogLookup): CatalogEntry[] {
  return [
    ...lookup.allFrames(),
    ...lookup.allItems(),
    ...lookup.allDevices(),
    ...lookup.allHardware(),
  ]
}

function indexEntry(entry: CatalogEntry): IndexedEntry {
  const name = entryName(entry)
  const aliases = entry.kind === 'hardware' ? (entry.aliases ?? []) : []
  return {
    entry,
    name,
    fields: [
      { weight: FIELD_WEIGHTS.name, tokens: indexTokens(name) },
      { weight: FIELD_WEIGHTS.alias, tokens: indexTokens(aliases.join(' ')) },
      { weight: FIELD_WEIGHTS.category, tokens: indexTokens(entryCategory(entry) ?? '') },
      { weight: FIELD_WEIGHTS.id, tokens: indexTokens(entry.id) },
    ],
  }
}

function asList(value: string | readonly string[] | undefined): readonly string[] | undefined {
  return typeof value === 'string' ? [value] : value
}

function passesFilters(entry: CatalogEntry, filters: SearchFilters): boolean {
  const kinds = asList(filters.kind)
  if (kinds !== undefined && !kinds.includes(entry.kind)) return false
  const categories = asList(filters.category)
  if (categories !== undefined) {
    const category = entryCategory(entry)
    if (category === undefined || !categories.includes(category)) return false
  }
  return filters.fitsFrameId === undefined || fitsFrame(entry, filters.fitsFrameId)
}

/** Best match of one query word over all fields; 0 when nothing matches. */
function wordScore(queryWord: string, fields: readonly IndexedField[]): number {
  let best = 0
  for (const field of fields) {
    for (const token of field.tokens) {
      if (token === queryWord) best = Math.max(best, field.weight)
      else if (token.startsWith(queryWord)) best = Math.max(best, field.weight * PREFIX_SHARE)
    }
  }
  return best
}

/** Sum of the word scores, or undefined when any query word matches nothing. */
function entryScore(queryWords: readonly string[], indexed: IndexedEntry): number | undefined {
  let total = 0
  for (const word of queryWords) {
    const score = wordScore(word, indexed.fields)
    if (score === 0) return undefined
    total += score
  }
  return total
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

/** Builds the token index once; the returned function searches it. */
export function createCatalogSearch(entries: readonly CatalogEntry[]): CatalogSearch {
  const index = entries.map(indexEntry)
  return (query, filters = {}) => {
    const queryWords = tokenize(query)
    const hits: Array<SearchHit & { name: string }> = []
    for (const indexed of index) {
      if (!passesFilters(indexed.entry, filters)) continue
      const score = entryScore(queryWords, indexed)
      if (score !== undefined) hits.push({ entry: indexed.entry, score, name: indexed.name })
    }
    return hits
      .toSorted(
        (a, b) =>
          b.score - a.score ||
          collator.compare(a.name, b.name) ||
          collator.compare(a.entry.id, b.entry.id),
      )
      .map(({ entry, score }) => ({ entry, score }))
  }
}

export function searchCatalog(
  lookup: CatalogLookup,
  query: string,
  filters?: SearchFilters,
): SearchHit[] {
  return createCatalogSearch(allEntries(lookup))(query, filters)
}
