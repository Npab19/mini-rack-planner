/** Formatting and parsing for the Settings page (and the backup nudge), in the user's locale. */

const DAY_MS = 86_400_000
const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const

/** "1.2 MB": decimal units, like the browsers' own storage pages. */
export function formatBytes(bytes: number, locale?: string): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 })
  return `${number.format(value)} ${BYTE_UNITS[unit] ?? 'B'}`
}

/** "12%", "0.4%", or "under 0.1%" for a tiny non-zero share. */
export function formatShare(part: number, whole: number, locale?: string): string {
  const fraction = whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0
  if (fraction > 0 && fraction < 0.001) {
    return `under ${new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(0.001)}`
  }
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: fraction < 0.1 ? 1 : 0,
  }).format(fraction)
}

function parseTime(iso: string): Date | undefined {
  const time = Date.parse(iso)
  return Number.isFinite(time) ? new Date(time) : undefined
}

/** "11 Oct 2026" (medium date style of the locale); the input unchanged if it is no date. */
export function formatDate(iso: string, locale?: string): string {
  const date = parseTime(iso)
  return date === undefined
    ? iso
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date)
}

/** "11 Oct 2026, 14:05". */
export function formatDateTime(iso: string, locale?: string): string {
  const date = parseTime(iso)
  return date === undefined
    ? iso
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Whole calendar days from `iso` to `now` in local time (0 = the same day). */
export function daysSince(iso: string, now: Date = new Date()): number | undefined {
  const date = parseTime(iso)
  if (date === undefined) return undefined
  // Rounding absorbs the 23- and 25-hour days around daylight-saving changes.
  return Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS)
}

/** "today", "yesterday", "3 days ago"; undefined if `iso` is no date. */
export function formatDaysAgo(
  iso: string,
  now: Date = new Date(),
  locale?: string,
): string | undefined {
  const days = daysSince(iso, now)
  if (days === undefined) return undefined
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-Math.max(0, days), 'day')
}

/** "1 plan", "3 plans". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

export type ParsedDecimal =
  { kind: 'empty' } | { kind: 'number'; value: number } | { kind: 'invalid' }

/**
 * A non-negative decimal as typed: "22", "22.5", "22,5" (decimal comma), ".5". Signs, exponents,
 * grouping separators and anything else are invalid, so a typo never saves a surprising number.
 */
export function parseDecimal(text: string): ParsedDecimal {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'empty' }
  if (!/^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(trimmed)) return { kind: 'invalid' }
  const value = Number(trimmed.replace(',', '.'))
  return Number.isFinite(value) ? { kind: 'number', value } : { kind: 'invalid' }
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/** Plain digits with at most `decimals` places ("20", "22.5"); empty for no value. */
export function formatDecimal(value: number | undefined, decimals: number): string {
  return value === undefined || !Number.isFinite(value) ? '' : String(roundTo(value, decimals))
}
