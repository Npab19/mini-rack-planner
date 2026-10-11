/**
 * Redaction and size limits for diagnostics text.
 *
 * Reports are pasted into public GitHub issues, so anything that can carry the user's data is
 * removed: quoted text (plan, part and file names, notes, the JSON snippets in parse errors),
 * URL queries and fragments (a share link carries the whole plan in `#p=`), file names, user
 * names in absolute paths and long encoded blobs. Unquoted free text cannot be told apart from
 * code, so callers must never build messages from user content.
 */

const ELLIPSIS = '…'

/** Cuts `text` to at most `max` characters, marking the cut with an ellipsis. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 0) return ''
  let end = max - 1
  // Never split a surrogate pair: a lone surrogate breaks URL encoding of the report.
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end) + ELLIPSIS
}

// No regex lookbehind in this file: it is in the initial bundle, and older Safari cannot parse it.

// A URL ends at whitespace, a quote or a bracket, as in stack frames: "at f (http://h/a.js:1:2)".
const URL_PATTERN = /\b(?:https?|wss?|blob|file|data):[^\s"'`<>()[\]{}]+/gi
// User names in absolute paths: dev-server /@fs/ URLs, Node stack traces.
const HOME_PATTERN = /(^|[\s(@'"/=]|file:\/\/)((?:[a-z]:)?[\\/](?:Users|home)[\\/])[^\\/\s:)'"]+/gi
// A share link payload: `p=<codec>.<base64url>`.
const SHARE_PATTERN = /\bp=\d+\.[\w-]+/g
// Long base64url/hex runs with letters and digits: encoded data, never a hashed asset name. The
// scan reaches a run at its first character, so the match always covers the whole run.
const BLOB_PATTERN = /(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{40,}(?![\w-])/gi
// Data files (imports, exports, model files). Code files (.js, .tsx, .css) stay for stack frames.
const FILE_PATTERN =
  /[^\s/\\:"'`()<>[\]{}]+\.(3mf|stl|step|stp|obj|zip|gcode|bgcode|json|csv|md|txt|pdf|png|jpe?g|webp|gif|svg)\b/gi

/**
 * ASCII quotes, matched at a given position (sticky). A quote opens only when the character
 * before it is not part of a word (checked by the scanner) and closes only when the character
 * after it is not, so apostrophes (can't, it's) never open one and JSON snippets cut mid-string
 * still pair up. In single quotes an apostrophe followed by a letter (Nick's) does not close.
 */
const ASCII_QUOTED: ReadonlyArray<readonly [string, RegExp]> = [
  ['"', /"(?:[^"\\\n]|\\.)*"(?!\w)/y],
  ["'", /'(?:[^'\\\n]|\\.|'(?=\w))*'(?!\w)/y],
]
const WORD_OR_ESCAPE = /[\w\\]/
// Typographic quotes and backticks are unambiguous.
const OTHER_QUOTED: ReadonlyArray<readonly [RegExp, string]> = [
  [/`[^`\n]*`/g, `\`${ELLIPSIS}\``],
  [/“[^”\n]*”/g, `“${ELLIPSIS}”`],
  [/‘[^’\n]*’/g, `‘${ELLIPSIS}’`],
  [/«[^»\n]*»/g, `«${ELLIPSIS}»`],
]

/** Length of the ASCII-quoted span starting at `index`, or 0. */
function quotedLengthAt(text: string, index: number): number {
  if (WORD_OR_ESCAPE.test(text.charAt(index - 1))) return 0
  for (const [quote, pattern] of ASCII_QUOTED) {
    if (text.charAt(index) !== quote) continue
    pattern.lastIndex = index
    return pattern.exec(text)?.[0].length ?? 0
  }
  return 0
}

/** Replaces quoted spans with an empty quote pair (`"…"`). */
function redactQuoted(text: string): string {
  let result = ''
  let index = 0
  while (index < text.length) {
    const char = text.charAt(index)
    const length = quotedLengthAt(text, index)
    result += length > 0 ? `${char}${ELLIPSIS}${char}` : char
    index += Math.max(length, 1)
  }
  for (const [pattern, replacement] of OTHER_QUOTED) result = result.replace(pattern, replacement)
  return result
}

function redactUrl(raw: string, origin: string | undefined): string {
  const scheme = raw.slice(0, raw.indexOf(':')).toLowerCase()
  if (scheme === 'blob' || scheme === 'data' || scheme === 'file') return `${scheme}:${ELLIPSIS}`
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return '<url>'
  }
  // Stack frames put :line:col after any query (the dev server adds ?t=…), so keep that part.
  const position = /(?::\d+){1,2}$/.exec(url.search + url.hash)?.[0] ?? ''
  const base = origin !== undefined && url.origin === origin ? '' : url.origin
  return base + url.pathname + position
}

/**
 * Removes user data from diagnostics text (see the module comment). Idempotent.
 * @param origin the app's own origin; URLs on it become paths (shorter, and no LAN address).
 */
