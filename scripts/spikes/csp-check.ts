/**
 * Spike S4 verification: a module worker with lazily loaded WASM (hash-wasm, meshoptimizer) under the
 * production CSP, served the way production serves it (every response carries scripts/headers.ts).
 *
 *   npx tsx scripts/spikes/csp-check.ts [--skip-build] [--keep] [--headed] [--json <file>]
 *
 * 1. Builds with VITE_SPIKES=1 into dist-spikes/ (a separate outDir, so dist/ is never touched).
 * 2. Lists dist-spikes/assets: the worker and each WASM-carrying library must be separate lazy chunks.
 * 3. Serves the build with Vite preview on 127.0.0.1:4181. This is `vite preview --outDir dist-spikes --port 4181
 *    --strictPort` through the JS API, plus `allowedHosts: ['lan.test']` so the LAN alias passes the host check.
 * 4. Fetches the page, the worker and the library chunks, and checks that each response carries the CSP.
 * 5. Drives Chromium on a secure origin (http://localhost:4181) and on an insecure one
 *    (http://lan.test:4181, mapped to 127.0.0.1 with --host-resolver-rules).
 * 6. Experiments on :4182 serve the same build under modified policies, to learn which directives matter.
 * 7. Stops the servers and deletes dist-spikes/ (unless --keep).
 *
 * Nothing here contacts any host other than 127.0.0.1.
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { chromium, type Browser, type Page } from '@playwright/test'
import { preview, type Plugin, type PreviewServer } from 'vite'
import { z } from 'zod'
import { CSP } from '../headers'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT_DIR = 'dist-spikes'
const OUT_PATH = path.join(ROOT, OUT_DIR)
const ASSETS_PATH = path.join(OUT_PATH, 'assets')
const MAIN_PORT = 4181
const EXPERIMENT_PORT = 4182
const LAN_HOST = 'lan.test'
const SPIKE_PATH = '/dev/spike-worker'
const STEP_TIMEOUT_MS = 60_000
/** Lets late console messages from the worker arrive over CDP before they are read. */
const SETTLE_MS = 300
/** FIPS 180-2 known answer for one million 'a' characters (the page's File probe). */
const MILLION_A_SHA256 = 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'
const PICKED_FILE_BYTES = 3 * 1024 * 1024 + 123
const GRID_INPUT_TRIANGLES = 20_000
const MAX_SIMPLIFIED_SHARE = 0.15

/** Strings that only the corresponding library's chunk contains (WASM export names survive minification). */
const HASH_WASM_MARKER = 'Hash_SetMemorySize'
const MESHOPT_MARKER = 'meshopt_simplify'

/**
 * Chrome notices about response headers, not app errors: it ignores COOP on every untrustworthy (plain-HTTP)
 * origin and logs that as an error. scripts/headers.ts sends COOP everywhere today (see the spike write-up),
 * so the insecure run reports this notice instead of failing on it. The secure run tolerates nothing.
 */
const INSECURE_ORIGIN_HEADER_NOTICES = [
  /The Cross-Origin-Opener-Policy header has been ignored, because the URL's origin was untrustworthy/,
]

const args = process.argv.slice(2)
const options = {
  skipBuild: args.includes('--skip-build'),
  keep: args.includes('--keep'),
  headed: args.includes('--headed'),
  jsonPath: args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined,
}

// ---------------------------------------------------------------------------------------------------------------
// Check bookkeeping

interface Check {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []
const notes: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

function note(message: string): void {
  notes.push(message)
  console.log(`  NOTE  ${message}`)
}

function section(title: string): void {
  console.log(`\n== ${title}`)
}

// ---------------------------------------------------------------------------------------------------------------
// Build and asset inspection

function buildSpikes(): void {
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--outDir', OUT_DIR, '--emptyOutDir'],
    {
      cwd: ROOT,
      env: { ...process.env, VITE_SPIKES: '1' },
      stdio: 'inherit',
    },
  )
  if (result.status !== 0)
    throw new Error(`vite build failed with exit code ${String(result.status)}`)
}

