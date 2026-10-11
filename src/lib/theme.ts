import { useSyncExternalStore } from 'react'

/** Colour theme preference. `public/theme-init.js` applies it before first paint using the same key. */
export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'mrp-theme'
const listeners = new Set<() => void>()
const media =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

function readPreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

let preference: ThemePreference = typeof window === 'undefined' ? 'system' : readPreference()

export function resolveTheme(pref: ThemePreference = preference): ResolvedTheme {
  if (pref === 'system') return media?.matches ? 'dark' : 'light'
  return pref
}

function apply(): void {
  document.documentElement.classList.toggle('dark', resolveTheme() === 'dark')
  for (const listener of listeners) listener()
}

media?.addEventListener('change', () => {
  if (preference === 'system') apply()
})

export function setTheme(next: ThemePreference): void {
  preference = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Storage may be unavailable (private mode); the choice still applies for this session.
  }
  apply()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTheme(): {
  theme: ThemePreference
  resolvedTheme: ResolvedTheme
  setTheme: (next: ThemePreference) => void
} {
  const theme = useSyncExternalStore(
    subscribe,
    () => preference,
    () => 'system' as const,
  )
  const resolvedTheme = useSyncExternalStore(
    subscribe,
    () => resolveTheme(),
    () => 'light' as const,
  )
  return { theme, resolvedTheme, setTheme }
}
