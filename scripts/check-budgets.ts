/**
 * Bundle budgets, checked in CI after `vite build`:  npm run check-budgets
 *
 * Groups (limits in budgets.json; sizes are gzip level 6, as nginx serves them, in kB of 1000 bytes
 * like Vite's build report):
 *  - initial: the index.html entry and its static imports, recursively. Dynamic imports load later
 *    and are excluded. Capped by `initialJsGzipKb`, and it must not bundle three, @react-three/*,
 *    fflate, hash-wasm or meshoptimizer.
 *  - lazy:<feature>: the dynamic entries under src/features/<feature>/ plus the chunks they pull in
 *    that are not already initial. Capped by `lazyChunkGzipKb[feature]`.
 *  - worker: each module worker (its entry chunk plus static imports). Capped by `workerGzipKb`.
 * Going over a budget by up to `tolerancePct` only warns; beyond that the script exits 1.
 *
 * The Vite manifest lists module ids only for entry chunks, so the packages inside a chunk come
 * from its source map (`sources` names every bundled module). If a map is missing
 * (build.sourcemap off), a heuristic scans the code for strings that survive minification, such
 * as three's `__THREE__` global or fflate's "invalid zip data" message.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { z } from 'zod'

const GZIP_LEVEL = 6
const BYTES_PER_KB = 1000
const JS_FILE = /\.m?js$/
const WORKER_FILE = /\.worker-[\w-]+\.m?js$/

const ManifestChunkSchema = z.object({
  file: z.string(),
  src: z.string().optional(),
  name: z.string().optional(),
  isEntry: z.boolean().optional(),
  isDynamicEntry: z.boolean().optional(),
  imports: z.array(z.string()).optional(),
  dynamicImports: z.array(z.string()).optional(),
  css: z.array(z.string()).optional(),
  assets: z.array(z.string()).optional(),
})
const ManifestSchema = z.record(z.string(), ManifestChunkSchema)

const BudgetsSchema = z.object({
  initialJsGzipKb: z.number().positive(),
  lazyChunkGzipKb: z.record(z.string(), z.number().positive()),
  workerGzipKb: z.number().positive(),
  tolerancePct: z.number().min(0),
})

const SourceMapSchema = z.object({ sources: z.array(z.string().nullable()) })

export type Manifest = z.infer<typeof ManifestSchema>
export type Budgets = z.infer<typeof BudgetsSchema>

export type ChunkInfo = {
  rawBytes: number
  gzipBytes: number
  /** Names from HEAVY_PACKAGES found in this chunk. */
  heavyPackages: string[]
  detection: 'sourcemap' | 'heuristic'
  /** Relative static import specifiers as written in the chunk, e.g. "./shared-abc.js". */
  staticImports: string[]
}
export type ChunkReader = (file: string) => ChunkInfo

export type Status = 'ok' | 'warn' | 'fail' | 'skip'
export type Check = { status: Status; text: string }
export type Row = { group: string; file: string; info: ChunkInfo }
export type Report = { rows: Row[]; checks: Check[] }

/** Packages that belong in lazy chunks or workers only (see CLAUDE.md, architecture boundaries). */
const HEAVY_PACKAGES: ReadonlyArray<{
  name: string
  matches: (pkg: string) => boolean
  marker: RegExp
}> = [
  {
    name: 'three',
    matches: (pkg) => pkg === 'three' || pkg.startsWith('three-'),
    marker: /__THREE__|WebGLRenderer/,
  },
  { name: '@react-three/*', matches: (pkg) => pkg.startsWith('@react-three/'), marker: /R3F: / },
  { name: 'fflate', matches: (pkg) => pkg === 'fflate', marker: /invalid zip data/ },
  { name: 'hash-wasm', matches: (pkg) => pkg === 'hash-wasm', marker: /hash-wasm/ },
  {
    name: 'meshoptimizer',
    matches: (pkg) => pkg === 'meshoptimizer',
    marker: /Meshopt(?:Decoder|Encoder|Simplifier)/,
  },
]

