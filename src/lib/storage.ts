/**
 * Browser storage facts for the Storage panel and diagnostics, with feature detection throughout:
 * `navigator.storage` is [SecureContext], so it is missing on plain-HTTP LAN origins (the Docker
 * image served over http://host:8080), and older browsers lack `persisted()`/`persist()`.
 */

export interface StorageStatus {
  /** `navigator.storage` exists (false on insecure origins and old browsers). */
  supported: boolean
  /** Whether the browser promised not to evict this origin's data; unknown when undefined. */
  persisted?: boolean
  /** Bytes used by this origin (estimate). */
  usage?: number
  /** Bytes this origin may use (estimate). */
  quota?: number
  secureContext: boolean
  /** Data is stored per origin: another host name or port starts empty. */
  origin: string
}

export type PersistResult = boolean | 'unsupported'

function storageManager(): StorageManager | undefined {
  if (typeof navigator === 'undefined') return undefined
  // Typed as always present, but undefined outside secure contexts.
  const storage: StorageManager | undefined = navigator.storage
  return storage ?? undefined
}

function currentOrigin(): string {
  return typeof location === 'undefined' ? '' : location.origin
}

export async function getStorageStatus(): Promise<StorageStatus> {
  const status: StorageStatus = {
    supported: false,
    secureContext: globalThis.isSecureContext === true,
    origin: currentOrigin(),
  }
  const storage = storageManager()
  if (storage === undefined) return status
  status.supported = true
  try {
    if (typeof storage.persisted === 'function') status.persisted = await storage.persisted()
  } catch {
    // Private windows may reject; leave it unknown.
  }
  try {
    if (typeof storage.estimate === 'function') {
      const estimate = await storage.estimate()
      status.usage = estimate.usage
      status.quota = estimate.quota
    }
  } catch {
    // Same as above.
  }
  return status
}

/**
 * Asks the browser to keep this origin's data (Safari otherwise may wipe it after 7 days without
 * a visit). Firefox may show a prompt; Chromium decides silently. `'unsupported'` when the API is
 * missing (insecure origin, old browser).
 */
export async function requestPersist(): Promise<PersistResult> {
  const storage = storageManager()
  if (storage === undefined || typeof storage.persist !== 'function') return 'unsupported'
  try {
    return await storage.persist()
  } catch {
    return false
  }
}

let persistOnce: Promise<PersistResult> | undefined

/**
 * `persist()` at most once per page load, and only if the origin is not persisted yet. Called
 * after the first successful save (the plan's "persist() after the first save").
 */
export function requestPersistOnce(): Promise<PersistResult> {
  persistOnce ??= (async () => {
    const storage = storageManager()
    if (storage === undefined || typeof storage.persist !== 'function') return 'unsupported'
    try {
      if (typeof storage.persisted === 'function' && (await storage.persisted())) return true
    } catch {
      // Fall through and ask.
    }
    return requestPersist()
  })()
  return persistOnce
}

/** Forgets the once-per-page-load attempt (tests only). */
export function resetPersistOnceForTests(): void {
  persistOnce = undefined
}
