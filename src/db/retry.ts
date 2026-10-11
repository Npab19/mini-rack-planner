/**
 * Every repository call goes through `withRetry`:
 * - Safari (and occasionally Chrome) drops IndexedDB connections, e.g. after the tab sat in the
 *   background: "Connection to Indexed Database server lost", "database connection is closing",
 *   UnknownError. The connection is reopened once and the operation retried once.
 * - A full disk (QuotaExceededError, possibly wrapped in an AbortError) becomes a typed
 *   `StorageFullError` and a `storage-full` event for the status banner.
 * A connection closed because another tab upgraded the database is never reopened (see db.ts).
 */
import { getDb, isDbSuperseded, reopenDb, type MrpDb } from './db'
import { StorageFullError } from './errors'
import { emitDbEvent } from './events'

const RETRYABLE_MESSAGE =
  /Connection to Indexed Database server lost|database connection is closing|UnknownError/i
const QUOTA_NAMES = new Set(['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'])
/** Legacy DOMException code for QUOTA_EXCEEDED_ERR. */
const QUOTA_CODE = 22

interface ErrorLike {
  name?: unknown
  message?: unknown
  code?: unknown
  inner?: unknown
  cause?: unknown
  failures?: unknown
}

function isObject(value: unknown): value is ErrorLike {
  return typeof value === 'object' && value !== null
}

/** Dexie wraps native errors (`inner`, bulk `failures`); standard errors chain via `cause`. */
function someInChain(error: unknown, test: (error: ErrorLike) => boolean, depth = 0): boolean {
  if (!isObject(error) || depth > 4) return false
  if (test(error)) return true
  const nested = [
    error.inner,
    error.cause,
    ...(Array.isArray(error.failures) ? error.failures : []),
  ]
  return nested.some((inner) => inner !== error && someInChain(inner, test, depth + 1))
}

/** A dropped or closing connection that a reopen can fix. */
export function isRetryableDbError(error: unknown): boolean {
  return someInChain(error, (candidate) => {
    if (candidate.name === 'DatabaseClosedError') return true
    const name = typeof candidate.name === 'string' ? candidate.name : ''
    const message = typeof candidate.message === 'string' ? candidate.message : ''
    return RETRYABLE_MESSAGE.test(name) || RETRYABLE_MESSAGE.test(message)
  })
}

export function isQuotaError(error: unknown): boolean {
  return someInChain(
    error,
    (candidate) =>
      (typeof candidate.name === 'string' && QUOTA_NAMES.has(candidate.name)) ||
      candidate.code === QUOTA_CODE,
  )
}

function toStorageFull(error: unknown): StorageFullError {
  const full = error instanceof StorageFullError ? error : new StorageFullError({ cause: error })
  emitDbEvent({ type: 'storage-full', message: full.message })
  return full
}

function mapError(error: unknown): unknown {
  return isQuotaError(error) ? toStorageFull(error) : error
}

/** Bumped by every reopen, so operations that failed before it retry without reopening again. */
let generation = 0
let reopening: Promise<void> | undefined

function reopenOnce(): Promise<void> {
  reopening ??= reopenDb()
    .then(() => {
      generation += 1
    })
    .finally(() => {
      reopening = undefined
    })
  return reopening
}

/**
 * Runs a database operation; on a dropped connection it reopens once and retries once, then
 * rethrows. Quota errors are rethrown as `StorageFullError`. The operation must be safe to run
 * twice (a single transaction is: a failed one never committed).
 */
export async function withRetry<T>(op: (db: MrpDb) => PromiseLike<T> | T): Promise<T> {
  const startedAt = generation
  try {
    return await op(getDb())
  } catch (error) {
    if (isQuotaError(error)) throw toStorageFull(error)
    if (!isRetryableDbError(error) || isDbSuperseded()) throw error
    if (generation === startedAt) await reopenOnce()
    try {
      return await op(getDb())
    } catch (retryError) {
      throw mapError(retryError)
    }
  }
}
