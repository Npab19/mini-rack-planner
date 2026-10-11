import { useEffect, useRef, useSyncExternalStore } from 'react'

/**
 * A one-way command from the toolbar to whichever component can carry it out (the rack fits
 * itself, a dialog opens for "Add at U…"). Handlers register while mounted; `request` runs them
 * and says whether anyone did. Module-level on purpose: the toolbar and the rack are siblings and
 * neither should re-render for the other.
 *
 * A command may carry an argument (`A`), e.g. what "Add at U…" should add; `void` for none.
 */
export interface CommandChannel<A = void> {
  /** Runs the registered handler(s); false when none is registered. */
  request: (arg: A) => boolean
  /** Registers a handler; returns the unregister function. */
  subscribe: (handler: (arg: A) => void) => () => void
  /** Whether a handler is registered now. */
  available: () => boolean
  /** Registers `handler` while the calling component is mounted (always calls the latest one). */
  useHandler: (handler: (arg: A) => void) => void
  /** Whether a handler is registered (re-renders when that changes). */
  useAvailable: () => boolean
}

export interface CommandChannelOptions {
  /**
   * Only the most recently registered handler runs (a command that opens a dialog must open
   * exactly one). Otherwise every handler runs.
   */
  exclusive?: boolean
}

export function createCommandChannel<A = void>({
  exclusive = false,
}: CommandChannelOptions = {}): CommandChannel<A> {
  const handlers = new Set<(arg: A) => void>()
  const watchers = new Set<() => void>()

  // Both loops run over a snapshot: a handler may unregister (or register) others as it runs.
  function notify(): void {
    for (const watcher of Array.from(watchers)) watcher()
  }

  function subscribe(handler: (arg: A) => void): () => void {
    // A wrapper per registration, so the same function registered twice counts twice.
    const entry = (arg: A) => handler(arg)
    handlers.add(entry)
    notify()
    return () => {
      if (handlers.delete(entry)) notify()
    }
  }

  function request(arg: A): boolean {
    const registered = Array.from(handlers)
    if (registered.length === 0) return false
    if (exclusive) registered.at(-1)?.(arg)
    else for (const handler of registered) handler(arg)
    return true
  }

  function available(): boolean {
    return handlers.size > 0
  }

  function watch(watcher: () => void): () => void {
    watchers.add(watcher)
    return () => watchers.delete(watcher)
  }

  function useHandler(handler: (arg: A) => void): void {
    const latest = useRef(handler)
    useEffect(() => {
      latest.current = handler
    })
    useEffect(() => subscribe((arg) => latest.current(arg)), [])
  }

  function useAvailable(): boolean {
    return useSyncExternalStore(watch, available, () => false)
  }

  return { request, subscribe, available, useHandler, useAvailable }
}