interface AssetInfo {
  file: string
  bytes: number
  gzipBytes: number
  role: string
}

interface AssetReport {
  assets: AssetInfo[]
  workerChunk: string
  hashWasmChunk: string
  meshoptChunk: string
  pageChunk: string
  entryChunks: string[]
}

function readAsset(file: string): string {
  return readFileSync(path.join(ASSETS_PATH, file), 'utf8')
}

function onlyMatch(files: string[], label: string): string {
  if (files.length !== 1)
    throw new Error(`expected exactly one ${label} chunk, found [${files.join(', ')}]`)
  const [file] = files
  if (file === undefined) throw new Error(`no ${label} chunk`)
  return file
}

/** Chunks the browser fetches before any route code runs: the module entry and its modulepreloads. */
function entryChunks(): string[] {
  const html = readFileSync(path.join(OUT_PATH, 'index.html'), 'utf8')
  return [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].flatMap(
    (match) => match[1] ?? [],
  )
}

function importsDynamically(source: string, chunk: string): boolean {
  const escaped = chunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`import\\(\\s*[\`'"]\\./${escaped}[\`'"]\\s*\\)`).test(source)
}

function importsStatically(source: string, chunk: string): boolean {
  return source.includes(`from"./${chunk}"`) || source.includes(`import"./${chunk}"`)
}

function inspectAssets(): AssetReport {
  const jsFiles = readdirSync(ASSETS_PATH).filter((file) => file.endsWith('.js'))
  const workerChunk = onlyMatch(
    jsFiles.filter((file) => file.startsWith('spike-hash.worker-')),
    'worker',
  )
  const hashWasmChunk = onlyMatch(
    jsFiles.filter((file) => readAsset(file).includes(HASH_WASM_MARKER)),
    'hash-wasm',
  )
  const meshoptChunk = onlyMatch(
    jsFiles.filter((file) => readAsset(file).includes(MESHOPT_MARKER)),
    'meshoptimizer',
  )
  const pageChunk = onlyMatch(
    jsFiles.filter((file) => file.startsWith('SpikeWorkerPage-')),
    'spike page',
  )
  const entries = entryChunks()
  const roles = new Map<string, string>([
    [workerChunk, 'worker entry (module worker)'],
    [hashWasmChunk, 'hash-wasm, lazy import() from the worker'],
    [meshoptChunk, 'meshoptimizer/simplifier, lazy import() from the worker'],
    [pageChunk, 'spike page (route chunk)'],
    ...entries.map((file): [string, string] => [file, 'initial (entry/modulepreload)']),
  ])
  const assets = [...roles.keys()].map((file) => {
    const bytes = readFileSync(path.join(ASSETS_PATH, file))
    return {
      file,
      bytes: bytes.length,
      gzipBytes: gzipSync(bytes).length,
      role: roles.get(file) ?? '',
    }
  })
  return { assets, workerChunk, hashWasmChunk, meshoptChunk, pageChunk, entryChunks: entries }
}

function checkChunking(report: AssetReport): void {
  const worker = readAsset(report.workerChunk)
  const wasmChunks = [report.hashWasmChunk, report.meshoptChunk]
  for (const chunk of wasmChunks) {
    check(
      `worker loads ${chunk} lazily (dynamic import only)`,
      importsDynamically(worker, chunk) && !importsStatically(worker, chunk),
    )
  }
  check(
    'worker, hash-wasm and meshoptimizer are three different chunks',
    new Set([report.workerChunk, ...wasmChunks]).size === 3,
  )
  check(
    'no WASM library code in the initial chunks',
    report.entryChunks.every(
      (file) => !/WebAssembly|Hash_SetMemorySize|meshopt_/.test(readAsset(file)),
    ),
    report.entryChunks.join(', '),
  )
  const page = readAsset(report.pageChunk)
  check(
    'the page chunk references the worker by same-origin URL and carries no WASM',
    page.includes(`/assets/${report.workerChunk}`) && !page.includes('WebAssembly'),
  )
  const wasmFiles = readdirSync(OUT_PATH, { recursive: true, encoding: 'utf8' }).filter((file) =>
    file.endsWith('.wasm'),
  )
  check('no .wasm files are emitted (both libraries inline their binaries)', wasmFiles.length === 0)
}

