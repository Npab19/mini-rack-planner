// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCENTS, DEFAULT_ACCENT, resolveTheme, setAccent, setTheme } from './theme'

afterEach(() => {
  vi.restoreAllMocks()
  setTheme('system')
  setAccent(DEFAULT_ACCENT)
  localStorage.clear()
})

/** The accent attribute on <html>, or null when it is absent. */
function accentAttribute(): string | null {
  return document.documentElement.getAttribute('data-accent')
}

describe('theme', () => {
  it('follows a theme chosen in another tab', () => {
    setTheme('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    // What the other tab wrote; the browser then fires `storage` in this one.
    localStorage.setItem('mrp-theme', 'dark')
    window.dispatchEvent(new StorageEvent('storage', { key: 'mrp-theme', newValue: 'dark' }))
    expect(resolveTheme()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('ignores other keys', () => {
    setTheme('dark')
    localStorage.setItem('mrp-theme', 'light')
    window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }))
    expect(resolveTheme()).toBe('dark')
  })
})

describe('accent', () => {
  it('lists the default first', () => {
    expect(ACCENTS[0]?.id).toBe(DEFAULT_ACCENT)
    expect(new Set(ACCENTS.map(({ id }) => id)).size).toBe(ACCENTS.length)
  })

  it('applies and stores a choice, and removes the attribute for the default', () => {
    setAccent('teal')
    expect(accentAttribute()).toBe('teal')
    expect(localStorage.getItem('mrp-accent')).toBe('teal')
    setAccent(DEFAULT_ACCENT)
    expect(accentAttribute()).toBeNull()
    expect(localStorage.getItem('mrp-accent')).toBe(DEFAULT_ACCENT)
  })

  it('follows an accent chosen in another tab, and treats an unknown one as the default', () => {
    localStorage.setItem('mrp-accent', 'rose')
    window.dispatchEvent(new StorageEvent('storage', { key: 'mrp-accent', newValue: 'rose' }))
    expect(accentAttribute()).toBe('rose')
    localStorage.setItem('mrp-accent', 'chartreuse')
    window.dispatchEvent(new StorageEvent('storage', { key: 'mrp-accent', newValue: 'chartreuse' }))
    expect(accentAttribute()).toBeNull()
  })

  it('still applies the choice when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    setAccent('orange')
    expect(accentAttribute()).toBe('orange')
  })

  it('falls back to the default when storage cannot be read', () => {
    setAccent('blue')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    expect(accentAttribute()).toBeNull()
  })
})

describe('public/theme-init.js', () => {
  // jsdom gives modules an http: URL, so this resolves from the project root (where Vitest runs).
  const script = readFileSync(join(process.cwd(), 'public/theme-init.js'), 'utf8')
  const run = () => {
    // jsdom has no matchMedia; the script treats that as "light".
    new Function(script)()
  }

  afterEach(() => {
    document.documentElement.removeAttribute('data-accent')
    document.documentElement.classList.remove('dark')
  })

  it('applies every non-default accent before first paint, and nothing for the default', () => {
    for (const { id } of ACCENTS) {
      document.documentElement.removeAttribute('data-accent')
      localStorage.setItem('mrp-accent', id)
      run()
      expect(accentAttribute()).toBe(id === DEFAULT_ACCENT ? null : id)
    }
  })

  it('ignores unknown accents and blocked storage', () => {
    localStorage.setItem('mrp-accent', 'chartreuse')
    run()
    expect(accentAttribute()).toBeNull()
    localStorage.setItem('mrp-theme', 'dark')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    run()
    expect(accentAttribute()).toBeNull()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})
