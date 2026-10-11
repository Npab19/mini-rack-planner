import { describe, expect, it } from 'vitest'
import {
  daysSince,
  formatBytes,
  formatDecimal,
  formatShare,
  parseDecimal,
  plural,
  roundTo,
} from './format'

describe('formatBytes', () => {
  it('uses decimal units with one decimal above bytes', () => {
    expect(formatBytes(0, 'en')).toBe('0 B')
    expect(formatBytes(999, 'en')).toBe('999 B')
    expect(formatBytes(1234, 'en')).toBe('1.2 kB')
    expect(formatBytes(5_300_000, 'en')).toBe('5.3 MB')
    expect(formatBytes(2_147_483_648, 'en')).toBe('2.1 GB')
    expect(formatBytes(-5, 'en')).toBe('0 B')
  })

  it('follows the locale for the number', () => {
    expect(formatBytes(1500, 'de')).toBe('1,5 kB')
  })
})

describe('formatShare', () => {
  it('shows small shares with a decimal and tiny ones as "under 0.1%"', () => {
    expect(formatShare(25, 100, 'en')).toBe('25%')
    expect(formatShare(4, 1000, 'en')).toBe('0.4%')
    expect(formatShare(1, 1_000_000, 'en')).toBe('under 0.1%')
    expect(formatShare(0, 100, 'en')).toBe('0%')
    expect(formatShare(5, 0, 'en')).toBe('0%')
  })
})

describe('parseDecimal', () => {
  it('reads plain decimals with a point or a comma', () => {
    expect(parseDecimal('22')).toEqual({ kind: 'number', value: 22 })
    expect(parseDecimal(' 22.5 ')).toEqual({ kind: 'number', value: 22.5 })
    expect(parseDecimal('22,5')).toEqual({ kind: 'number', value: 22.5 })
    expect(parseDecimal('.5')).toEqual({ kind: 'number', value: 0.5 })
    expect(parseDecimal('22.')).toEqual({ kind: 'number', value: 22 })
    expect(parseDecimal('')).toEqual({ kind: 'empty' })
    expect(parseDecimal('   ')).toEqual({ kind: 'empty' })
  })

  it('refuses signs, exponents, grouping and words', () => {
    for (const text of ['-1', '+1', '1e3', '1,000.5', '1.2.3', 'abc', '12 kg', 'Infinity']) {
      expect(parseDecimal(text)).toEqual({ kind: 'invalid' })
    }
  })
})

describe('roundTo and formatDecimal', () => {
  it('drops floating-point noise and trailing zeros', () => {
    expect(roundTo(0.07 * 100, 1)).toBe(7)
    expect(formatDecimal(0.1 * 3, 2)).toBe('0.3')
    expect(formatDecimal(20, 2)).toBe('20')
    expect(formatDecimal(22.456, 2)).toBe('22.46')
    expect(formatDecimal(undefined, 2)).toBe('')
  })
})

describe('daysSince', () => {
  it('counts calendar days in local time', () => {
    const now = new Date(2026, 9, 11, 9, 0)
    expect(daysSince(new Date(2026, 9, 11, 0, 5).toISOString(), now)).toBe(0)
    expect(daysSince(new Date(2026, 9, 10, 23, 55).toISOString(), now)).toBe(1)
    expect(daysSince(new Date(2026, 8, 27, 12, 0).toISOString(), now)).toBe(14)
    expect(daysSince('not a date', now)).toBeUndefined()
  })
})

describe('plural', () => {
  it('picks the form by count', () => {
    expect(plural(1, 'plan')).toBe('1 plan')
    expect(plural(0, 'plan')).toBe('0 plans')
    expect(plural(3, 'custom part')).toBe('3 custom parts')
  })
})