function printAssets(report: AssetReport): void {
  const kb = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB` // 1 kB = 1000 B, as Vite reports sizes
  for (const asset of report.assets) {
    console.log(
      `  ${asset.file.padEnd(40)} ${kb(asset.bytes).padStart(9)}  gzip ${kb(asset.gzipBytes).padStart(8)}  ${asset.role}`,
    )
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Servers and headers

async function startPreview(
  port: number,
  headerOverrides: Record<string, string> = {},
  plugins: Plugin[] = [],
): Promise<PreviewServer> {
  return preview({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    build: { outDir: OUT_DIR },
    plugins,
    preview: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      open: false,
      allowedHosts: [LAN_HOST],
      headers: headerOverrides,
    },
  })
}

/** Serves the worker entry chunk under its own CSP, to learn which response's policy governs the worker. */
function workerCspPlugin(workerChunk: string, workerCsp: string): Plugin {
  return {
    name: 'spike-s4-worker-csp',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0]?.endsWith(`/assets/${workerChunk}`)) {
          const setHeader = res.setHeader.bind(res)
          res.setHeader = (name, value) =>
            setHeader(name, name.toLowerCase() === 'content-security-policy' ? workerCsp : value)
        }
        next()
      })
    },
  }
}

async function checkHeaders(base: string, report: AssetReport): Promise<void> {
  const targets = [
    { label: 'page (SPA fallback)', path: SPIKE_PATH, accept: 'text/html', javascript: false },
    {
      label: 'worker chunk',
      path: `/assets/${report.workerChunk}`,
      accept: '*/*',
      javascript: true,
    },
    {
      label: 'hash-wasm chunk',
      path: `/assets/${report.hashWasmChunk}`,
      accept: '*/*',
      javascript: true,
    },
    {
      label: 'meshoptimizer chunk',
      path: `/assets/${report.meshoptChunk}`,
      accept: '*/*',
      javascript: true,
    },
  ]
  for (const target of targets) {
    const response = await fetch(`${base}${target.path}`, { headers: { accept: target.accept } })
    await response.arrayBuffer()
    const csp = response.headers.get('content-security-policy')
    const contentType = response.headers.get('content-type') ?? ''
    check(
      `${target.label}: 200 with the production CSP`,
      response.status === 200 && csp === CSP,
      target.path,
    )
    check(
      `${target.label}: nosniff${target.javascript ? ' and a JavaScript MIME type' : ''}`,
      response.headers.get('x-content-type-options') === 'nosniff' &&
        (!target.javascript || contentType.startsWith('text/javascript')),
      contentType,
    )
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Browser runs

/** Records document-level violations from the first byte, before React mounts the page's own listener. */
const RECORD_EARLY_VIOLATIONS = `
  window.__s4EarlyViolations = [];
  document.addEventListener('securitypolicyviolation', (event) => {
    window.__s4EarlyViolations.push(
      event.effectiveDirective + ' blocked ' + (event.blockedURI || '(inline)') + ' at ' + event.sourceFile + ':' + event.lineNumber,
    );
  });
`
const READ_TEST_IDS = `Object.fromEntries(Array.from(document.querySelectorAll('[data-testid]'), (element) => [
  element.getAttribute('data-testid'),
  (element.textContent || '').trim(),
]))`

interface PageRun {
  url: string
  finalUrl: string
  documentCsp: string | null
  values: Record<string, string>
  violations: string[]
  earlyViolations: string[]
  consoleErrors: string[]
  picked: { size: number; sha256: string } | null
}

function createPickedFile(): { buffer: Buffer; sha256: string } {
  const buffer = randomBytes(PICKED_FILE_BYTES)
  return { buffer, sha256: createHash('sha256').update(buffer).digest('hex') }
}

async function readTestIds(page: Page): Promise<Record<string, string>> {
  return z.record(z.string(), z.string()).parse(await page.evaluate(READ_TEST_IDS))
}

async function readEarlyViolations(page: Page): Promise<string[]> {
  return z.array(z.string()).parse(await page.evaluate('window.__s4EarlyViolations || []'))
}

async function runSpikePage(browser: Browser, url: string, pickFile: boolean): Promise<PageRun> {
  const context = await browser.newContext()
  const consoleErrors: string[] = []
  try {
    const page = await context.newPage()
    page.on('console', (message) => {
      if (message.type() === 'error')
        consoleErrors.push(`${message.worker() ? 'worker' : 'page'}: ${message.text()}`)
    })
    page.on('pageerror', (error) => consoleErrors.push(`uncaught: ${error.message}`))
    await page.addInitScript(RECORD_EARLY_VIOLATIONS)
    const response = await page.goto(url, { waitUntil: 'load' })
    await page.getByTestId('run-spike').click()
    await page
      .getByTestId('spike-status')
      .filter({ hasText: /^done$/ })
      .waitFor({ timeout: STEP_TIMEOUT_MS })

    let picked: PageRun['picked'] = null
    if (pickFile) {
      const file = createPickedFile()
      await page.getByTestId('file-input').setInputFiles({
        name: 'probe.bin',
        mimeType: 'application/octet-stream',
        buffer: file.buffer,
      })
      await page
        .getByTestId('step-picked-status')
        .filter({ hasText: /^(ok|failed)$/ })
        .waitFor({ timeout: STEP_TIMEOUT_MS })
      picked = { size: file.buffer.length, sha256: file.sha256 }
    }
    await page.waitForTimeout(SETTLE_MS)
    return {
      url,
      finalUrl: page.url(),
      documentCsp: response?.headers()['content-security-policy'] ?? null,
      values: await readTestIds(page),
      violations: await page.getByTestId('csp-violation').allTextContents(),
      earlyViolations: await readEarlyViolations(page),
      consoleErrors: [...consoleErrors],
      picked,
    }
  } finally {
    await context.close()
  }
}

const isSha256Hex = (value: string | undefined) =>
  value !== undefined && /^[0-9a-f]{64}$/.test(value)

function checkWorkingRun(label: string, run: PageRun, secure: boolean): void {
  const v = run.values
  check(`${label} document response carries the production CSP`, run.documentCsp === CSP)
  check(`${label} page isSecureContext=${String(secure)}`, v['secure-context'] === String(secure))
  check(
    `${label} page crypto.subtle ${secure ? 'present' : 'absent'}`,
    v['subtle-available'] === String(secure),
  )
  check(
    `${label} worker booted from its own chunk`,
    v['step-boot-status'] === 'ok',
    v['step-boot-error'],
  )
  check(
    `${label} worker isSecureContext=${String(secure)}`,
    v['worker-secure-context'] === String(secure),
  )
  check(
    `${label} worker crypto.subtle ${secure ? 'present' : 'absent'}`,
    v['worker-subtle-available'] === String(secure),
  )
  check(
    `${label} hash-wasm hashed 5 MiB in the worker`,
    v['step-hash-status'] === 'ok' && isSha256Hex(v['sha256-hash-wasm']),
    v['step-hash-error'] ?? v['sha256-hash-wasm'],
  )
  if (secure) {
    check(
      `${label} hash-wasm digest equals crypto.subtle digest`,
      v['sha256-match'] === 'match' && v['sha256-hash-wasm'] === v['sha256-subtle'],
    )
  } else {
    check(`${label} crypto.subtle reported unavailable`, v['sha256-subtle'] === 'unavailable')
  }
  const input = Number(v['simplify-input-triangles'])
  const output = Number(v['simplify-output-triangles'])
  check(
    `${label} meshoptimizer simplified ${GRID_INPUT_TRIANGLES} triangles to <= ${MAX_SIMPLIFIED_SHARE * 100}%`,
    v['step-simplify-status'] === 'ok' &&
      input === GRID_INPUT_TRIANGLES &&
      output > 0 &&
      output <= input * MAX_SIMPLIFIED_SHARE &&
      v['simplify-consistent'] === 'true',
    v['step-simplify-error'] ?? `${input} -> ${output}`,
  )
  check(
    `${label} File posted to the worker hashes to the FIPS 180-2 vector`,
    v['step-file-status'] === 'ok' &&
      v['file-sha256'] === MILLION_A_SHA256 &&
      v['file-is-file'] === 'true' &&
      v['file-size'] === '1000000',
    v['step-file-error'] ?? `${v['file-slices'] ?? '?'} slices`,
  )
  if (run.picked) {
    check(
      `${label} picked file (setInputFiles) hashes like node:crypto`,
      v['step-picked-status'] === 'ok' &&
        v['picked-file-sha256'] === run.picked.sha256 &&
        v['picked-file-size'] === String(run.picked.size),
      v['step-picked-error'] ??
        `${run.picked.size} bytes, ${v['picked-file-slices'] ?? '?'} slices`,
    )
  }
  check(
    `${label} zero CSP violations (page, worker relay, pre-mount)`,
    run.violations.length === 0 &&
      run.earlyViolations.length === 0 &&
      v['csp-violation-count'] === '0',
    [...run.violations, ...run.earlyViolations].join(' | '),
  )
  const isHeaderNotice = (message: string) =>
    !secure && INSECURE_ORIGIN_HEADER_NOTICES.some((pattern) => pattern.test(message))
  const appErrors = run.consoleErrors.filter((message) => !isHeaderNotice(message))
  const headerNotices = run.consoleErrors.filter(isHeaderNotice)
  check(
    `${label} zero console errors${secure ? '' : ' from the app'}`,
    appErrors.length === 0,
    appErrors.join(' | '),
  )
  for (const notice of headerNotices)
    note(`${label} Chrome header notice (scripts/headers.ts, not the app): ${notice}`)
}

// ---------------------------------------------------------------------------------------------------------------
// Experiments: the same build under modified policies

type Expectation = 'all-ok' | 'wasm-blocked' | 'worker-blocked'

interface Experiment {
  id: string
  question: string
  documentCsp: string
  /** CSP for the worker entry chunk's response only (defaults to documentCsp, like every real server here). */
  workerCsp?: string
  expect: Expectation
}

interface ExperimentResult {
  id: string
  question: string
  expect: Expectation
  met: boolean
  steps: Record<string, string>
  errors: Record<string, string>
  violations: string[]
  consoleErrors: string[]
}

function directiveName(directive: string): string {
  return directive.trim().split(/\s+/)[0] ?? ''
}

/** Replaces (or, with null, removes) one directive of a policy, keeping the others in order. */
function withDirective(csp: string, name: string, value: string | null): string {
  return csp
    .split(';')
    .map((directive) => directive.trim())
    .flatMap((directive) => {
      if (directiveName(directive) !== name) return [directive]
      return value === null ? [] : [`${name} ${value}`]
    })
    .join('; ')
}

const CSP_WITHOUT_WASM = withDirective(CSP, 'script-src', "'self'")

const EXPERIMENTS: Experiment[] = [
  {
    id: 'no-wasm-unsafe-eval',
    question: "Is 'wasm-unsafe-eval' needed, and by which library?",
    documentCsp: CSP_WITHOUT_WASM,
    expect: 'wasm-blocked',
  },
  {
    id: 'worker-src-none',
    question: 'Control: does a worker-src block surface as a page violation?',
    documentCsp: withDirective(CSP, 'worker-src', "'none'"),
    expect: 'worker-blocked',
  },
  {
    id: 'no-worker-src',
    question: "Without worker-src, does the fallback to script-src 'self' still admit the worker?",
    documentCsp: withDirective(CSP, 'worker-src', null),
    expect: 'all-ok',
  },
  {
    id: 'connect-src-self',
    question: 'Is blob: in connect-src needed to hand a File to the worker?',
    documentCsp: withDirective(CSP, 'connect-src', "'self'"),
    expect: 'all-ok',
  },
  {
    id: 'worker-response-without-wasm',
    question:
      "Does the worker obey its own script response's CSP (document allows WASM, worker chunk does not)?",
    documentCsp: CSP,
    workerCsp: CSP_WITHOUT_WASM,
    expect: 'wasm-blocked',
  },
  {
    id: 'document-without-wasm',
    question:
      "Does the document's CSP leak into the worker (document forbids WASM, worker chunk allows it)?",
    documentCsp: CSP_WITHOUT_WASM,
    workerCsp: CSP,
    expect: 'all-ok',
  },
]

const STEP_IDS = ['step-boot', 'step-hash', 'step-simplify', 'step-file'] as const

function meetsExpectation(expect: Expectation, run: PageRun): boolean {
  const status = (step: (typeof STEP_IDS)[number]) => run.values[`${step}-status`]
  const allViolations = [...run.violations, ...run.earlyViolations]
  switch (expect) {
    case 'all-ok':
      return STEP_IDS.every((step) => status(step) === 'ok') && allViolations.length === 0
    case 'wasm-blocked':
      return (
        status('step-boot') === 'ok' &&
        ['step-hash', 'step-simplify', 'step-file'].every(
          (step) => run.values[`${step}-status`] === 'failed',
        ) &&
        run.violations.some(
          (violation) => violation.startsWith('[worker]') && violation.includes('wasm-eval'),
        )
      )
    case 'worker-blocked':
      return (
        status('step-boot') === 'failed' &&
        allViolations.some((violation) => violation.includes('worker-src'))
      )
  }
}

async function runExperiment(
  browser: Browser,
  report: AssetReport,
  experiment: Experiment,
): Promise<ExperimentResult> {
  const plugins = experiment.workerCsp
    ? [workerCspPlugin(report.workerChunk, experiment.workerCsp)]
    : []
  const server = await startPreview(
    EXPERIMENT_PORT,
    { 'Content-Security-Policy': experiment.documentCsp },
    plugins,
  )
  try {
    const run = await runSpikePage(
      browser,
      `http://localhost:${EXPERIMENT_PORT}${SPIKE_PATH}`,
      false,
    )
    const steps: Record<string, string> = {}
    const errors: Record<string, string> = {}
    for (const step of STEP_IDS) {
      steps[step] = run.values[`${step}-status`] ?? 'missing'
      const error = run.values[`${step}-error`]
      if (error) errors[step] = error
    }
    return {
      id: experiment.id,
      question: experiment.question,
      expect: experiment.expect,
      met: meetsExpectation(experiment.expect, run),
      steps,
      errors,
      violations: [
        ...run.earlyViolations.map((violation) => `[pre-mount] ${violation}`),
        ...run.violations,
      ],
      consoleErrors: run.consoleErrors,
    }
  } finally {
    await server.close()
  }
}

