/**
 * Stale deploys. After an update the old build's hashed chunks are gone, so the next lazy import
 * in an open tab fails. Every such failure ends in `notifyNewVersion`: it saves pending work
 * through the beforeReload hooks (e.g. the plan autosave flush), then shows a toast with a Reload
 * action that stays until used.
 *
 * Sources: Vite's `vite:preloadError` and stale-import rejections nobody caught (both via
 * `installUpdatePrompt`), error boundaries and RouteError (`isStaleChunkError`), and worker
 * start-up failures (call `notifyNewVersion` directly).
 */
import { toast } from 'sonner'
import * as diagnostics from '@/lib/diagnostics'
import { registerBeforeReload, reloadApp, runBeforeReload } from '@/state/beforeReload'

// One registry for the whole app: the plan store registers its autosave flush in
// src/state/beforeReload.ts, and every app-initiated reload goes through its reloadApp.
export { registerBeforeReload, reloadApp, runBeforeReload }
export type { BeforeReloadHook } from '@/state/beforeReload'

export const UPDATE_TOAST_ID = 'app-update-available'

// Chromium, Safari and Firefox wordings of a failed dynamic import, Vite's CSS preload failure,
// and the HTML fallback served in place of a missing script.
const STALE_CHUNK_PATTERN =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|MIME type/i

/** True when a lazy chunk from an older deploy is gone (common right after an update). */
export function isStaleChunkError(error: unknown): boolean {
  if (typeof error === 'string') return STALE_CHUNK_PATTERN.test(error)
  if (typeof error !== 'object' || error === null) return false
  const { name, message } = error as { name?: unknown; message?: unknown }
  if (name === 'ChunkLoadError') return true
  return typeof message === 'string' && STALE_CHUNK_PATTERN.test(message)
}

export interface UpdateToast {
  title: string
  description: string
  actionLabel: string
  onAction: () => void
}

export interface UpdatePromptDeps {
  showToast: (update: UpdateToast) => void
  /** Saves pending work: every registered beforeReload hook. Never rejects. */
  runBeforeReload: () => Promise<void>
  /** Saves pending work again (edits since the prompt), then reloads the page. */
  reloadApp: () => Promise<void>
  record?: (input: diagnostics.DiagnosticInput) => void
}

export interface NotifyOptions {
  /** What noticed the new version, for diagnostics, e.g. "vite:preloadError". */
  source?: string
  error?: unknown
}

export interface UpdatePrompt {
  /** Saves now and shows the persistent "new version" toast. Idempotent. */
  notifyNewVersion(options?: NotifyOptions): void
  /** True once a new version was noticed: later route errors are most likely the stale build. */
  isUpdatePending(): boolean
  /** Listens on `target` (default: the global scope). Idempotent per target. */
  install(options?: { target?: EventTarget }): () => void
}

export function createUpdatePrompt(deps: UpdatePromptDeps): UpdatePrompt {
  const installed = new WeakMap<EventTarget, () => void>()
  let pending = false

  function notifyNewVersion(options: NotifyOptions = {}): void {
    if (!pending) {
      pending = true
      const cause =
        options.error === undefined ? '' : `: ${diagnostics.describeError(options.error).message}`
      deps.record?.({
        kind: 'warning',
        message: `New version available${cause}`,
        source: options.source ?? 'update-prompt',
      })
      // Start saving now; Reload saves again before it reloads.
      deps.runBeforeReload().catch(() => undefined)
    }
    // Same toast id every time: sonner updates it in place instead of stacking copies.
    deps.showToast({
      title: 'A new version is available',
      description: 'Reload to update. Your changes are saved first.',
      actionLabel: 'Reload',
      onAction: () => void deps.reloadApp(),
    })
  }

  function install(options: { target?: EventTarget } = {}): () => void {
    const target = options.target ?? globalThis
    const existing = installed.get(target)
    if (existing !== undefined) return existing

    const onPreloadError = (event: Event): void => {
      // Without this Vite rethrows; with it the failed import resolves to undefined, so the
      // route that wanted it fails next and RouteError shows the update (see isUpdatePending).
      event.preventDefault()
      notifyNewVersion({
        source: 'vite:preloadError',
        error: (event as Event & { payload?: unknown }).payload,
      })
    }
    const onRejection = (event: Event): void => {
      const reason = (event as Event & { reason?: unknown }).reason
      if (isStaleChunkError(reason)) {
        notifyNewVersion({ source: 'unhandledrejection', error: reason })
      }
    }

    target.addEventListener('vite:preloadError', onPreloadError)
    target.addEventListener('unhandledrejection', onRejection)
    const uninstall = (): void => {
      target.removeEventListener('vite:preloadError', onPreloadError)
      target.removeEventListener('unhandledrejection', onRejection)
      installed.delete(target)
    }
    installed.set(target, uninstall)
    return uninstall
  }

  return { notifyNewVersion, isUpdatePending: () => pending, install }
}

function showUpdateToast(update: UpdateToast): void {
  toast.info(update.title, {
    id: UPDATE_TOAST_ID,
    description: update.description,
    // Stays until used: the old build cannot load the code it is missing.
    duration: Number.POSITIVE_INFINITY,
    dismissible: false,
    action: {
      label: update.actionLabel,
      onClick: (event) => {
        // Keep the toast up while the save finishes and the page reloads.
        event.preventDefault()
        update.onAction()
      },
    },
  })
}

const appUpdatePrompt = createUpdatePrompt({
  showToast: showUpdateToast,
  runBeforeReload: () => runBeforeReload(),
  reloadApp,
  record: diagnostics.record,
})

export const notifyNewVersion = appUpdatePrompt.notifyNewVersion
export const isUpdatePending = appUpdatePrompt.isUpdatePending

/** Call once in main.tsx, before the first render (the first lazy route import can fail too). */
export function installUpdatePrompt(options?: { target?: EventTarget }): () => void {
  return appUpdatePrompt.install(options)
}
