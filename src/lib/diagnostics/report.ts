/**
 * The plain-text diagnostics report (Copy diagnostics) and the prefilled GitHub issue link.
 * The report holds versions, browser facts and recent problems: never plan contents, names,
 * notes or file names. Entries are redacted again here, whichever app version stored them.
 */
import { redact, truncate } from './sanitize'
import {
  MESSAGE_MAX_LENGTH,
  SOURCE_MAX_LENGTH,
  STACK_MAX_LENGTH,
  type DiagnosticEntry,
  type DiagnosticKind,
} from './store'

export const REPORT_MAX_LENGTH = 6000
/** Prefilled issue links stay below this length (GitHub rejects much longer URLs). */
export const ISSUE_URL_MAX_LENGTH = 8000
export const ISSUE_NEW_URL = 'https://github.com/Npab19/mini-rack-planner/issues/new'
/** The issue form in .github/ISSUE_TEMPLATE/bug.yml and the ids of the fields we prefill. */
export const ISSUE_TEMPLATE = 'bug.yml'
const DIAGNOSTICS_FIELD = 'diagnostics'
const VERSION_FIELD = 'version'

export interface StorageInfo {
  persisted?: boolean
  /** Bytes. */
  usage?: number
  /** Bytes. */
  quota?: number
}

export interface ReportInput {
  appVersion: string
  gitSha: string
  planSchema: number | string
  catalogRevision?: string
  userAgent: string
  secureContext: boolean
  /** Missing where `navigator.storage` is (plain-HTTP LAN origins). */
  storage?: StorageInfo
  /** Oldest first, as `entries()` returns them. */
  entries: readonly DiagnosticEntry[]
  /** ISO time the report was made. */
  generatedAt?: string
}

const TITLE = 'Mini Rack Planner diagnostics'
const PROBLEMS = 'Problems'
/** Stacks are shown for the newest few problems only, so more problems fit. */
const STACKS_SHOWN = 3
const STACK_LINES_SHOWN = 8
const STACK_CHARS_SHOWN = 700
const OMITTED_PATTERN = /^\((\d+) older problems? not shown\)$/

function omittedLine(count: number): string {
  return `(${count} older problem${count === 1 ? '' : 's'} not shown)`
}

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB']

function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  const unitName = BYTE_UNITS[unit] ?? 'B'
  return unit === 0 ? `${Math.round(value)} ${unitName}` : `${value.toFixed(1)} ${unitName}`
}

