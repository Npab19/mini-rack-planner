/**
 * Validates the shared catalog (catalog/**) and keeps its derived files up to date.
 *
 *   npm run validate-catalog              # validate, add new ids to ids.lock, regenerate catalog/schema
 *   npm run validate-catalog -- --check   # validate only; also fail if ids.lock or catalog/schema
 *                                         # are out of date (CI)
 *   ... -- --catalog-dir <path>           # validate another folder (default: catalog/)
 *
 * Checks: no stray or model files; valid JSON; every entry matches its zod schema with no unknown
 * fields; kind matches folder and id matches file name; unique ids; references resolve (hardware,
 * prints, devices, frames, 3D parts, fastener screws and nuts); curation rules (source link,
 * verified block, licence label, facts only); alignment records; published ids (ids.lock, with
 * retired ids mapped in replaced.json). Exits 1 on any error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
  entryPathParts,
  parseCatalogDocuments,
  type CatalogDocument,
  type ParsedEntry,
} from '../src/catalog/parse'
import { createLookup } from '../src/catalog/resolver'
import { catalogRevision } from '../src/catalog/revision'
import {
  alignmentProblems,
  checkIdsLock,
  crossReferenceProblems,
  curationReport,
  formatIdsLock,
  parseIdsLock,
  parseReplacedMap,
  publishedKeys,
  unknownKeys,
} from '../src/catalog/validate'
import { AlignRecordSchema } from '../src/domain/schema/align'
import {
  DeviceSchema,
  FrameSchema,
  HardwareSchema,
  ItemSchema,
  type CatalogLookup,
} from '../src/domain/schema/catalog'
import { ConditionSchema } from '../src/domain/schema/common'
import { CATALOG_DIR, listFiles, readJsonFile } from './lib/catalogFs'

type Severity = 'error' | 'warning'

interface Finding {
  /** Path inside catalog/. */
  path: string
  severity: Severity
  message: string
}

type FileRole = 'entry' | 'alignment' | 'schema' | 'meta' | 'placeholder' | 'unexpected'

const META_FILES: readonly string[] = ['README.md', 'LICENSE', 'ids.lock', 'replaced.json']
const MODEL_FILE = /\.(?:stl|3mf|step|stp|zip|gcode)$/i
const ALIGNMENT_FILE = /^alignments\/([^/]+)\.json$/
const SCHEMA_FILE = /^schema\/[^/]+\.schema\.json$/

function fileRole(path: string): FileRole {
  if (META_FILES.includes(path)) return 'meta'
  if (path.endsWith('.gitkeep')) return 'placeholder'
  if (entryPathParts(path) !== undefined) return 'entry'
  if (ALIGNMENT_FILE.test(path)) return 'alignment'
  if (SCHEMA_FILE.test(path)) return 'schema'
  return 'unexpected'
}

function unexpectedFileMessage(path: string): string {
  if (MODEL_FILE.test(path)) {
    return 'model files must never be committed (designer licences, MakerWorld terms); users drop their own downloads into the app'
  }
  return 'unexpected file: entries go in frames/, items/, devices/ or hardware/ as <id>.json'
}

// ---------------------------------------------------------------------------------------------
// JSON Schemas for contributors (catalog/schema, generated)

interface SchemaTarget {
  file: string
  title: string
  description: string
  schema: z.ZodType
}

