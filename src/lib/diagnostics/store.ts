import { describeError, redact, truncate } from './sanitize'

/** What produced an entry. */
export type DiagnosticKind = 'error' | 'unhandledrejection' | 'csp' | 'worker' | 'warning'

const KINDS: ReadonlySet<string> = new Set<DiagnosticKind>([
  'error',
  'unhandledrejection',
  'csp',
  'worker',
  'warning',
])

/** Entries kept in memory (oldest dropped first); sinks should keep no more. */
export const DIAGNOSTICS_CAP = 100
export const MESSAGE_MAX_LENGTH = 500
export const STACK_MAX_LENGTH = 2000
export const SOURCE_MAX_LENGTH = 200

export interface DiagnosticEntry {
  /** ISO time of the first occurrence. */
  at: string
  kind: DiagnosticKind
  /** Redacted, at most MESSAGE_MAX_LENGTH characters. */
  message: string
  /** Redacted, at most STACK_MAX_LENGTH characters. */
  stack?: string
  /** Where it happened: a script position, `boundary:<name>`, a worker name. Redacted. */
  source?: string
  /** Identical occurrences recorded right after this one and folded into it. */
  repeats?: number
}

/** What callers pass to `record`. Never put user content (names, notes, file names) in it. */
export interface DiagnosticInput {
  kind: DiagnosticKind
  message: string
  stack?: string
  source?: string
}

/**
 * Persistent store for entries, e.g. the Dexie `diagnostics` table, so a report made after a
 * reload still lists the errors that led to it. `append` should drop the oldest rows beyond
 * DIAGNOSTICS_CAP. Failures are swallowed: diagnostics never break the app.
 */
export interface DiagnosticsSink {
  /** Entries from earlier sessions, oldest first. */
  load(): Promise<DiagnosticEntry[]>
  append(entry: DiagnosticEntry): Promise<void>
  clear(): Promise<void>
}

export interface RecordErrorOptions {
  /** Defaults to 'error'. */
  kind?: DiagnosticKind
  source?: string
  /** React's component stack (componentDidCatch), appended to the error's own stack. */
  componentStack?: string
}

/** The part of `window` (or a worker scope) that `install` listens on. */
export interface DiagnosticsEventTarget {
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ): void
  removeEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: boolean | EventListenerOptions,
  ): void
}

export interface Diagnostics {
  /** Records an entry (redacted, truncated) and returns what was stored. */
  record(input: DiagnosticInput): DiagnosticEntry
  /** Records anything thrown. The same error object is recorded once. */
  recordError(error: unknown, options?: RecordErrorOptions): DiagnosticEntry | undefined
  /** Earlier sessions' entries, then this session's; oldest first, at most the cap. Stable until the next change. */
  entries(): readonly DiagnosticEntry[]
  /** Called after every change; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Switches to a persistent sink: loads its earlier entries and saves this session's so far. */
  setSink(sink: DiagnosticsSink): Promise<void>
  /** Empties memory and the sink. */
  clear(): Promise<void>
  /**
   * Listens for `error` (scripts and failed script/stylesheet loads), `unhandledrejection` and
   * `securitypolicyviolation` on the target. Idempotent per target; returns an uninstall function.
   */
  install(options: { window: DiagnosticsEventTarget }): () => void
}

export interface DiagnosticsOptions {
  cap?: number
  sink?: DiagnosticsSink
  now?: () => Date
  /** The app's origin, stripped from URLs. Defaults to `location.origin` when there is one. */
  origin?: () => string | undefined
}

/** In-memory sink (the default): keeps the newest `cap` entries for the page's lifetime. */
export function createMemorySink(cap = DIAGNOSTICS_CAP): DiagnosticsSink {
  let stored: DiagnosticEntry[] = []
  return {
    load: () => Promise.resolve([...stored]),
    append: (entry) => {
      stored = [...stored, entry].slice(-cap)
      return Promise.resolve()
    },
    clear: () => {
      stored = []
      return Promise.resolve()
    },
  }
}

