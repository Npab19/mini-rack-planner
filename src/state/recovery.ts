/**
 * Unsaved edits kept through a reload or a closed tab. The autosave writes to IndexedDB, which is
 * asynchronous: a save started while the page unloads (pagehide) never finishes, because its
 * transaction needs callbacks the dying page no longer runs. So when the page is hidden, the plan
 * store also writes its unsaved plan here, synchronously, with the stored revision it was based on.
 * The next load of that plan takes it back only if the stored revision still matches (the same
 * rule as the save's compare-and-swap), so it can never overwrite another tab's newer save.
 *
 * localStorage, not sessionStorage: a closed tab keeps its edits too. Every access is guarded:
 * storage can be missing, blocked (private modes) or full, and then this is simply a no-op.
 */

export interface RecoveryEntry {
  planId: string
  /** The stored revision the edits were made on. */
  baseRev: number
  /** The plan with the edits (validated again before use: another version may have written it). */
  plan: unknown
  /**
   * The plan a save was writing when the page was hidden. That save may still have landed, as
   * revision `baseRev + 1`; the edits then still apply if the stored plan is exactly this one.
   */
  saving?: unknown
}

export interface PlanRecovery {
  read(planId: string): RecoveryEntry | undefined
  /** Synchronous on purpose: it runs while the page unloads. */
  write(entry: RecoveryEntry): void
  remove(planId: string): void
}

const KEY_PREFIX = 'mrp-unsaved:'
const VERSION = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parses a stored entry; anything unexpected is treated as absent. */
export function parseRecoveryEntry(planId: string, text: string | null): RecoveryEntry | undefined {
  if (text === null) return undefined
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(data) || data.v !== VERSION || !isRecord(data.plan)) return undefined
  const { baseRev } = data
  if (typeof baseRev !== 'number' || !Number.isInteger(baseRev) || baseRev < 0) return undefined
  const entry: RecoveryEntry = { planId, baseRev, plan: data.plan }
  if (isRecord(data.saving)) entry.saving = data.saving
  return entry
}

/** Recovery in a Web Storage area (`localStorage` in the app). */
export function createStorageRecovery(getStorage: () => Storage | undefined): PlanRecovery {
  function storage(): Storage | undefined {
    try {
      return getStorage()
    } catch {
      // Reading `localStorage` itself throws when site data is blocked.
      return undefined
    }
  }
  return {
    read(planId) {
      try {
        return parseRecoveryEntry(planId, storage()?.getItem(KEY_PREFIX + planId) ?? null)
      } catch {
        return undefined
      }
    },
    write(entry) {
      try {
        const value = { v: VERSION, baseRev: entry.baseRev, plan: entry.plan, saving: entry.saving }
        storage()?.setItem(KEY_PREFIX + entry.planId, JSON.stringify(value))
      } catch {
        // Full or blocked: the autosave flush that runs next is all there is.
      }
    },
    remove(planId) {
      try {
        storage()?.removeItem(KEY_PREFIX + planId)
      } catch {
        // Nothing to do: a stale entry is ignored later (its revision no longer matches).
      }
    },
  }
}

/** The app's recovery store. */
export const localRecovery: PlanRecovery = createStorageRecovery(() => globalThis.localStorage)