const SCHEMA_TARGETS: readonly SchemaTarget[] = [
  {
    file: 'frame.schema.json',
    title: 'Mini Rack Planner catalog: frame',
    description: 'A rack frame system, one file per frame in catalog/frames/<id>.json.',
    schema: FrameSchema,
  },
  {
    file: 'item.schema.json',
    title: 'Mini Rack Planner catalog: item or extra',
    description:
      'A printed mount, panel, shelf or accessory, one file per item in catalog/items/<id>.json.',
    schema: ItemSchema,
  },
  {
    file: 'device.schema.json',
    title: 'Mini Rack Planner catalog: device',
    description:
      'Equipment such as a mini PC, switch or drive, one file per device in catalog/devices/<id>.json.',
    schema: DeviceSchema,
  },
  {
    file: 'hardware.schema.json',
    title: 'Mini Rack Planner catalog: hardware',
    description:
      'A screw, nut, insert, magnet or other bought part, one file per part in catalog/hardware/<id>.json.',
    schema: HardwareSchema,
  },
  {
    file: 'alignment.schema.json',
    title: 'Mini Rack Planner catalog: alignment record',
    description:
      "How a designer's model file maps onto a catalog 3D part, in catalog/alignments/<id>.json.",
    schema: AlignRecordSchema,
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Marks objects closed (`additionalProperties: false`) like the validator, which rejects unknown
 * fields; zod's input schemas leave them open because parsing strips them silently.
 */
function closeObjects(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(closeObjects)
  if (!isRecord(value)) return value
  const closed: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) closed[key] = closeObjects(inner)
  if (isRecord(closed.properties) && closed.additionalProperties === undefined) {
    closed.additionalProperties = false
  }
  return closed
}

function renderJsonSchema(target: SchemaTarget): string {
  const registry = z.registry<{ id: string }>()
  registry.add(ConditionSchema, { id: 'Condition' })
  const generated = z.toJSONSchema(target.schema, { io: 'input', metadata: registry })
  const { $schema, ...rest } = generated
  const document = { $schema, title: target.title, description: target.description, ...rest }
  return `${JSON.stringify(closeObjects(document), null, 2)}\n`
}

// ---------------------------------------------------------------------------------------------
// Checks

interface Context {
  /** The catalog folder being validated. */
  dir: string
  check: boolean
  files: readonly string[]
  findings: Finding[]
  written: string[]
}

function report(ctx: Context, path: string, severity: Severity, message: string): void {
  ctx.findings.push({ path, severity, message })
}

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/** Writes `content` (write mode) or reports drift (check mode) when the file differs. */
function syncGeneratedFile(ctx: Context, path: string, content: string, hint: string): void {
  const absolute = join(ctx.dir, path)
  if (readText(absolute)?.replaceAll('\r\n', '\n') === content) return
  if (ctx.check) {
    report(ctx, path, 'error', `out of date: ${hint} (run \`npm run validate-catalog\`)`)
    return
  }
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content)
  ctx.written.push(path)
}

function checkFiles(ctx: Context): void {
  for (const path of ctx.files) {
    if (fileRole(path) === 'unexpected') report(ctx, path, 'error', unexpectedFileMessage(path))
  }
}

function readEntries(ctx: Context): ParsedEntry[] {
  const documents: CatalogDocument[] = []
  for (const path of ctx.files.filter((file) => fileRole(file) === 'entry')) {
    const result = readJsonFile(join(ctx.dir, path))
    if (result.ok) documents.push({ path, data: result.data })
    else report(ctx, path, 'error', `invalid JSON: ${result.error}`)
  }
  const parsed = parseCatalogDocuments(documents)
  for (const problem of parsed.problems) report(ctx, problem.path, 'error', problem.message)
  return parsed.parsed
}

function checkEntryRules(
  ctx: Context,
  parsed: readonly ParsedEntry[],
  lookup: CatalogLookup,
): void {
  for (const { path, entry, raw } of parsed) {
    for (const key of unknownKeys(raw, entry)) {
      report(ctx, path, 'error', `${key}: unknown field (see catalog/schema for the field names)`)
    }
    for (const message of crossReferenceProblems(entry, lookup)) report(ctx, path, 'error', message)
    const curation = curationReport(entry)
    for (const message of curation.errors) report(ctx, path, 'error', message)
    for (const message of curation.warnings) report(ctx, path, 'warning', message)
  }
}

function checkAlignments(ctx: Context, lookup: CatalogLookup): number {
  let count = 0
  for (const path of ctx.files) {
    const name = ALIGNMENT_FILE.exec(path)?.[1]
    if (name === undefined) continue
    count++
    const json = readJsonFile(join(ctx.dir, path))
    if (!json.ok) {
      report(ctx, path, 'error', `invalid JSON: ${json.error}`)
      continue
    }
    const result = AlignRecordSchema.safeParse(json.data)
    if (!result.success) {
      for (const issue of result.error.issues) {
        report(ctx, path, 'error', `${issue.path.map(String).join('.')}: ${issue.message}`)
      }
      continue
    }
    for (const message of alignmentProblems(result.data, name, lookup)) {
      report(ctx, path, 'error', message)
    }
  }
  return count
}

function readReplacedMap(ctx: Context): Record<string, string> {
  const path = join(ctx.dir, 'replaced.json')
  if (!existsSync(path)) return {}
  const json = readJsonFile(path)
  if (!json.ok) {
    report(ctx, 'replaced.json', 'error', `invalid JSON: ${json.error}`)
    return {}
  }
  const { map, problems } = parseReplacedMap(json.data)
  for (const message of problems) report(ctx, 'replaced.json', 'error', message)
  return map
}

