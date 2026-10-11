import { describe, expect, it } from 'vitest'
import { createStorageRecovery, parseRecoveryEntry } from './recovery'

/** A Web Storage area in memory; `full` makes every write fail like an exceeded quota. */
function memoryStorage(options: { full?: boolean } = {}): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key)
    },
    setItem: (key, value) => {
      if (options.full) throw new DOMException('Full', 'QuotaExceededError')
      data.set(key, String(value))
    },
  }
}

describe('parseRecoveryEntry', () => {
  it('reads what write stores and rejects anything else', () => {
    expect(parseRecoveryEntry('p', '{"v":1,"baseRev":3,"plan":{"id":"p"}}')).toEqual({
      planId: 'p',
      baseRev: 3,
      plan: { id: 'p' },
    })
    expect(
      parseRecoveryEntry('p', '{"v":1,"baseRev":3,"plan":{"id":"p"},"saving":{"id":"p"}}')?.saving,
    ).toEqual({ id: 'p' })
    for (const text of [
      null,
      'not json',
      '[]',
      '{"v":2,"baseRev":3,"plan":{}}',
      '{"v":1,"baseRev":-1,"plan":{}}',
      '{"v":1,"baseRev":1.5,"plan":{}}',
      '{"v":1,"baseRev":3,"plan":"x"}',
    ]) {
      expect(parseRecoveryEntry('p', text)).toBeUndefined()
    }
  })
})

describe('createStorageRecovery', () => {
  it('writes, reads and removes one entry per plan', () => {
    const storage = memoryStorage()
    const recovery = createStorageRecovery(() => storage)
    recovery.write({ planId: 'a', baseRev: 2, plan: { id: 'a', name: 'A' } })
    recovery.write({ planId: 'b', baseRev: 5, plan: { id: 'b' }, saving: { id: 'b' } })
    expect(recovery.read('a')).toEqual({ planId: 'a', baseRev: 2, plan: { id: 'a', name: 'A' } })
    expect(recovery.read('b')?.saving).toEqual({ id: 'b' })
    recovery.remove('a')
    expect(recovery.read('a')).toBeUndefined()
    expect(storage.length).toBe(1)
  })

  it('never throws: missing, blocked or full storage is a no-op', () => {
    const missing = createStorageRecovery(() => undefined)
    const blocked = createStorageRecovery(() => {
      throw new DOMException('Blocked', 'SecurityError')
    })
    const full = createStorageRecovery(() => memoryStorage({ full: true }))
    for (const recovery of [missing, blocked, full]) {
      expect(() => recovery.write({ planId: 'a', baseRev: 1, plan: { id: 'a' } })).not.toThrow()
      expect(recovery.read('a')).toBeUndefined()
      expect(() => recovery.remove('a')).not.toThrow()
    }
  })
})
