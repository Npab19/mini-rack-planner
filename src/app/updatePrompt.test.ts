import { afterEach, describe, expect, it, vi } from 'vitest'
import * as diagnostics from '@/lib/diagnostics'
import {
  createUpdatePrompt,
  isStaleChunkError,
  isUpdatePending,
  notifyNewVersion,
  registerBeforeReload,
  UPDATE_TOAST_ID,
  type UpdatePromptDeps,
  type UpdateToast,
} from './updatePrompt'

const { info } = vi.hoisted(() => ({ info: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info } }))

afterEach(() => {
  vi.unstubAllGlobals()
})

function setup(overrides: Partial<UpdatePromptDeps> = {}) {
  const calls: string[] = []
  const toasts: UpdateToast[] = []
  const deps = {
    showToast: vi.fn((update: UpdateToast) => {
      calls.push('toast')
      toasts.push(update)
    }),
    runBeforeReload: vi.fn(() => {
      calls.push('save')
      return Promise.resolve()
    }),
    reloadApp: vi.fn(() => {
      calls.push('reload')
      return Promise.resolve()
    }),
    record: vi.fn(),
    ...overrides,
  }
  return { prompt: createUpdatePrompt(deps), deps, calls, toasts }
}

/** The event Vite dispatches on window when a lazy chunk or its CSS fails to load. */
function preloadErrorEvent(payload: unknown): Event {
  return Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload })
}

const STALE = new TypeError(
  'Failed to fetch dynamically imported module: http://localhost:8080/assets/LibraryPage-x1.js',
)

describe('isStaleChunkError', () => {
  it('recognizes failed lazy imports in every engine, and nothing else', () => {
    expect(isStaleChunkError(STALE)).toBe(true)
    expect(isStaleChunkError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isStaleChunkError(new TypeError('error loading dynamically imported module'))).toBe(true)
    expect(isStaleChunkError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true)
    expect(isStaleChunkError({ name: 'ChunkLoadError', message: '' })).toBe(true)
    expect(isStaleChunkError('Failed to fetch dynamically imported module')).toBe(true)
    expect(isStaleChunkError(new TypeError('x is undefined'))).toBe(false)
    expect(isStaleChunkError(undefined)).toBe(false)
    expect(isStaleChunkError({})).toBe(false)
  })
})

describe('createUpdatePrompt', () => {
  it('on vite:preloadError: prevents the rethrow, saves, then shows the reload toast', () => {
    const { prompt, deps, calls, toasts } = setup()
    const target = new EventTarget()
    prompt.install({ target })

    const event = preloadErrorEvent(STALE)
    target.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(calls).toEqual(['save', 'toast'])
    expect(prompt.isUpdatePending()).toBe(true)
    expect(toasts[0]).toMatchObject({ title: 'A new version is available', actionLabel: 'Reload' })
    expect(deps.record).toHaveBeenCalledWith({
      kind: 'warning',
      message: `New version available: TypeError: ${STALE.message}`,
      source: 'vite:preloadError',
    })

    // The action saves again (edits made since the toast) and reloads.
    toasts[0]?.onAction()
    expect(calls).toEqual(['save', 'toast', 'reload'])
  })

  it('notifies once however many chunks fail, keeping one toast up', () => {
    const { prompt, deps } = setup()
    prompt.notifyNewVersion({ source: 'a' })
    prompt.notifyNewVersion({ source: 'b' })
    expect(deps.runBeforeReload).toHaveBeenCalledTimes(1)
    expect(deps.record).toHaveBeenCalledTimes(1)
    expect(deps.showToast).toHaveBeenCalledTimes(2)
  })

  it('still shows the prompt when saving fails', async () => {
    const { prompt, deps } = setup({ runBeforeReload: () => Promise.reject(new Error('quota')) })
    prompt.notifyNewVersion()
    expect(deps.showToast).toHaveBeenCalledTimes(1)
    // Let the failed save settle: an unhandled rejection would fail the run.
    await Promise.resolve()
  })

  it('reacts to stale-import rejections nobody caught, and to nothing else', () => {
    const { prompt, deps } = setup()
    const target = new EventTarget()
    prompt.install({ target })
    target.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), { reason: new Error('nope') }),
    )
    expect(deps.showToast).not.toHaveBeenCalled()
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: STALE }))
    expect(deps.showToast).toHaveBeenCalledTimes(1)
  })

  it('installs once per target and can be undone', () => {
    const { prompt, deps } = setup()
    const target = new EventTarget()
    const uninstall = prompt.install({ target })
    expect(prompt.install({ target })).toBe(uninstall)
    uninstall()
    const event = preloadErrorEvent(STALE)
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(deps.showToast).not.toHaveBeenCalled()
  })
})

describe('app-wide prompt', () => {
  it('flushes the shared beforeReload hooks and shows a persistent sonner toast', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    const flush = vi.fn()
    const unregister = registerBeforeReload(flush)

    notifyNewVersion({ source: 'worker', error: new Error('Worker script failed to load') })

    expect(isUpdatePending()).toBe(true)
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1))
    expect(diagnostics.getEntries().at(-1)).toMatchObject({
      kind: 'warning',
      message: 'New version available: Error: Worker script failed to load',
      source: 'worker',
    })
    expect(info).toHaveBeenCalledWith(
      'A new version is available',
      expect.objectContaining({
        id: UPDATE_TOAST_ID,
        duration: Number.POSITIVE_INFINITY,
        dismissible: false,
        action: expect.objectContaining({ label: 'Reload' }),
      }),
    )

    const options = info.mock.calls[0]?.[1] as {
      action: { onClick: (event: { preventDefault: () => void }) => void }
    }
    const click = { preventDefault: vi.fn() }
    options.action.onClick(click)
    // The toast stays up until the page actually reloads.
    expect(click.preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(flush).toHaveBeenCalledTimes(2)
    unregister()
  })
})