function isSize(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

function formatStorage(storage: StorageInfo | undefined): string {
  if (storage === undefined) return 'not available'
  const parts: string[] = []
  if (storage.persisted !== undefined) parts.push(storage.persisted ? 'persisted' : 'not persisted')
  const { usage, quota } = storage
  if (isSize(usage) && isSize(quota) && quota > 0) {
    const percent = (usage / quota) * 100
    const shown = percent < 10 ? percent.toFixed(1) : Math.round(percent).toString()
    parts.push(`${formatBytes(usage)} used of ${formatBytes(quota)} (${shown}%)`)
  } else if (isSize(usage)) {
    parts.push(`${formatBytes(usage)} used`)
  } else if (isSize(quota)) {
    parts.push(`quota ${formatBytes(quota)}`)
  }
  return parts.length === 0 ? 'unknown' : parts.join(', ')
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

interface ProblemGroup {
  kind: DiagnosticKind
  message: string
  source?: string
  stack?: string
  count: number
  lastAt: string
}

/** Identical problems (kind, message, source) become one line with a count, newest first. */
function groupProblems(entries: readonly DiagnosticEntry[]): ProblemGroup[] {
  const groups = new Map<string, ProblemGroup>()
  for (const entry of entries) {
    const message = truncate(oneLine(redact(entry.message)), MESSAGE_MAX_LENGTH)
    const source =
      entry.source === undefined
        ? undefined
        : truncate(oneLine(redact(entry.source)), SOURCE_MAX_LENGTH)
    const stack =
      entry.stack === undefined ? undefined : truncate(redact(entry.stack), STACK_MAX_LENGTH)
    const repeats =
      typeof entry.repeats === 'number' && Number.isInteger(entry.repeats) && entry.repeats > 0
        ? entry.repeats
        : 0
    const key = `${entry.kind}\n${message}\n${source ?? ''}`
    const existing = groups.get(key)
    const group: ProblemGroup = {
      kind: entry.kind,
      message,
      count: (existing?.count ?? 0) + 1 + repeats,
      lastAt: oneLine(truncate(entry.at, 40)),
    }
    if (source !== undefined) group.source = source
    const latestStack = stack ?? existing?.stack
    if (latestStack !== undefined) group.stack = latestStack
    // Re-inserting moves the group to the end: the map stays ordered by last occurrence.
    groups.delete(key)
    groups.set(key, group)
  }
  return [...groups.values()].toReversed()
}

function formatProblem(group: ProblemGroup, withStack: boolean): string {
  const times = group.count > 1 ? ` (x${group.count})` : ''
  const lines = [`- ${group.lastAt} ${group.kind}${times}: ${group.message}`]
  if (group.source !== undefined) lines.push(`  source: ${group.source}`)
  if (withStack && group.stack !== undefined) {
    const stack = truncate(
      group.stack.split('\n').slice(0, STACK_LINES_SHOWN).join('\n'),
      STACK_CHARS_SHOWN,
    )
    for (const line of stack.split('\n')) lines.push(`    ${line}`)
  }
  return lines.join('\n')
}

/**
 * Plain-text report of at most `maxLength` characters. Problems are listed newest first; older
 * ones, then stacks, are left out when the report would grow too long.
 */
export function buildReport(input: ReportInput, maxLength = REPORT_MAX_LENGTH): string {
  const lines = [
    TITLE,
    `App version: ${oneLine(truncate(input.appVersion, 40))} (${oneLine(truncate(input.gitSha, 40))})`,
    `Plan schema: ${oneLine(truncate(String(input.planSchema), 20))}`,
    `Catalog revision: ${input.catalogRevision ? oneLine(truncate(input.catalogRevision, 40)) : 'unknown'}`,
    `Secure context: ${input.secureContext ? 'yes' : 'no'}`,
    `Storage: ${formatStorage(input.storage)}`,
    `Browser: ${oneLine(truncate(input.userAgent, 400)) || 'unknown'}`,
  ]
  if (input.generatedAt !== undefined)
    lines.push(`Generated: ${oneLine(truncate(input.generatedAt, 40))}`)
  lines.push('Privacy: no plan contents, names, notes or file names are included.', '')

  const groups = groupProblems(input.entries)
  if (groups.length === 0) {
    lines.push(`${PROBLEMS}: none recorded`)
    return truncate(lines.join('\n'), maxLength)
  }
  lines.push(`${PROBLEMS}, newest first:`)
  let length = lines.join('\n').length
  // Room for the "(N older problems not shown)" line, should it be needed.
  const reserve = omittedLine(groups.length).length + 1
  let shown = 0
  for (const [index, group] of groups.entries()) {
    let block = formatProblem(group, index < STACKS_SHOWN)
    if (length + 1 + block.length + reserve > maxLength) block = formatProblem(group, false)
    if (length + 1 + block.length + reserve > maxLength) break
    lines.push(block)
    length += 1 + block.length
    shown += 1
  }
  if (shown < groups.length) lines.push(omittedLine(groups.length - shown))
  return truncate(lines.join('\n'), maxLength)
}

interface ReportParts {
  head: string[]
  problems: string[][]
  omitted: number
}

/** Splits a report from `buildReport` into its header and problem blocks. */
function splitReport(report: string): ReportParts {
  const lines = report.split('\n')
  const headingIndex = lines.findIndex((line) => line.startsWith(PROBLEMS))
  if (headingIndex === -1) return { head: lines, problems: [], omitted: 0 }
  const problems: string[][] = []
  let omitted = 0
  for (const line of lines.slice(headingIndex + 1)) {
    const omittedMatch = OMITTED_PATTERN.exec(line)
    if (omittedMatch !== null) omitted += Number(omittedMatch[1])
    else if (line.startsWith('- ') || problems.length === 0) problems.push([line])
    else problems.at(-1)?.push(line)
  }
  return { head: lines.slice(0, headingIndex + 1), problems, omitted }
}

function joinReport(parts: ReportParts, keep: number): string {
  const omitted = parts.omitted + parts.problems.length - keep
  return [
    ...parts.head,
    ...parts.problems.slice(0, keep).flat(),
    ...(omitted > 0 ? [omittedLine(omitted)] : []),
  ].join('\n')
}

export interface IssueUrlOptions {
  /** Prefills the form's "App version" field, e.g. "0.1.0 (abc123def456)". */
  version?: string
  maxLength?: number
}

/**
 * A "new issue" link on the bug form with the report in its Diagnostics field. To stay under
 * `ISSUE_URL_MAX_LENGTH`, problems are dropped oldest first, then the text is cut.
 */
export function reportIssueUrl(report: string, options: IssueUrlOptions = {}): string {
  const limit = options.maxLength ?? ISSUE_URL_MAX_LENGTH
  const build = (body: string): string => {
    const url = new URL(ISSUE_NEW_URL)
    url.searchParams.set('template', ISSUE_TEMPLATE)
    if (options.version) url.searchParams.set(VERSION_FIELD, truncate(oneLine(options.version), 80))
    url.searchParams.set(DIAGNOSTICS_FIELD, body)
    return url.href
  }

  const full = build(report)
  if (full.length < limit) return full
  const parts = splitReport(report)
  for (let keep = parts.problems.length - 1; keep >= 0; keep--) {
    const href = build(joinReport(parts, keep))
    if (href.length < limit) return href
  }
  // Still too long without any problem: cut the text (encoded length grows with the cut point).
  const text = joinReport(parts, 0)
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (build(truncate(text, middle)).length < limit) low = middle
    else high = middle - 1
  }
  return build(truncate(text, low))
}
