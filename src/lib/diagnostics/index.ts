/**
 * Diagnostics: a ring buffer of recent problems (errors, unhandled rejections, CSP violations,
 * worker failures, warnings) and the redacted report behind "Copy diagnostics" and "Report a
 * problem". Use it as a namespace:
 *
 *   import * as diagnostics from '@/lib/diagnostics'
 *   diagnostics.install({ window })                       // main.tsx, before the first render
 *   diagnostics.record({ kind: 'worker', message: 'Ingest worker failed to start', source: 'ingest' })
 *   diagnostics.recordError(error, { source: 'boundary:bom' })
 *   await diagnostics.setSink(dexieSink)                  // persist across reloads
 *   const report = await diagnostics.collectReport()      // plain text, at most 6,000 characters
 *   const href = diagnostics.reportIssueUrl(report, { version: `${__APP_VERSION__} (${__GIT_SHA__})` })
 *
 * Messages are redacted (quoted text, URL queries and fragments, file names) and truncated, but
 * free text cannot be redacted: never put plan contents, names, notes or file names in them.
 * Copy buttons use `copyText` from `@/lib/clipboard` (DOM only, with a fallback for plain HTTP).
 */
import { defaultDiagnostics } from './store'

export {
  createDiagnostics,
  createMemorySink,
  DIAGNOSTICS_CAP,
  MESSAGE_MAX_LENGTH,
  SOURCE_MAX_LENGTH,
  STACK_MAX_LENGTH,
  type DiagnosticEntry,
  type DiagnosticInput,
  type DiagnosticKind,
  type Diagnostics,
  type DiagnosticsEventTarget,
  type DiagnosticsOptions,
  type DiagnosticsSink,
  type RecordErrorOptions,
} from './store'
export { describeError, redact, truncate } from './sanitize'
export {
  buildReport,
  ISSUE_NEW_URL,
  ISSUE_TEMPLATE,
  ISSUE_URL_MAX_LENGTH,
  REPORT_MAX_LENGTH,
  reportIssueUrl,
  type IssueUrlOptions,
  type ReportInput,
  type StorageInfo,
} from './report'
export {
  collectReport,
  collectReportInput,
  setReportContext,
  type CollectOptions,
  type ReportContext,
} from './collect'

// The app-wide instance.
export const install = defaultDiagnostics.install
export const record = defaultDiagnostics.record
export const recordError = defaultDiagnostics.recordError
export const getEntries = defaultDiagnostics.entries
export const subscribe = defaultDiagnostics.subscribe
export const setSink = defaultDiagnostics.setSink
export const clear = defaultDiagnostics.clear