function printExperiment(result: ExperimentResult): void {
  check(`experiment ${result.id}: ${result.expect}`, result.met, result.question)
  console.log(
    `        steps: ${Object.entries(result.steps)
      .map(([step, status]) => `${step}=${status}`)
      .join(' ')}`,
  )
  for (const [step, error] of Object.entries(result.errors))
    console.log(`        ${step} error: ${error}`)
  for (const violation of result.violations) console.log(`        violation: ${violation}`)
  for (const error of result.consoleErrors) console.log(`        console: ${error}`)
}

// ---------------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!options.skipBuild) {
    section(`Build (VITE_SPIKES=1, outDir ${OUT_DIR})`)
    buildSpikes()
  }
  if (!existsSync(ASSETS_PATH))
    throw new Error(`${OUT_DIR}/assets is missing: build first or drop --skip-build`)

  section(`${OUT_DIR}/assets: chunks that matter (raw / gzip)`)
  const report = inspectAssets()
  printAssets(report)
  checkChunking(report)

  const servers: PreviewServer[] = []
  const browsers: Browser[] = []
  const summary: Record<string, unknown> = { csp: CSP, assets: report.assets }
  try {
    servers.push(await startPreview(MAIN_PORT))

    section(`Response headers (vite preview on 127.0.0.1:${MAIN_PORT})`)
    await checkHeaders(`http://localhost:${MAIN_PORT}`, report)

    const launch = (extraArgs: string[] = []) =>
      chromium.launch({ channel: 'chromium', headless: !options.headed, args: extraArgs })

    section(`Secure origin: http://localhost:${MAIN_PORT}${SPIKE_PATH}`)
    const secureBrowser = await launch()
    browsers.push(secureBrowser)
    console.log(`  browser: Chromium ${secureBrowser.version()}`)
    summary.browser = secureBrowser.version()
    const secure = await runSpikePage(
      secureBrowser,
      `http://localhost:${MAIN_PORT}${SPIKE_PATH}`,
      true,
    )
    checkWorkingRun('[secure]', secure, true)
    summary.secure = secure

    section(`Insecure origin: http://${LAN_HOST}:${MAIN_PORT}${SPIKE_PATH} (--host-resolver-rules)`)
    const lanBrowser = await launch([`--host-resolver-rules=MAP ${LAN_HOST} 127.0.0.1`])
    browsers.push(lanBrowser)
    const insecure = await runSpikePage(
      lanBrowser,
      `http://${LAN_HOST}:${MAIN_PORT}${SPIKE_PATH}`,
      true,
    )
    check(
      '[insecure] stayed on plain HTTP lan.test (no HTTPS upgrade)',
      insecure.finalUrl.startsWith(`http://${LAN_HOST}:`),
    )
    checkWorkingRun('[insecure]', insecure, false)
    check(
      '[insecure] hash-wasm digest equals the secure-origin digest',
      insecure.values['sha256-hash-wasm'] === secure.values['sha256-hash-wasm'],
    )
    summary.insecure = insecure

    section(`Experiments (modified CSP on :${EXPERIMENT_PORT}; expected outcome after the colon)`)
    const experiments: ExperimentResult[] = []
    for (const experiment of EXPERIMENTS) {
      const result = await runExperiment(secureBrowser, report, experiment)
      printExperiment(result)
      experiments.push(result)
    }
    summary.experiments = experiments
  } finally {
    await Promise.allSettled(browsers.map((browser) => browser.close()))
    await Promise.allSettled(servers.map((server) => server.close()))
    if (!options.keep)
      rmSync(OUT_PATH, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }

  const failed = checks.filter((entry) => !entry.ok)
  summary.checks = checks
  summary.notes = notes
  if (options.jsonPath) writeFileSync(options.jsonPath, `${JSON.stringify(summary, null, 2)}\n`)
  section(
    `Summary: ${checks.length} checks, ${failed.length} failed, ${notes.length} notes` +
      (options.keep ? '' : `; ${OUT_DIR}/ deleted`),
  )
  for (const entry of failed) console.log(`  FAIL  ${entry.name}  ${entry.detail}`)
  for (const message of notes) console.log(`  NOTE  ${message}`)
  if (failed.length > 0) process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
