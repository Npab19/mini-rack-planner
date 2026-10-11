/**
 * Persistent storage for the diagnostics ring buffer (`src/lib/diagnostics`), so a report made
 * after a reload still lists the errors that led to it. main.tsx wires it once at startup:
 *
 *   void diagnostics.setSink(createDiagnosticsSink())
 *
 * Entries arrive redacted and truncated; the diagnostics store re-validates whatever `load`
 * returns (another app version may have written it). Failures reject; the store swallows them.
 */
import type { DiagnosticEntry, DiagnosticsSink } from '@/lib/diagnostics'
import { withRetry } from './retry'

/**
 * Rows kept in the table. Every tab and session appends to it while the store shows its newest
 * DIAGNOSTICS_CAP (100), so the table keeps twice that: what led up to a problem survives a few
 * reloads and other tabs' entries.
 */
export const MAX_DIAGNOSTICS = 200

/** Appends an entry and drops the oldest beyond `cap`, in one transaction. */
export async function appendDiagnostic(
  entry: DiagnosticEntry,
  cap: number = MAX_DIAGNOSTICS,
): Promise<void> {
  await withRetry((db) =>
    db.transaction('rw', db.diagnostics, async () => {
      await db.diagnostics.add({ at: entry.at, entry })
      const excess = (await db.diagnostics.count()) - Math.max(1, cap)
      if (excess > 0) {
        const oldest = await db.diagnostics.orderBy('seq').limit(excess).primaryKeys()
        await db.diagnostics.bulkDelete(oldest)
      }
    }),
  )
}

/** Stored entries, oldest first. */
export async function listDiagnostics(): Promise<DiagnosticEntry[]> {
  const rows = await withRetry((db) => db.diagnostics.orderBy('seq').toArray())
  return rows.map((row) => row.entry)
}

export async function clearDiagnostics(): Promise<void> {
  await withRetry((db) => db.diagnostics.clear())
}

/** The Dexie-backed sink for `diagnostics.setSink`. */
export function createDiagnosticsSink(cap: number = MAX_DIAGNOSTICS): DiagnosticsSink {
  return {
    load: () => listDiagnostics(),
    append: (entry) => appendDiagnostic(entry, cap),
    clear: () => clearDiagnostics(),
  }
}