function currentOrigin(): string | undefined {
  const origin: unknown = globalThis.location?.origin
  return typeof origin === 'string' && origin !== 'null' ? origin : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** `file:line:col` for event positions; undefined without a file. */
function position(file: unknown, line: unknown, column: unknown): string | undefined {
  const name = text(file)
  if (name === '') return undefined
  const lineNumber = positiveInteger(line)
  const columnNumber = positiveInteger(column)
  if (lineNumber === undefined) return name
  return columnNumber === undefined
    ? `${name}:${lineNumber}`
    : `${name}:${lineNumber}:${columnNumber}`
}

const COMPONENT_STACK_SHARE = 600

function joinStacks(stack: string | undefined, componentStack: string | undefined): string {
  const components = (componentStack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
  if (components === '') return stack ?? ''
  // Keep room for the component stack: it names the component that failed.
  const own =
    stack === undefined ? '' : `${truncate(stack, STACK_MAX_LENGTH - COMPONENT_STACK_SHARE)}\n`
  return `${own}Component stack:\n${components}`
}

function isEntry(value: unknown): value is DiagnosticEntry {
  if (typeof value !== 'object' || value === null) return false
  const { at, kind, message } = value as Record<string, unknown>
  return (
    typeof at === 'string' &&
    typeof kind === 'string' &&
    KINDS.has(kind) &&
    typeof message === 'string'
  )
}

/** Re-applies the limits to entries from a sink (written by any app version). */
function sanitizeStored(entry: DiagnosticEntry, origin: string | undefined): DiagnosticEntry {
  const clean: DiagnosticEntry = {
    at: truncate(entry.at, 40),
    kind: entry.kind,
    message: truncate(redact(entry.message, origin), MESSAGE_MAX_LENGTH),
  }
  if (typeof entry.stack === 'string' && entry.stack !== '') {
    clean.stack = truncate(redact(entry.stack, origin), STACK_MAX_LENGTH)
  }
  if (typeof entry.source === 'string' && entry.source !== '') {
    clean.source = truncate(redact(entry.source, origin), SOURCE_MAX_LENGTH)
  }
  const repeats = positiveInteger(entry.repeats)
  if (repeats !== undefined) clean.repeats = repeats
  return clean
}

export function createDiagnostics(options: DiagnosticsOptions = {}): Diagnostics {
  const cap = options.cap ?? DIAGNOSTICS_CAP
  const now = options.now ?? (() => new Date())
  const origin = options.origin ?? currentOrigin
  let sink = options.sink ?? createMemorySink(cap)
  /** Loaded from the sink: earlier sessions. */
  let earlier: DiagnosticEntry[] = []
  /** Recorded since this page loaded. */
  let session: DiagnosticEntry[] = []
  let snapshot: readonly DiagnosticEntry[] | undefined
  const listeners = new Set<() => void>()
  const recordedErrors = new WeakSet<object>()
  const installed = new WeakMap<DiagnosticsEventTarget, () => void>()

  function changed(): void {
    snapshot = undefined
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // A broken listener must not stop recording.
      }
    }
  }

  function persist(target: DiagnosticsSink, entry: DiagnosticEntry): void {
    try {
      // Not recorded on failure: a failing sink would otherwise record forever.
      target.append(entry).catch(() => undefined)
    } catch {
      // Same for a synchronous throw.
    }
  }

  function record(input: DiagnosticInput): DiagnosticEntry {
    const appOrigin = origin()
    const entry: DiagnosticEntry = {
      at: now().toISOString(),
      kind: KINDS.has(input.kind) ? input.kind : 'error',
      message: truncate(redact(input.message, appOrigin), MESSAGE_MAX_LENGTH) || '(no message)',
    }
    if (input.stack) entry.stack = truncate(redact(input.stack, appOrigin), STACK_MAX_LENGTH)
    if (input.source) entry.source = truncate(redact(input.source, appOrigin), SOURCE_MAX_LENGTH)

    // A render or animation loop repeats one error many times; folding it keeps the first,
    // usually more telling, entries in the buffer.
    const last = session.at(-1)
    if (
      last !== undefined &&
      last.kind === entry.kind &&
      last.message === entry.message &&
      last.source === entry.source
    ) {
      const folded = { ...last, repeats: (last.repeats ?? 0) + 1 }
      session[session.length - 1] = folded
      changed()
      return folded
    }
    session.push(entry)
    if (session.length > cap) session = session.slice(-cap)
    persist(sink, entry)
    changed()
    return entry
  }

  function recordError(
    error: unknown,
    recordOptions: RecordErrorOptions = {},
  ): DiagnosticEntry | undefined {
    if (typeof error === 'object' && error !== null) {
      // Boundaries, route errors and window events can all see the same error object.
      if (recordedErrors.has(error)) return undefined
      recordedErrors.add(error)
    }
    const { message, stack } = describeError(error)
    const fullStack = joinStacks(stack, recordOptions.componentStack)
    return record({
      kind: recordOptions.kind ?? 'error',
      message,
      stack: fullStack,
      source: recordOptions.source,
    })
  }

  function entries(): readonly DiagnosticEntry[] {
    snapshot ??= Object.freeze([...earlier, ...session].slice(-cap))
    return snapshot
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  async function setSink(next: DiagnosticsSink): Promise<void> {
    if (next === sink) return
    let loaded: unknown[] = []
    try {
      loaded = await next.load()
    } catch {
      loaded = []
    }
    // Records made while loading went to the old sink and are in `session`: saved below.
    sink = next
    for (const entry of session) persist(next, entry)
    const appOrigin = origin()
    earlier = (Array.isArray(loaded) ? loaded : [])
      .filter(isEntry)
      .map((entry) => sanitizeStored(entry, appOrigin))
      .slice(-cap)
    changed()
  }

  async function clear(): Promise<void> {
    earlier = []
    session = []
    changed()
    try {
      await sink.clear()
    } catch {
      // Memory is clear; a stale persisted copy is harmless.
    }
  }

  function onError(event: Event): void {
    const fields = event as Event & Record<string, unknown>
    if ('error' in fields || 'message' in fields) {
      // A script error (ErrorEvent).
      const source = position(fields.filename, fields.lineno, fields.colno)
      const thrown = fields.error
      if (thrown !== undefined && thrown !== null) {
        recordError(thrown, { source })
      } else {
        // Cross-origin and some engine errors carry only a message.
        const message = text(fields.message) || 'Script error'
        record({ kind: 'error', message, source })
      }
      return
    }
    // A failed load: the event comes from the element, seen here in the capture phase. Scripts and
    // stylesheets only; after a deploy they are the stale-chunk symptom worth seeing.
    const target: unknown = event.target
    if (typeof target !== 'object' || target === null) return
    const element = target as Record<string, unknown>
    const tag = text(element.tagName).toLowerCase()
    if (tag !== 'script' && tag !== 'link') return
    const url = text(element.src) || text(element.href)
    record({ kind: 'error', message: `Failed to load ${tag} ${url}`.trim(), source: 'resource' })
  }

  function onRejection(event: Event): void {
    recordError((event as Event & { reason?: unknown }).reason, { kind: 'unhandledrejection' })
  }

  function onCspViolation(event: Event): void {
    const fields = event as Event & Record<string, unknown>
    const directive = text(fields.effectiveDirective) || text(fields.violatedDirective) || 'unknown'
    const blocked = text(fields.blockedURI) || 'inline'
    const mode = fields.disposition === 'report' ? ' (report only)' : ''
    const source = position(fields.sourceFile, fields.lineNumber, fields.columnNumber)
    // `sample` (the start of the blocked code) is left out: it can be anything.
    record({ kind: 'csp', message: `CSP ${directive} blocked ${blocked}${mode}`, source })
  }

  /** Diagnostics must never throw into the app's own error handling. */
  function guarded(handler: (event: Event) => void): (event: Event) => void {
    return (event) => {
      try {
        handler(event)
      } catch {
        // Ignore: a broken diagnostics handler is not worth an error loop.
      }
    }
  }

  function install({ window: target }: { window: DiagnosticsEventTarget }): () => void {
    const existing = installed.get(target)
    if (existing !== undefined) return existing
    const handleError = guarded(onError)
    const handleRejection = guarded(onRejection)
    const handleCsp = guarded(onCspViolation)
    // Capture: load errors do not bubble, and CSP events fire on the element or document.
    target.addEventListener('error', handleError, true)
    target.addEventListener('unhandledrejection', handleRejection)
    target.addEventListener('securitypolicyviolation', handleCsp, true)
    const uninstall = (): void => {
      target.removeEventListener('error', handleError, true)
      target.removeEventListener('unhandledrejection', handleRejection)
      target.removeEventListener('securitypolicyviolation', handleCsp, true)
      installed.delete(target)
    }
    installed.set(target, uninstall)
    return uninstall
  }

  return { record, recordError, entries, subscribe, setSink, clear, install }
}

/** The app-wide instance behind the module-level functions in `index.ts`. */
export const defaultDiagnostics = createDiagnostics()
