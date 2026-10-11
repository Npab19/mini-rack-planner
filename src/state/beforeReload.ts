/**
 * Work that must finish before the page reloads (a pending autosave). The update prompt ("New
 * version available - Reload") and the status banners call `reloadApp()` instead of
 * `location.reload()`; stores register their flush with `registerBeforeReload`.
 */

export type BeforeReloadHook = () => unknown

/** A stuck database must not stop the reload forever. */
export const BEFORE_RELOAD_TIMEOUT_MS = 3000

const hooks = new Set<BeforeReloadHook>()

/** Returns an unregister function. */
export function registerBeforeReload(hook: BeforeReloadHook): () => void {
  hooks.add(hook)
  return () => {
    hooks.delete(hook)
  }
}

/** Runs every hook (in parallel); resolves when all settle or after the timeout. Never throws. */
export async function runBeforeReload(timeoutMs = BEFORE_RELOAD_TIMEOUT_MS): Promise<void> {
  const pending = [...hooks].map(async (hook) => hook())
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  await Promise.race([Promise.allSettled(pending), timeout])
  clearTimeout(timer)
}

/** Flushes pending work, then reloads the page. */
export async function reloadApp(): Promise<void> {
  await runBeforeReload()
  if (typeof location !== 'undefined') location.reload()
}
