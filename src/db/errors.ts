/**
 * Typed errors of the data layer. Callers branch on `instanceof` (or `name`), never on messages;
 * messages are written for the user.
 */

export class PlanNotFoundError extends Error {
  override name = 'PlanNotFoundError'
  readonly planId: string

  constructor(planId: string) {
    super('This plan is not in this browser (it may have been deleted).')
    this.planId = planId
  }
}

/**
 * Compare-and-swap failed: the stored plan changed since this copy was loaded (another tab, an
 * import), or it was deleted (`theirRev` null).
 */
export class PlanConflictError extends Error {
  override name = 'PlanConflictError'
  readonly planId: string
  readonly theirRev: number | null

  constructor(planId: string, theirRev: number | null) {
    super(
      theirRev === null
        ? 'This plan was deleted in another tab.'
        : 'This plan was changed in another tab.',
    )
    this.planId = planId
    this.theirRev = theirRev
  }
}

/** The stored plan was made by a newer app version: it opens read-only and is never overwritten. */
export class PlanReadOnlyError extends Error {
  override name = 'PlanReadOnlyError'
  readonly planId: string

  constructor(planId: string) {
    super('This plan was made with a newer version of Mini Rack Planner, so it is read-only here.')
    this.planId = planId
  }
}

/** The browser refused a write because its storage quota is used up (QuotaExceededError). */
export class StorageFullError extends Error {
  override name = 'StorageFullError'

  constructor(options?: { cause?: unknown }) {
    super(
      'Browser storage is full, so your latest changes were not saved. Free up space in Settings > Storage.',
      options,
    )
  }
}

/** A backup or plan file that cannot be imported at all (nothing was written). */
export class BackupFormatError extends Error {
  override name = 'BackupFormatError'
  /** Per-entry reasons, when the file was rejected because of its contents. */
  readonly details: readonly string[]

  constructor(message: string, details: readonly string[] = []) {
    super(message)
    this.details = details
  }
}

/** A custom part that cannot be stored in the library. */
export class LibraryEntryError extends Error {
  override name = 'LibraryEntryError'
  readonly problems: readonly string[]

  constructor(message: string, problems: readonly string[] = []) {
    super(message)
    this.problems = problems
  }
}

/** A readable one-liner for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'Unknown error'
}