/** npm package of a bundled module path, e.g. `../../node_modules/@react-three/fiber/dist/x.js`. */
export function packageName(source: string): string | undefined {
  const path = source.replaceAll('\\', '/')
  const marker = 'node_modules/'
  const at = path.lastIndexOf(marker)
  if (at === -1) return undefined
  const [first, second] = path.slice(at + marker.length).split('/')
  if (!first) return undefined
  return first.startsWith('@') && second ? `${first}/${second}` : first
}

export function heavyPackagesInSources(sources: readonly string[]): string[] {
  const packages = new Set(sources.map(packageName).filter((pkg) => pkg !== undefined))
  return HEAVY_PACKAGES.filter(({ matches }) => [...packages].some(matches)).map(({ name }) => name)
}

/** Heuristic fallback when a chunk has no source map. */
export function heavyPackagesInCode(code: string): string[] {
  return HEAVY_PACKAGES.filter(({ marker }) => marker.test(code)).map(({ name }) => name)
}

/**
 * Relative static imports of a minified ES chunk, such as `import{a}from"./x.js"`, `import"./x.js"`
 * or `export*from"./x.js"`. Dynamic `import()` calls are not matched.
 */
export function staticImportSpecifiers(code: string): string[] {
  const pattern = /\b(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?["'](\.\.?\/[^"']+)["']/g
  return [...code.matchAll(pattern)].flatMap((match) => (match[1] ? [match[1]] : []))
}

/** Manifest keys reachable from `start` through static `imports` only. */
export function staticClosure(manifest: Manifest, start: readonly string[]): string[] {
  const seen = new Set<string>()
  const queue = [...start]
  for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
    if (seen.has(key)) continue
    const chunk = manifest[key]
    if (!chunk) throw new Error(`manifest has no entry for import "${key}"`)
    seen.add(key)
    queue.push(...(chunk.imports ?? []))
  }
  return [...seen]
}

export function initialChunkKeys(manifest: Manifest): string[] {
  const entries = Object.keys(manifest).filter((key) => manifest[key]?.isEntry === true)
  return staticClosure(manifest, entries)
}

/** Chunks needed to open a lazily loaded feature folder that are not already in the initial set. */
export function lazyFeatureKeys(
  manifest: Manifest,
  feature: string,
  initial: ReadonlySet<string>,
): string[] {
  const prefix = `src/features/${feature}/`
  const entries = Object.entries(manifest)
    .filter(
      ([key, chunk]) => chunk.isDynamicEntry === true && (chunk.src ?? key).startsWith(prefix),
    )
    .map(([key]) => key)
  return staticClosure(manifest, entries).filter((key) => !initial.has(key))
}

/**
 * Module worker entry chunks. Vite lists a worker as an `assets` file of the chunk that creates it
 * (not as a manifest entry); the `.worker-<hash>.js` name also catches workers started by workers.
 */
export function workerEntryFiles(manifest: Manifest, jsFiles: readonly string[]): string[] {
  const referenced = Object.values(manifest)
    .flatMap((chunk) => chunk.assets ?? [])
    .filter((file) => JS_FILE.test(file))
  const named = jsFiles.filter((file) => WORKER_FILE.test(file))
  return [...new Set([...referenced, ...named])].toSorted()
}

/**
 * A worker's entry file plus every chunk it imports statically. Chunks inside a worker are not in
 * the manifest, so the imports come from the code.
 */
export function workerClosure(
  entry: string,
  read: ChunkReader,
  known: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>()
  const queue = [entry]
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file) || !known.has(file)) continue
    seen.add(file)
    const dir = posix.dirname(file)
    queue.push(...read(file).staticImports.map((specifier) => posix.join(dir, specifier)))
  }
  return [...seen]
}

export function budgetStatus(actualKb: number, budgetKb: number, tolerancePct: number): Status {
  if (actualKb <= budgetKb) return 'ok'
  return actualKb <= budgetKb * (1 + tolerancePct / 100) ? 'warn' : 'fail'
}

