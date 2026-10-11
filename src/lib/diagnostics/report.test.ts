import { describe, expect, it } from 'vitest'
import {
  buildReport,
  ISSUE_URL_MAX_LENGTH,
  REPORT_MAX_LENGTH,
  reportIssueUrl,
  type ReportInput,
} from './report'
import { createDiagnostics, type DiagnosticEntry } from './store'

const BASE: ReportInput = {
  appVersion: '0.1.0',
  gitSha: 'abc123def456',
  planSchema: 1,
  catalogRevision: '0f7e404379b55f',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0',
  secureContext: false,
  entries: [],
  generatedAt: '2026-10-11T12:00:00.000Z',
}

function entry(index: number, overrides: Partial<DiagnosticEntry> = {}): DiagnosticEntry {
  const minute = String(index % 60).padStart(2, '0')
  return {
    at: `2026-10-11T10:${minute}:00.000Z`,
    kind: 'error',
    message: `TypeError: problem ${index} ${'x'.repeat(300)}`,
    stack: Array.from(
      { length: 30 },
      (_, line) => `at f${line} (/assets/index-abc.js:1:${line})`,
    ).join('\n'),
    source: `/assets/index-abc.js:1:${index}`,
    ...overrides,
  }
}

function diagnosticsParam(href: string): string {
  const url = new URL(href)
  expect(url.origin + url.pathname).toBe('https://github.com/Npab19/mini-rack-planner/issues/new')
  expect(url.searchParams.get('template')).toBe('bug.yml')
  return url.searchParams.get('diagnostics') ?? ''
}

describe('buildReport', () => {
  it('lists versions, browser facts and storage', () => {
    const report = buildReport({
      ...BASE,
      storage: { persisted: false, usage: 1_234_567, quota: 2_000_000_000 },
    })
    expect(report.split('\n')).toEqual([
      'Mini Rack Planner diagnostics',
      'App version: 0.1.0 (abc123def456)',
      'Plan schema: 1',
      'Catalog revision: 0f7e404379b55f',
      'Secure context: no',
      'Storage: not persisted, 1.2 MB used of 2.0 GB (0.1%)',
      'Browser: Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0',
      'Generated: 2026-10-11T12:00:00.000Z',
      'Privacy: no plan contents, names, notes or file names are included.',
      '',
      'Problems: none recorded',
    ])
  })

  it('says when storage facts are unavailable (plain-HTTP LAN origins)', () => {
    const { catalogRevision: _omitted, ...withoutRevision } = BASE
    const report = buildReport({ ...withoutRevision, secureContext: true })
    expect(report).toContain('Storage: not available')
    expect(report).toContain('Secure context: yes')
    expect(report).toContain('Catalog revision: unknown')
  })

  it('stays within 6,000 characters, newest first, with stacks for the newest problems only', () => {
    const entries = Array.from({ length: 100 }, (_, index) => entry(index))
    const report = buildReport({ ...BASE, userAgent: 'U'.repeat(5000), entries })
    expect(report.length).toBeLessThanOrEqual(REPORT_MAX_LENGTH)
    expect(report).toContain(`Browser: ${'U'.repeat(399)}…`)
    const problems = report.split('\n').filter((line) => line.startsWith('- '))
    expect(problems[0]).toContain('problem 99 ')
    expect(problems[1]).toContain('problem 98 ')
    const omitted = /^\((\d+) older problems not shown\)$/m.exec(report)
    expect(Number(omitted?.[1])).toBe(100 - problems.length)
    // Stack lines (indented four spaces) appear for at most three problems, eight lines each.
    const stackLines = report.split('\n').filter((line) => line.startsWith('    at f'))
    expect(stackLines.length).toBeGreaterThan(0)
    expect(stackLines.length).toBeLessThanOrEqual(3 * 8)
  })

  it('counts identical problems once, including folded repeats', () => {
    const same = { message: 'Error: same', source: 'boundary:bom', stack: undefined }
    const report = buildReport({
      ...BASE,
      entries: [
        entry(1, same),
        entry(2, { message: 'Error: other', source: undefined, stack: undefined }),
        entry(3, { ...same, repeats: 4 }),
      ],
    })
    const problems = report.split('\n').filter((line) => line.startsWith('- '))
    expect(problems).toEqual([
      '- 2026-10-11T10:03:00.000Z error (x6): Error: same',
      '- 2026-10-11T10:02:00.000Z error: Error: other',
    ])
    expect(report).toContain('  source: boundary:bom')
  })

  it('never includes plan contents, names, notes or file names', () => {
    const diagnostics = createDiagnostics({ origin: () => 'http://192.168.1.20:8080' })
    diagnostics.recordError(new Error('Plan "Garage homelab" failed to save'))
    diagnostics.recordError(
      new SyntaxError(`Unexpected token 'N', "Notes: buy M6 screws" is not valid JSON`),
    )
    diagnostics.record({
      kind: 'warning',
      message: "Could not read my-kws-rack.3mf for 'Nick's rack'",
    })
    diagnostics.record({
      kind: 'error',
      message: 'Share link failed',
      source: 'http://192.168.1.20:8080/view#p=1.eJyrVkrLz8lJLVKyUlAqzy_KSVGqBQBV0wdq',
    })
    // Rows from a sink written by an older version are redacted again.
    const stored = entry(1, { message: 'Old row: import of "Bedroom rack" from rack-backup.json' })
    const report = buildReport({ ...BASE, entries: [stored, ...diagnostics.entries()] })
    for (const secret of [
      'Garage',
      'homelab',
      'Notes',
      'screws',
      'my-kws-rack',
      'Nick',
      'eJyr',
      'Bedroom',
      'rack-backup',
      '192.168',
    ]) {
      expect(report).not.toContain(secret)
    }
    expect(report).toContain('Error: Plan "…" failed to save')
    expect(report).toContain('source: /view')
  })
})

