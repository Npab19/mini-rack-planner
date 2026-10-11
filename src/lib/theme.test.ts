// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { resolveTheme, setTheme } from './theme'

afterEach(() => {
  setTheme('system')
})

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