export function redact(text: string, origin?: string): string {
  let result = text.replace(URL_PATTERN, (raw) => redactUrl(raw, origin))
  result = result.replace(HOME_PATTERN, (_match, before: string, home: string) => {
    return `${before}${home}${ELLIPSIS}`
  })
  result = result.replace(SHARE_PATTERN, 'p=<share link>')
  result = result.replace(BLOB_PATTERN, '<data>')
  result = redactQuoted(result)
  return result.replace(FILE_PATTERN, (_match, extension: string) => `<file>.${extension}`)
}

// ---------------------------------------------------------------------------------------------
// Turning anything thrown into text

interface ErrorLike {
  name?: unknown
  message: string
  stack?: unknown
  cause?: unknown
  issues?: unknown
}

function isErrorLike(value: unknown): value is ErrorLike {
  if (value instanceof Error) return true
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string'
  )
}

function errorName(error: ErrorLike): string {
  return typeof error.name === 'string' && error.name !== '' ? error.name : 'Error'
}

function headline(error: ErrorLike): string {
  const name = errorName(error)
  return error.message === '' ? name : `${name}: ${error.message}`
}

const IDENTIFIER = /^(?:\d+|[A-Za-z_$][\w$]*)$/

/** Schema keys and indices only: a record key can be user data (`custom:my-shelf`). */
function issuePath(path: unknown): string {
  const segments: unknown[] = Array.isArray(path)
    ? path
    : typeof path === 'string'
      ? path.split('.')
      : []
  return segments
    .map((segment) =>
      typeof segment === 'number' || (typeof segment === 'string' && IDENTIFIER.test(segment))
        ? String(segment)
        : ELLIPSIS,
    )
    .join('.')
}

const ISSUES_SHOWN = 3

/** zod issues (ZodError) or plan issues (PlanInvalidError) as "2 issues: invalid_type at a.b". */
function summarizeIssues(issues: readonly unknown[]): string {
  const shown = issues.slice(0, ISSUES_SHOWN).map((issue) => {
    if (typeof issue !== 'object' || issue === null) return 'issue'
    const { code, message, path } = issue as { code?: unknown; message?: unknown; path?: unknown }
    const what =
      typeof code === 'string'
        ? code
        : typeof message === 'string'
          ? truncate(message, 80)
          : 'issue'
    const where = issuePath(path)
    return where === '' ? what : `${what} at ${where}`
  })
  const more = issues.length > ISSUES_SHOWN ? `; ${issues.length - ISSUES_SHOWN} more` : ''
  const count = `${issues.length} issue${issues.length === 1 ? '' : 's'}`
  return `${count}: ${shown.join('; ')}${more}`
}

function describeErrorLike(error: ErrorLike): { message: string; stack?: string } {
  let message = headline(error)
  if (Array.isArray(error.issues) && error.issues.length > 0) {
    const summary = summarizeIssues(error.issues)
    // ZodError's message is the issue list as JSON: the summary replaces it.
    message = /^\s*[[{]/.test(error.message)
      ? `${errorName(error)}: ${summary}`
      : `${message} (${summary})`
  }
  if (isErrorLike(error.cause)) message += ` [cause: ${headline(error.cause)}]`

  if (typeof error.stack !== 'string') return { message }
  let stack = error.stack
  // V8 starts the stack with the headline again; other engines list frames only.
  const head = headline(error)
  if (stack.startsWith(head)) stack = stack.slice(head.length)
  stack = stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
  return stack === '' ? { message } : { message, stack }
}

function constructorName(value: object): string {
  const name: unknown = Object.getPrototypeOf(value)?.constructor?.name
  return typeof name === 'string' && name !== '' ? name : 'Object'
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return `Non-error value: ${String(value)}`
  if (typeof value === 'object') {
    // Promise rejections often carry a DOM Event (IndexedDB requests, failed loads).
    const { type, target } = value as { type?: unknown; target?: unknown }
    if (typeof type === 'string') {
      const targetError =
        typeof target === 'object' && target !== null
          ? (target as { error?: unknown }).error
          : undefined
      const detail = isErrorLike(targetError) ? `: ${headline(targetError)}` : ''
      return `${constructorName(value)} (type: ${type})${detail}`
    }
    // Never serialize objects: they may hold a plan.
    return `Non-error object (${constructorName(value)})`
  }
  if (typeof value === 'symbol') return 'Non-error value: symbol'
  return `Non-error ${typeof value}: ${String(value)}`
}

/**
 * Message and stack of anything thrown or rejected. Objects are never serialized; errors with
 * `issues` (zod, plan validation) are summarized by issue code and schema path.
 * The result is not redacted yet: `record` does that.
 */
export function describeError(error: unknown): { message: string; stack?: string } {
  try {
    if (isErrorLike(error)) return describeErrorLike(error)
    if (typeof error === 'string') return { message: error }
    return { message: describeValue(error) }
  } catch {
    // A hostile getter or proxy: nothing readable.
    return { message: 'Unreadable error value' }
  }
}
