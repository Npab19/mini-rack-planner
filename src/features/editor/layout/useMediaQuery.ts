import { useCallback, useSyncExternalStore } from 'react'

/**
 * The editor's layout breakpoint, Tailwind's `lg` (64rem): from here up the panels sit in columns
 * around the rack; below it the rack fills the screen and the panels open as sheets.
 */
export const DESKTOP_QUERY = '(min-width: 64rem)'

/** Coarse pointers (touch): copy says "tap" instead of "click". */
export const COARSE_POINTER_QUERY = '(pointer: coarse)'

function canMatch(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
}

/** Whether `query` matches now; `fallback` where matchMedia is missing (jsdom, old engines). */
export function matchesMedia(query: string, fallback: boolean): boolean {
  return canMatch() ? window.matchMedia(query).matches : fallback
}

/** A media query as React state, following changes (window resize, rotation, zoom). */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!canMatch()) return () => undefined
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => matchesMedia(query, fallback),
    () => fallback,
  )
}

/** Columns layout (lg and up). Without matchMedia the desktop layout is used. */
export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY, true)
}

export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE_POINTER_QUERY, false)
}
