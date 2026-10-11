import { describe, expect, it } from 'vitest'
import { formatRelativeTime, planFileName, plural, slugify } from './format'

const NOW = Date.parse('2026-10-11T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('formatRelativeTime', () => {
  it('reads like a person would say it', () => {
    expect(formatRelativeTime(ago(20_000), NOW, 'en')).toBe('just now')
    expect(formatRelativeTime(ago(5 * MINUTE), NOW, 'en')).toBe('5 minutes ago')
    expect(formatRelativeTime(ago(3 * HOUR), NOW, 'en')).toBe('3 hours ago')
    expect(formatRelativeTime(ago(DAY), NOW, 'en')).toBe('yesterday')
    expect(formatRelativeTime(ago(4 * DAY), NOW, 'en')).toBe('4 days ago')
  })

  it('switches to a date after a week, and copes with odd input', () => {
    // ICU versions differ on "Sep" vs "Sept".
    expect(formatRelativeTime('2026-09-01T10:00:00.000Z', NOW, 'en-GB')).toMatch(
      /^on 1 Sept? 2026$/,
    )
    // Another device's clock running ahead.
    expect(formatRelativeTime(ago(-5 * MINUTE), NOW, 'en')).toBe('just now')
    expect(formatRelativeTime('not a date', NOW, 'en')).toBe('at an unknown time')
  })
})

describe('file names', () => {
  it('slugs plan names safely', () => {
    expect(slugify('KWS 9U → 12U')).toBe('kws-9u-12u')
    expect(slugify('  Garage rack (copy) ')).toBe('garage-rack-copy')
    expect(slugify('Café rack')).toBe('cafe-rack')
    expect(slugify('→ ✓ ★')).toBe('plan')
    expect(slugify('x'.repeat(100))).toHaveLength(60)
  })

  it('names a single-plan export with the local date', () => {
    expect(planFileName('Sample: KWS 9U → 12U', new Date(2026, 9, 11, 23, 30))).toBe(
      'sample-kws-9u-12u-2026-10-11.rackplan.json',
    )
  })

  it('pluralizes counts', () => {
    expect(plural(1, 'plan')).toBe('1 plan')
    expect(plural(3, 'plan')).toBe('3 plans')
    expect(plural(2, 'entry', 'entries')).toBe('2 entries')
  })
})
