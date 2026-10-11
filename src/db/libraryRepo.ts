/**
 * The user's library of custom catalog entries ("My parts"). Ids start with `custom:` so they can
 * never shadow a curated entry. Entries are validated on the way in and on the way out (a newer
 * app version may have stored something this one cannot read; those rows are reported, not lost).
 */
import { CatalogEntrySchema, type CatalogEntry } from '@/domain/schema/catalog'
import { CUSTOM_ID_PREFIX, isCustomId } from '@/domain/schema/common'
import { checkEntryIntegrity } from '@/domain/schema/integrity'
import type { LibraryRow } from './db'
import { LibraryEntryError } from './errors'
import { withRetry } from './retry'

export interface LibraryProblem {
  id: string
  message: string
}

export interface LibraryList {
  /** Most recently changed first. */
  entries: CatalogEntry[]
  /** Stored rows this version cannot read (kept in the database untouched). */
  problems: LibraryProblem[]
}

/** A storable custom entry: valid schema, `custom:` id and consistent (checkEntryIntegrity). */
export function validateLibraryEntry(input: unknown): CatalogEntry {
  const result = CatalogEntrySchema.safeParse(input)
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const path = issue.path.map(String).join('.')
      return path === '' ? issue.message : `${path}: ${issue.message}`
    })
    throw new LibraryEntryError('This part is not valid.', problems)
  }
  const entry = result.data
  if (!isCustomId(entry.id)) {
    throw new LibraryEntryError(`Your own parts need an id that starts with "${CUSTOM_ID_PREFIX}".`)
  }
  const problems = checkEntryIntegrity(entry)
  if (problems.length > 0) throw new LibraryEntryError('This part is not consistent.', problems)
  return entry
}

export function libraryRow(entry: CatalogEntry, updatedAt: string): LibraryRow {
  return { id: entry.id, kind: entry.kind, updatedAt, entry }
}

/** Splits stored rows into readable entries and problems. */
export function readLibraryRows(rows: readonly LibraryRow[]): LibraryList {
  const entries: CatalogEntry[] = []
  const problems: LibraryProblem[] = []
  for (const row of rows) {
    try {
      entries.push(validateLibraryEntry(row.entry))
    } catch (error) {
      const message =
        error instanceof LibraryEntryError
          ? [error.message, ...error.problems.slice(0, 2)].join(' ')
          : 'Unreadable part.'
      problems.push({ id: row.id, message })
    }
  }
  return { entries, problems }
}

export async function listLibrary(): Promise<LibraryList> {
  const rows = await withRetry((db) => db.library.orderBy('updatedAt').toArray())
  return readLibraryRows(rows.toReversed())
}

export async function getLibraryEntry(id: string): Promise<CatalogEntry | undefined> {
  const row = await withRetry((db) => db.library.get(id))
  return row === undefined ? undefined : readLibraryRows([row]).entries[0]
}

/**
 * Adds or replaces a custom entry; returns it as stored (schema defaults applied).
 * @throws LibraryEntryError when the entry is invalid or its id is not a `custom:` id
 */
export async function putLibraryEntry(input: unknown): Promise<CatalogEntry> {
  const entry = validateLibraryEntry(input)
  await withRetry((db) => db.library.put(libraryRow(entry, new Date().toISOString())))
  return entry
}

export async function deleteLibraryEntry(id: string): Promise<void> {
  await withRetry((db) => db.library.delete(id))
}
