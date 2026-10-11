import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getStorageStatus,
  requestPersist,
  requestPersistOnce,
  resetPersistOnceForTests,
} from './storage'

beforeEach(() => {
  resetPersistOnceForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubStorage(storage: Partial<StorageManager> | undefined): void {
  vi.stubGlobal('navigator', { storage })
}

describe('getStorageStatus', () => {
  it('reports an insecure origin without navigator.storage', async () => {
    stubStorage(undefined)
    vi.stubGlobal('isSecureContext', false)
    vi.stubGlobal('location', { origin: 'http://nas.local:8080' })
    expect(await getStorageStatus()).toEqual({
      supported: false,
      secureContext: false,
      origin: 'http://nas.local:8080',
    })
  })

  it('reads persistence and the usage estimate where available', async () => {
    stubStorage({
      persisted: async () => true,
      estimate: async () => ({ usage: 1024, quota: 2048 }),
    })
    vi.stubGlobal('isSecureContext', true)
    expect(await getStorageStatus()).toMatchObject({
      supported: true,
      persisted: true,
      usage: 1024,
      quota: 2048,
      secureContext: true,
    })
  })

  it('keeps going when a call throws (private windows)', async () => {
    stubStorage({
      persisted: () => Promise.reject(new Error('denied')),
      estimate: () => Promise.reject(new Error('denied')),
    })
    const status = await getStorageStatus()
    expect(status.supported).toBe(true)
    expect(status.persisted).toBeUndefined()
    expect(status.usage).toBeUndefined()
  })
})

describe('requestPersist', () => {
  it('is unsupported without the API and false when it throws', async () => {
    stubStorage(undefined)
    expect(await requestPersist()).toBe('unsupported')
    stubStorage({ persist: () => Promise.reject(new Error('nope')) })
    expect(await requestPersist()).toBe(false)
    stubStorage({ persist: async () => true })
    expect(await requestPersist()).toBe(true)
  })

  it('asks at most once per page load, and not when already persisted', async () => {
    const persist = vi.fn(async () => true)
    stubStorage({ persisted: async () => false, persist })
    expect(await requestPersistOnce()).toBe(true)
    expect(await requestPersistOnce()).toBe(true)
    expect(persist).toHaveBeenCalledTimes(1)

    resetPersistOnceForTests()
    const notAgain = vi.fn(async () => true)
    stubStorage({ persisted: async () => true, persist: notAgain })
    expect(await requestPersistOnce()).toBe(true)
    expect(notAgain).not.toHaveBeenCalled()
  })
})
