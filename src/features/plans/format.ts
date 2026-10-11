/** Text for the Plans page: relative times, counts and export file names. */
import { localDateStamp } from '@/lib/date'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** Longer ago than this, a date reads better than "23 days ago". */
const RELATIVE_LIMIT_MS = 7 * DAY_MS
const MAX_SLUG_LENGTH = 60

function relativeFormatter(locale?: string): Intl.RelativeTimeFormat | undefined {
  // Every current browser has it; the guard keeps an old one from breaking the page.
  if (typeof Intl.RelativeTimeFormat !== 'function') return undefined
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
}

/** "11 Oct 2026, 14:05" in the user's locale; the input when it is no date. */
export function formatDateTime(iso: string, locale?: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(time)
}

/**
 * "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago", then "on 11 Oct 2026".
 * Times slightly in the future (another device's clock) read as "just now".
 */
export function formatRelativeTime(iso: string, now: number, locale?: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return 'at an unknown time'
  const ago = Math.max(0, now - time)
  if (ago >= RELATIVE_LIMIT_MS) {
    return `on ${new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(time)}`
  }
  if (ago < MINUTE_MS) return 'just now'
  const format = relativeFormatter(locale)
  const [value, unit, plain]: [number, Intl.RelativeTimeFormatUnit, string] =
    ago < HOUR_MS
      ? [Math.round(ago / MINUTE_MS), 'minute', 'min']
      : ago < DAY_MS
        ? [Math.round(ago / HOUR_MS), 'hour', 'h']
        : [Math.round(ago / DAY_MS), 'day', 'd']
  return format === undefined ? `${value} ${plain} ago` : format.format(-value, unit)
}

/** "1 plan", "3 plans". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

/** A file-name-safe version of a plan name: "KWS 9U → 12U" -> "kws-9u-12u". */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
  return slug === '' ? 'plan' : slug
}

/**
 * "kws-9u-12u-2026-10-11.rackplan.json": a single-plan backup (the backup format with one plan),
 * dated in local time like the user's own calendar.
 */
export function planFileName(name: string, date: Date): string {
  return `${slugify(name)}-${localDateStamp(date)}.rackplan.json`
}
