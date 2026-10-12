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

// The choice made in another tab of this origin applies here too (`storage` fires in the other
// tabs only; a null key means storage was cleared).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return
    const next = readPreference()
    if (next === preference) return
    preference = next
    apply()
  })
}

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

/**
 * Accent (brand) colour preference. src/index.css defines a `data-accent` block per preset; the
 * default has none, so its attribute is removed. `public/theme-init.js` applies it before first
 * paint using the same key and list.
 */
export type AccentPreference = 'indigo' | 'blue' | 'teal' | 'green' | 'orange' | 'rose' | 'graphite'

/** Every accent, default first. */
export const ACCENTS: ReadonlyArray<{ id: AccentPreference; label: string }> = [
  { id: 'indigo', label: 'Indigo' },
  { id: 'blue', label: 'Blue' },
  { id: 'teal', label: 'Teal' },
  { id: 'green', label: 'Green' },
  { id: 'orange', label: 'Orange' },
  { id: 'rose', label: 'Rose' },
  { id: 'graphite', label: 'Graphite' },
]

export const DEFAULT_ACCENT: AccentPreference = 'indigo'

const ACCENT_KEY = 'mrp-accent'
const accentListeners = new Set<() => void>()

export function isAccentPreference(value: unknown): value is AccentPreference {
  return ACCENTS.some((accent) => accent.id === value)
}

function readAccent(): AccentPreference {
  try {
    const value = window.localStorage.getItem(ACCENT_KEY)
    return isAccentPreference(value) ? value : DEFAULT_ACCENT
  } catch {
    return DEFAULT_ACCENT
  }
}

let accent: AccentPreference = typeof window === 'undefined' ? DEFAULT_ACCENT : readAccent()

function applyAccent(): void {
  if (accent === DEFAULT_ACCENT) delete document.documentElement.dataset.accent
  else document.documentElement.dataset.accent = accent
  for (const listener of accentListeners) listener()
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== ACCENT_KEY) return
    const next = readAccent()
    if (next === accent) return
    accent = next
    applyAccent()
  })
}

export function setAccent(next: AccentPreference): void {
  accent = next
  try {
    window.localStorage.setItem(ACCENT_KEY, next)
  } catch {
    // Storage may be unavailable (private mode); the choice still applies for this session.
  }
  applyAccent()
}

function subscribeAccent(listener: () => void): () => void {
  accentListeners.add(listener)
  return () => accentListeners.delete(listener)
}

export function useAccent(): {
  accent: AccentPreference
  setAccent: (next: AccentPreference) => void
} {
  const current = useSyncExternalStore(
    subscribeAccent,
    () => accent,
    () => DEFAULT_ACCENT,
  )
  return { accent: current, setAccent }
}
