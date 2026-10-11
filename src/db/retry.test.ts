import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DB_NAME, getDb, isDbSuperseded, registerDbDrain, resetDbForTests } from './db'
import { StorageFullError } from './errors'
import { onDbEvent, type DbEvent } from './events'
import { isQuotaError, isRetryableDbError, withRetry } from './retry'

const events: DbEvent[] = []
let stopListening: () => void = () => {}

beforeEach(async () => {
  await resetDbForTests()
  events.length = 0
  stopListening = onDbEvent((event) => events.push(event))
})

afterEach(() => {
  stopListening()
})

/** An operation that throws `errors` in order, then returns "ok". */
function failing(...errors: unknown[]): { op: () => Promise<string>; calls: () => number } {
  let calls = 0
  return {
    op: async () => {
      const error = errors[calls]
      calls += 1
      if (error !== undefined) throw error
      return 'ok'
    },
    calls: () => calls,
  }
}

describe('withRetry', () => {
  it('reopens and retries once after a dropped connection', async () => {
    await getDb().open()
    const closed = failing(new Dexie.DatabaseClosedError())
    await expect(withRetry(closed.op)).resolves.toBe('ok')
    expect(closed.calls()).toBe(2)
    expect(getDb().isOpen()).toBe(true)

    const safari = failing(
      new Error('Connection to Indexed Database server lost. Refresh the page.'),
    )
    await expect(withRetry(safari.op)).resolves.toBe('ok')
    expect(safari.calls()).toBe(2)
  })

  it('rethrows when the retry fails too', async () => {
    const twice = failing(new Dexie.DatabaseClosedError(), new Dexie.DatabaseClosedError('again'))
    await expect(withRetry(twice.op)).rejects.toThrow('again')
    expect(twice.calls()).toBe(2)
  })

  it('does not retry other errors', async () => {
    const boom = failing(new Error('boom'))
    await expect(withRetry(boom.op)).rejects.toThrow('boom')
    expect(boom.calls()).toBe(1)
    const constraint = failing(new Dexie.ConstraintError('Key already exists'))
    await expect(withRetry(constraint.op)).rejects.toBeInstanceOf(Dexie.ConstraintError)
    expect(constraint.calls()).toBe(1)
  })

  it('maps quota errors (also wrapped) to StorageFullError and reports them', async () => {
    const quota = failing(new Dexie.QuotaExceededError())
    const error = await withRetry(quota.op).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StorageFullError)
    expect((error as StorageFullError).cause).toBeInstanceOf(Dexie.QuotaExceededError)
    expect(quota.calls()).toBe(1)
    expect(events).toEqual([{ type: 'storage-full', message: (error as Error).message }])

    const aborted = failing(
      new Dexie.AbortError('Transaction aborted', new Dexie.QuotaExceededError()),
    )
    await expect(withRetry(aborted.op)).rejects.toBeInstanceOf(StorageFullError)
    const native = failing(new DOMException('The quota has been exceeded.', 'QuotaExceededError'))
    await expect(withRetry(native.op)).rejects.toBeInstanceOf(StorageFullError)
  })

  it('classifies errors', () => {
    expect(isRetryableDbError(new Dexie.DatabaseClosedError())).toBe(true)
    expect(isRetryableDbError(new DOMException('Internal error', 'UnknownError'))).toBe(true)
    expect(isRetryableDbError(new Error('The database connection is closing.'))).toBe(true)
    expect(isRetryableDbError(new Error('nope'))).toBe(false)
    expect(isRetryableDbError('DatabaseClosedError')).toBe(false)
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true)
    expect(isQuotaError(new Error('x', { cause: new Dexie.QuotaExceededError() }))).toBe(true)
    expect(isQuotaError(new Error('x'))).toBe(false)
  })
})

describe('another tab upgrading the database', () => {
  it('drains pending work, closes for good and never reopens', async () => {
    await withRetry((db) => db.plans.count())
    let drained = false
    const unregister = registerDbDrain(async () => {
      // A pending save can still write before the connection closes.
      await getDb().settings.put({ key: 'drained', value: true })
      drained = true
    })

    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      // Dexie stores version 1 as native version 10; a newer app would open a higher one.
      const request = indexedDB.open(DB_NAME, 20)
      request.addEventListener('success', () => resolve(request.result))
      request.addEventListener('error', () => reject(request.error))
    })
    unregister()

    expect(drained).toBe(true)
    expect(events).toContainEqual({ type: 'version-change', newVersion: 20 })
    expect(isDbSuperseded()).toBe(true)
    expect(getDb().isOpen()).toBe(false)

    let calls = 0
    const error = await withRetry((db) => {
      calls += 1
      return db.plans.count()
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Dexie.DatabaseClosedError)
    expect(calls).toBe(1)

    // The drain's write landed before the upgrade.
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = upgraded.transaction('settings').objectStore('settings').get('drained')
      request.addEventListener('success', () => resolve(request.result))
      request.addEventListener('error', () => reject(request.error))
    })
    expect(value).toEqual({ key: 'drained', value: true })
    upgraded.close()
  })
})
