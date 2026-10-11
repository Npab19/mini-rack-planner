/**
 * Gathers what a report needs from the running app and browser. Every browser API is
 * feature-detected: plain-HTTP LAN origins have no `navigator.storage`.
 */
import { buildReport, type ReportInput, type StorageInfo } from './report'
import { defaultDiagnostics, type DiagnosticEntry } from './store'

export interface ReportContext {
  /** The bundled catalog's revision; set by whoever loads the catalog. */
  catalogRevision?: string
  /** Defaults to PLAN_SCHEMA_VERSION, loaded on demand. */
  planSchema?: number
}

let context: ReportContext = {}

/** Adds facts only other modules know (the catalog revision) to every later report. */
export function setReportContext(next: ReportContext): void {
  context = { ...context, ...next }
}

interface StorageManagerLike {
  persisted?: () => Promise<boolean>
  estimate?: () => Promise<{ usage?: number; quota?: number }>
}

interface NavigatorLike {
  userAgent?: string
  storage?: StorageManagerLike
}

export interface CollectOptions {
  entries?: readonly DiagnosticEntry[]
  navigator?: NavigatorLike
  secureContext?: boolean
  now?: Date
}

/** Storage calls can hang in some private modes: a report never waits longer than this. */
const STORAGE_TIMEOUT_MS = 1500

async function settle<T>(call: () => Promise<T> | undefined): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const promise = call()
    if (promise === undefined) return undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), STORAGE_TIMEOUT_MS)
    })
    return await Promise.race([promise, timeout])
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function readStorage(nav: NavigatorLike | undefined): Promise<StorageInfo | undefined> {
  const storage = nav?.storage
  if (!storage) return undefined
  const [persisted, estimate] = await Promise.all([
    settle(() => storage.persisted?.()),
    settle(() => storage.estimate?.()),
  ])
  const info: StorageInfo = {}
  if (typeof persisted === 'boolean') info.persisted = persisted
  if (typeof estimate?.usage === 'number') info.usage = estimate.usage
  if (typeof estimate?.quota === 'number') info.quota = estimate.quota
  return info
}

async function planSchemaVersion(): Promise<number | string> {
  if (context.planSchema !== undefined) return context.planSchema
  try {
    // On demand: the schema module builds zod schemas the initial bundle does not need. After a
    // deploy this chunk may be gone (Vite then resolves the import to undefined): 'unknown'.
    const module = await import('@/domain/schema/plan')
    return module.PLAN_SCHEMA_VERSION
  } catch {
    return 'unknown'
  }
}

export async function collectReportInput(options: CollectOptions = {}): Promise<ReportInput> {
  const nav: NavigatorLike | undefined =
    options.navigator ?? (typeof navigator === 'undefined' ? undefined : navigator)
  const [storage, planSchema] = await Promise.all([readStorage(nav), planSchemaVersion()])
  const input: ReportInput = {
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
    gitSha: typeof __GIT_SHA__ === 'string' ? __GIT_SHA__ : 'unknown',
    planSchema,
    userAgent: nav?.userAgent ?? 'unknown',
    secureContext: options.secureContext ?? globalThis.isSecureContext === true,
    entries: options.entries ?? defaultDiagnostics.entries(),
    generatedAt: (options.now ?? new Date()).toISOString(),
  }
  if (context.catalogRevision !== undefined) input.catalogRevision = context.catalogRevision
  if (storage !== undefined) input.storage = storage
  return input
}

/** The report for Copy diagnostics, from the app-wide entries. Never rejects. */
export async function collectReport(options?: CollectOptions): Promise<string> {
  return buildReport(await collectReportInput(options))
}