const toKb = (bytes: number): number => bytes / BYTES_PER_KB
const formatKb = (bytes: number): string => toKb(bytes).toFixed(1)
const sumGzip = (infos: readonly ChunkInfo[]): number =>
  infos.reduce((total, info) => total + info.gzipBytes, 0)

function sizeCheck(
  label: string,
  gzipBytes: number,
  budgetKb: number,
  tolerancePct: number,
): Check {
  const status = budgetStatus(toKb(gzipBytes), budgetKb, tolerancePct)
  const verdict = status === 'warn' ? ` (over, within the ${tolerancePct}% tolerance)` : ''
  return { status, text: `${label}: ${formatKb(gzipBytes)} kB of ${budgetKb} kB${verdict}` }
}

function heavyPackageCheck(initialRows: readonly Row[]): Check {
  const offenders = initialRows.filter((row) => row.info.heavyPackages.length > 0)
  const names = HEAVY_PACKAGES.map(({ name }) => name).join(', ')
  if (offenders.length === 0) {
    return { status: 'ok', text: `initial chunks bundle none of: ${names}` }
  }
  const details = offenders.map(
    ({ file, info }) => `${file} has ${info.heavyPackages.join(', ')} (${info.detection})`,
  )
  return {
    status: 'fail',
    text:
      `initial chunks must not bundle ${names}. Found: ${details.join('; ')}. ` +
      'Load them through React.lazy or a worker.',
  }
}

/** Pure core: sizes every relevant chunk via `read` and evaluates the budgets. */
export function checkBudgets(
  manifest: Manifest,
  budgets: Budgets,
  jsFiles: readonly string[],
  read: ChunkReader,
): Report {
  const rows: Row[] = []
  const checks: Check[] = []
  const measure = (group: string, files: readonly string[]): ChunkInfo[] =>
    files.map((file) => {
      const info = read(file)
      rows.push({ group, file, info })
      return info
    })
  const filesOf = (keys: readonly string[]): string[] =>
    keys.flatMap((key) => manifest[key]?.file ?? []).filter((file) => JS_FILE.test(file))

  const initialKeys = initialChunkKeys(manifest)
  if (initialKeys.length === 0) {
    checks.push({ status: 'fail', text: 'no entry chunk (isEntry) in the Vite manifest' })
  }
  const initial = measure('initial', filesOf(initialKeys))
  checks.push(
    sizeCheck('initial JS', sumGzip(initial), budgets.initialJsGzipKb, budgets.tolerancePct),
  )
  checks.push(heavyPackageCheck(rows.filter((row) => row.group === 'initial')))
  const initialCss = new Set(initialKeys.flatMap((key) => manifest[key]?.css ?? []))
  measure('initial css', [...initialCss])

  const initialSet = new Set(initialKeys)
  for (const [feature, budgetKb] of Object.entries(budgets.lazyChunkGzipKb)) {
    const keys = lazyFeatureKeys(manifest, feature, initialSet)
    if (keys.length === 0) {
      checks.push({
        status: 'skip',
        text: `lazy:${feature}: no dynamic entry under src/features/${feature}/ yet`,
      })
      continue
    }
    const infos = measure(`lazy:${feature}`, filesOf(keys))
    checks.push(sizeCheck(`lazy:${feature}`, sumGzip(infos), budgetKb, budgets.tolerancePct))
  }

  const known = new Set(jsFiles)
  const workers = workerEntryFiles(manifest, jsFiles)
  if (workers.length === 0) checks.push({ status: 'skip', text: 'workers: none in this build yet' })
  for (const worker of workers) {
    const infos = measure('worker', workerClosure(worker, read, known))
    checks.push(
      sizeCheck(`worker ${worker}`, sumGzip(infos), budgets.workerGzipKb, budgets.tolerancePct),
    )
  }

  // Everything else (route chunks, chunks loaded inside workers) is listed for information only.
  const listed = new Set(rows.map((row) => row.file))
  measure(
    'other lazy',
    jsFiles.filter((file) => !listed.has(file)),
  )
  return { rows, checks }
}

