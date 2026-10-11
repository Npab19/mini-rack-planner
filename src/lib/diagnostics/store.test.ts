import { describe, expect, it, vi } from 'vitest'
import {
  createDiagnostics,
  createMemorySink,
  DIAGNOSTICS_CAP,
  MESSAGE_MAX_LENGTH,
  STACK_MAX_LENGTH,
  type DiagnosticEntry,
  type DiagnosticsEventTarget,
  type DiagnosticsSink,
} from './store'

const ORIGIN = 'http://lan.test:8080'
const AT = new Date('2026-10-11T12:00:00.000Z')

function setup(sink?: DiagnosticsSink) {
  return createDiagnostics({ now: () => AT, origin: () => ORIGIN, ...(sink ? { sink } : {}) })
}

/** A window stand-in that can deliver any event object, including element load errors. */
class FakeWindow implements DiagnosticsEventTarget {
  readonly listeners = new Map<string, Set<(event: Event) => void>>()
  addEventListener(type: string, listener: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  emit(type: string, fields: Record<string, unknown>): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ type, ...fields } as unknown as Event)
  }
  count(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }
}

describe('record', () => {
  it('keeps the newest DIAGNOSTICS_CAP entries, oldest first', () => {
    const diagnostics = setup()
    for (let index = 0; index < 150; index++) {
      diagnostics.record({ kind: 'warning', message: `problem ${index}` })
    }
    const entries = diagnostics.entries()
    expect(entries).toHaveLength(DIAGNOSTICS_CAP)
    expect(entries[0]?.message).toBe('problem 50')
    expect(entries.at(-1)?.message).toBe('problem 149')
    expect(entries[0]?.at).toBe(AT.toISOString())
  })

  it('truncates messages to 500 and stacks to 2,000 characters', () => {
    const diagnostics = setup()
    const entry = diagnostics.record({
      kind: 'error',
      message: 'm'.repeat(5000),
      stack: 's'.repeat(9000),
      source: 'x'.repeat(1000),
    })
    expect(entry.message).toHaveLength(MESSAGE_MAX_LENGTH)
    expect(entry.stack).toHaveLength(STACK_MAX_LENGTH)
    expect(entry.source?.length).toBeLessThanOrEqual(200)
  })

  it('redacts before storing', () => {
    const diagnostics = setup()
    const entry = diagnostics.record({
      kind: 'error',
      message: 'Could not open "Garage rack" from garage.3mf',
      stack: `at open (${ORIGIN}/assets/a.js:1:2)`,
      source: `${ORIGIN}/view#p=1.eJyrVkrLz8lJLVKyUlAqzy_KSVGqBQBV0wdq`,
    })
    expect(entry).toMatchObject({
      message: 'Could not open "…" from <file>.3mf',
      stack: 'at open (/assets/a.js:1:2)',
      source: '/view',
    })
  })

  it('folds consecutive identical problems into one entry with a repeat count', () => {
    const diagnostics = setup()
    for (let index = 0; index < 3; index++)
      diagnostics.record({ kind: 'error', message: 'loop', source: 'a' })
    diagnostics.record({ kind: 'error', message: 'other' })
    diagnostics.record({ kind: 'error', message: 'loop', source: 'a' })
    expect(diagnostics.entries().map((entry) => [entry.message, entry.repeats])).toEqual([
      ['loop', 2],
      ['other', undefined],
      ['loop', undefined],
    ])
  })

  it('records each error object once, with the component stack appended', () => {
    const diagnostics = setup()
    const error = new Error('render failed')
    error.stack = 'Error: render failed\n    at Bomb (/src/Bomb.tsx:3:9)'
    const entry = diagnostics.recordError(error, {
      source: 'boundary:route',
      componentStack: '\n    at Bomb (/src/Bomb.tsx:3:9)\n    at ErrorBoundary (/src/E.tsx:1:1)',
    })
    expect(entry?.message).toBe('Error: render failed')
    expect(entry?.source).toBe('boundary:route')
    expect(entry?.stack).toBe(
      'at Bomb (/src/Bomb.tsx:3:9)\nComponent stack:\nat Bomb (/src/Bomb.tsx:3:9)\nat ErrorBoundary (/src/E.tsx:1:1)',
    )
    expect(diagnostics.recordError(error, { source: 'route' })).toBeUndefined()
    expect(diagnostics.entries()).toHaveLength(1)
  })

  it('notifies subscribers and keeps entries() stable between changes', () => {
    const diagnostics = setup()
    const listener = vi.fn()
    const unsubscribe = diagnostics.subscribe(listener)
    const before = diagnostics.entries()
    expect(diagnostics.entries()).toBe(before)
    diagnostics.record({ kind: 'warning', message: 'one' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(diagnostics.entries()).not.toBe(before)
    unsubscribe()
    diagnostics.record({ kind: 'warning', message: 'two' })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('install', () => {
  it('records script errors, failed script loads, unhandled rejections and CSP violations', () => {
    const diagnostics = setup()
    const target = new FakeWindow()
    diagnostics.install({ window: target })

    const thrown = new RangeError('bad size')
    target.emit('error', {
      error: thrown,
      message: 'Uncaught RangeError: bad size',
      filename: `${ORIGIN}/assets/index-abc.js`,
      lineno: 3,
      colno: 14,
    })
    target.emit('error', {
      message: 'Script error.',
      error: null,
      filename: '',
      lineno: 0,
      colno: 0,
    })
    target.emit('error', { target: { tagName: 'SCRIPT', src: `${ORIGIN}/assets/Library-x1.js` } })
    target.emit('error', { target: { tagName: 'IMG', src: `${ORIGIN}/photo.png` } })
    target.emit('unhandledrejection', {
      reason: new Error('Failed to fetch dynamically imported module'),
    })
    target.emit('securitypolicyviolation', {
      effectiveDirective: 'script-src-elem',
      blockedURI: 'inline',
      sourceFile: `${ORIGIN}/`,
      lineNumber: 1,
      columnNumber: 5,
      sample: 'alert("my plan name")',
    })

    expect(
      diagnostics.entries().map(({ kind, message, source }) => ({ kind, message, source })),
    ).toEqual([
      { kind: 'error', message: 'RangeError: bad size', source: '/assets/index-abc.js:3:14' },
      { kind: 'error', message: 'Script error.', source: undefined },
      { kind: 'error', message: 'Failed to load script /assets/Library-x1.js', source: 'resource' },
      {
        kind: 'unhandledrejection',
        message: 'Error: Failed to fetch dynamically imported module',
        source: undefined,
      },
      { kind: 'csp', message: 'CSP script-src-elem blocked inline', source: '/:1:5' },
    ])
  })

  it('is idempotent per target and can be undone', () => {
    const diagnostics = setup()
    const target = new FakeWindow()
    const uninstall = diagnostics.install({ window: target })
    expect(diagnostics.install({ window: target })).toBe(uninstall)
    expect(target.count()).toBe(3)
    target.emit('unhandledrejection', { reason: 'once' })
    expect(diagnostics.entries()).toHaveLength(1)
    uninstall()
    expect(target.count()).toBe(0)
    target.emit('unhandledrejection', { reason: 'after uninstall' })
    expect(diagnostics.entries()).toHaveLength(1)
  })

  it('works with a real EventTarget and never throws into the page', () => {
    const diagnostics = setup()
    const target = new EventTarget()
    diagnostics.install({ window: target })
    diagnostics.install({ window: target })
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 42 }))
    expect(diagnostics.entries().map((entry) => entry.message)).toEqual(['Non-error number: 42'])
    // A subscriber that throws must not break recording or the dispatch.
    diagnostics.subscribe(() => {
      throw new Error('listener bug')
    })
    const event = Object.assign(new Event('error'), { message: 'Script error.' })
    expect(() => target.dispatchEvent(event)).not.toThrow()
    expect(diagnostics.entries()).toHaveLength(2)
  })
})

describe('sinks', () => {
  it('loads earlier sessions and saves what this session recorded before the sink was set', async () => {
    const persisted = createMemorySink()
    const earlierSession = setup(persisted)
    earlierSession.record({ kind: 'error', message: 'before the reload' })

    const diagnostics = setup()
    diagnostics.record({ kind: 'warning', message: 'during startup' })
    await diagnostics.setSink(persisted)
    diagnostics.record({ kind: 'warning', message: 'after the sink' })

    expect(diagnostics.entries().map((entry) => entry.message)).toEqual([
      'before the reload',
      'during startup',
      'after the sink',
    ])
    expect((await persisted.load()).map((entry) => entry.message)).toEqual([
      'before the reload',
      'during startup',
      'after the sink',
    ])
    await diagnostics.clear()
    expect(diagnostics.entries()).toEqual([])
    expect(await persisted.load()).toEqual([])
  })

  it('drops malformed stored rows and redacts stored ones again', async () => {
    const rows = [
      { at: AT.toISOString(), kind: 'error', message: 'old "Plan name" leak' },
      { at: AT.toISOString(), kind: 'nonsense', message: 'x' },
      { message: 'no time' },
      null,
    ] as unknown as DiagnosticEntry[]
    const diagnostics = setup()
    await diagnostics.setSink({
      load: () => Promise.resolve(rows),
      append: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    })
    expect(diagnostics.entries().map((entry) => entry.message)).toEqual(['old "…" leak'])
  })

  it('swallows sink failures', async () => {
    const failing: DiagnosticsSink = {
      load: () => Promise.reject(new Error('blocked')),
      append: () => Promise.reject(new Error('quota')),
      clear: () => {
        throw new Error('gone')
      },
    }
    const diagnostics = setup()
    await expect(diagnostics.setSink(failing)).resolves.toBeUndefined()
    expect(() => diagnostics.record({ kind: 'error', message: 'still recorded' })).not.toThrow()
    expect(diagnostics.entries()).toHaveLength(1)
    await expect(diagnostics.clear()).resolves.toBeUndefined()
  })
})
