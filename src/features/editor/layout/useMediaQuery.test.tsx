import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DESKTOP_QUERY, matchesMedia, useIsDesktop, useMediaQuery } from './useMediaQuery'

/** A matchMedia whose answers the test changes, notifying listeners like a resize would. */
function installMatchMedia(initial: Record<string, boolean>) {
  const state = { ...initial }
  const listeners = new Map<string, Set<() => void>>()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return state[query] ?? false
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => {
        const set = listeners.get(query) ?? new Set()
        set.add(listener)
        listeners.set(query, set)
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.get(query)?.delete(listener)
      },
    }),
  })
  return {
    set(query: string, matches: boolean) {
      state[query] = matches
      for (const listener of listeners.get(query) ?? []) listener()
    },
    listenerCount: (query: string) => listeners.get(query)?.size ?? 0,
  }
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'matchMedia')
})

describe('useMediaQuery', () => {
  it('follows the query as the window changes, and stops listening when unmounted', () => {
    const media = installMatchMedia({ [DESKTOP_QUERY]: true })
    const { result, unmount } = renderHook(() => useIsDesktop())
    expect(result.current).toBe(true)
    act(() => media.set(DESKTOP_QUERY, false))
    expect(result.current).toBe(false)
    expect(media.listenerCount(DESKTOP_QUERY)).toBe(1)
    unmount()
    expect(media.listenerCount(DESKTOP_QUERY)).toBe(0)
  })

  it('uses the fallback where matchMedia is missing (desktop for the editor)', () => {
    expect(matchesMedia('(pointer: coarse)', false)).toBe(false)
    expect(renderHook(() => useIsDesktop()).result.current).toBe(true)
    expect(renderHook(() => useMediaQuery('(pointer: coarse)')).result.current).toBe(false)
  })
})