function checkPublishedIds(ctx: Context, parsed: readonly ParsedEntry[]): void {
  const lockText = readText(join(ctx.dir, 'ids.lock')) ?? ''
  const locked = parseIdsLock(lockText)
  const replaced = readReplacedMap(ctx)
  const current = new Set(parsed.flatMap(({ entry }) => publishedKeys(entry)))
  // Keys of entry files that failed to load are not reported as missing: those files already
  // have their own errors, and their keys are unknown until they load again.
  const loadedPaths = new Set(parsed.map((item) => item.path))
  const unloadedIds = new Set(
    ctx.files
      .filter((file) => fileRole(file) === 'entry' && !loadedPaths.has(file))
      .map((file) => entryPathParts(file)?.name),
  )
  const present = new Set([
    ...current,
    ...locked.filter((key) => unloadedIds.has(key.split('#')[0])),
  ])
  const lock = checkIdsLock(locked, present, replaced)
  for (const problem of lock.problems) report(ctx, problem.file, 'error', problem.message)
  const unlocked = lock.unlocked.length
  syncGeneratedFile(
    ctx,
    'ids.lock',
    formatIdsLock([...locked, ...current]),
    `${unlocked} published id${unlocked === 1 ? ' is' : 's are'} not locked yet`,
  )
}

function checkSchemas(ctx: Context): void {
  const expected = new Set(SCHEMA_TARGETS.map((target) => `schema/${target.file}`))
  for (const path of ctx.files.filter((file) => fileRole(file) === 'schema')) {
    if (!expected.has(path)) report(ctx, path, 'error', 'stale generated schema: delete it')
  }
  for (const target of SCHEMA_TARGETS) {
    syncGeneratedFile(ctx, `schema/${target.file}`, renderJsonSchema(target), 'regenerate it')
  }
}

// ---------------------------------------------------------------------------------------------
// Report

function printFindings(findings: readonly Finding[]): void {
  const paths = [...new Set(findings.map((finding) => finding.path))].toSorted()
  for (const path of paths) {
    console.log(`\ncatalog/${path}`)
    for (const finding of findings.filter((candidate) => candidate.path === path)) {
      console.log(`  ${finding.severity}: ${finding.message}`)
    }
  }
}

function summary(parsed: readonly ParsedEntry[], alignments: number): string {
  const counts = new Map<string, number>()
  for (const { entry } of parsed) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1)
  const kinds = ['frame', 'item', 'extra', 'device', 'hardware']
    .map((kind) => `${counts.get(kind) ?? 0} ${kind}`)
    .join(', ')
  const revision = catalogRevision(parsed.map(({ entry, raw }) => ({ id: entry.id, raw })))
  return `${parsed.length} entries (${kinds}), ${alignments} alignments, revision ${revision}`
}

/** `--catalog-dir <path>` validates another folder (used to try the checks on a scratch copy). */
function catalogDirArg(argv: readonly string[]): string {
  const index = argv.indexOf('--catalog-dir')
  return index === -1 ? CATALOG_DIR : resolve(argv[index + 1] ?? CATALOG_DIR)
}

function main(): void {
  const dir = catalogDirArg(process.argv)
  const ctx: Context = {
    dir,
    check: process.argv.includes('--check'),
    files: listFiles(dir),
    findings: [],
    written: [],
  }
  checkFiles(ctx)
  const parsed = readEntries(ctx)
  const lookup = createLookup(parsed.map(({ entry }) => entry))
  checkEntryRules(ctx, parsed, lookup)
  const alignments = checkAlignments(ctx, lookup)
  checkPublishedIds(ctx, parsed)
  checkSchemas(ctx)

  console.log(`validate-catalog: ${summary(parsed, alignments)}`)
  printFindings(ctx.findings)
  for (const path of ctx.written) console.log(`wrote catalog/${path}`)
  const errors = ctx.findings.filter((finding) => finding.severity === 'error').length
  const warnings = ctx.findings.length - errors
  // One stream (stdout) keeps the summary after the findings when output is piped.
  if (errors > 0) {
    console.log(`\nvalidate-catalog: FAILED with ${errors} error(s), ${warnings} warning(s)`)
    process.exitCode = 1
  } else {
    console.log(`\nvalidate-catalog: OK (${warnings} warning(s))`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
