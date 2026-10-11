/**
 * "2026-10-11": the date in the user's own time zone, for file names. `toISOString()` gives the
 * UTC date, which near midnight is a different day from the one on the user's calendar.
 */
export function localDateStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