// ---- I/O ----

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readSourceMapSources(mapPath: string): string[] | undefined {
  if (!existsSync(mapPath)) return undefined
  const parsed = SourceMapSchema.safeParse(readJson(mapPath))
  if (!parsed.success) return undefined
  return parsed.data.sources.filter((source) => source !== null)
}

function createReader(dist: string): ChunkReader {
  const cache = new Map<string, ChunkInfo>()
  return (file) => {
    const cached = cache.get(file)
    if (cached) return cached
    const path = join(dist, file)
    const bytes = readFileSync(path)
    const code = bytes.toString('utf8')
    const sources = readSourceMapSources(`${path}.map`)
    const info: ChunkInfo = {
      rawBytes: bytes.length,
      gzipBytes: gzipSync(bytes, { level: GZIP_LEVEL }).length,
      heavyPackages: sources ? heavyPackagesInSources(sources) : heavyPackagesInCode(code),
      detection: sources ? 'sourcemap' : 'heuristic',
      staticImports: JS_FILE.test(file) ? staticImportSpecifiers(code) : [],
    }
    cache.set(file, info)
    return info
  }
}

function listJsFiles(dist: string): string[] {
  const assetsDir = join(dist, 'assets')
  if (!existsSync(assetsDir)) return []
  return readdirSync(assetsDir, { recursive: true, encoding: 'utf8' })
    .map((name) => `assets/${name.replaceAll('\\', '/')}`)
    .filter((file) => JS_FILE.test(file))
    .toSorted()
}

function formatReport({ rows, checks }: Report): string {
  const widths = { group: 14, size: 9 }
  const fileWidth = Math.max(4, ...rows.map((row) => row.file.length))
  const header = [
    'group'.padEnd(widths.group),
    'gzip kB'.padStart(widths.size),
    'raw kB'.padStart(widths.size),
    '  ',
    'file'.padEnd(fileWidth),
    '  notes',
  ].join('')
  const lines = rows.map(({ group, file, info }) => {
    const notes = [
      ...info.heavyPackages,
      ...(info.detection === 'heuristic' && JS_FILE.test(file)
        ? ['(no source map: heuristic)']
        : []),
    ].join(', ')
    return [
      group.padEnd(widths.group),
      formatKb(info.gzipBytes).padStart(widths.size),
      formatKb(info.rawBytes).padStart(widths.size),
      '  ',
      file.padEnd(fileWidth),
      notes ? `  ${notes}` : '',
    ]
      .join('')
      .trimEnd()
  })
  const statusLabel: Record<Status, string> = {
    ok: 'OK  ',
    warn: 'WARN',
    fail: 'FAIL',
    skip: 'SKIP',
  }
  return [
    `Bundle sizes (gzip level ${GZIP_LEVEL}, 1 kB = ${BYTES_PER_KB} bytes)`,
    header,
    ...lines,
    '',
    'Budgets (budgets.json)',
    ...checks.map(({ status, text }) => `${statusLabel[status]}  ${text}`),
  ].join('\n')
}

function main(): void {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const dist = join(root, 'dist')
  const manifestPath = join(dist, '.vite', 'manifest.json')
  if (!existsSync(manifestPath)) {
    console.error(
      'check-budgets: dist/.vite/manifest.json not found. ' +
        'Run `npm run build` first (build.manifest must stay on).',
    )
    process.exit(1)
  }
  const manifest = ManifestSchema.parse(readJson(manifestPath))
  const budgets = BudgetsSchema.parse(readJson(join(root, 'budgets.json')))
  const report = checkBudgets(manifest, budgets, listJsFiles(dist), createReader(dist))
  console.log(formatReport(report))
  const failures = report.checks.filter((check) => check.status === 'fail').length
  if (failures > 0) {
    console.error(`\ncheck-budgets: ${failures} budget check(s) failed.`)
    process.exit(1)
  }
  console.log('\ncheck-budgets: all budgets met.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