describe('reportIssueUrl', () => {
  it('prefills the bug form: diagnostics and version fields', () => {
    const report = buildReport({ ...BASE, entries: [entry(1)] })
    const href = reportIssueUrl(report, { version: '0.1.0 (abc123def456)' })
    expect(diagnosticsParam(href)).toBe(report)
    expect(new URL(href).searchParams.get('version')).toBe('0.1.0 (abc123def456)')
    expect(href.length).toBeLessThan(ISSUE_URL_MAX_LENGTH)
  })

  it('stays under 8,000 characters by dropping the oldest problems first', () => {
    const entries = Array.from({ length: 100 }, (_, index) =>
      // Non-ASCII text triples in length when encoded.
      entry(index, { message: `Error: problem ${index} ${'é'.repeat(400)}` }),
    )
    const report = buildReport({ ...BASE, entries })
    expect(report.length).toBeLessThanOrEqual(REPORT_MAX_LENGTH)
    const href = reportIssueUrl(report)
    expect(href.length).toBeLessThan(ISSUE_URL_MAX_LENGTH)

    const body = diagnosticsParam(href)
    expect(body.startsWith('Mini Rack Planner diagnostics\nApp version: 0.1.0')).toBe(true)
    const problems = body.split('\n').filter((line) => line.startsWith('- '))
    const fullProblems = report.split('\n').filter((line) => line.startsWith('- '))
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.length).toBeLessThan(fullProblems.length)
    expect(problems).toEqual(fullProblems.slice(0, problems.length))
    const omitted = /^\((\d+) older problems? not shown\)$/m.exec(body)
    expect(Number(omitted?.[1])).toBe(100 - problems.length)
  })

  it('cuts the text itself when even the header is too long', () => {
    const href = reportIssueUrl('ü'.repeat(20_000), { version: 'v'.repeat(500) })
    expect(href.length).toBeLessThan(ISSUE_URL_MAX_LENGTH)
    const body = diagnosticsParam(href)
    expect(body.length).toBeGreaterThan(100)
    expect(body.endsWith('…')).toBe(true)
  })
})
