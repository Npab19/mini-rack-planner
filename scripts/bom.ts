/**
 * Bill of materials of a plan file, computed from the catalog on disk.
 *
 *   npm run bom -- <plan.json>               # shopping list (Markdown)
 *   npm run bom -- <plan.json> --full        # every line: in plan, in your rack, to get, surplus
 *   npm run bom -- <plan.json> --json        # shopping list as JSON (fixtures/expected)
 *   npm run bom -- <plan.json> --full --json # the whole BomResult as JSON
 *   ... --spares                             # default spare percentages (otherwise none)
 *   ... --out <file>                         # write to a file instead of stdout
 *
 * The inventory is empty and the plan's own custom entries are merged over the catalog.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mergeLookups } from '../src/catalog/resolver'
import type { BomLine, BomResult } from '../src/domain/api'
import { computeBom, shoppingLines } from '../src/domain/bom'
import { formatU, uToSixths } from '../src/domain/geometry'
import { parseLineKey } from '../src/domain/ids'
import { migratePlan, PlanInvalidError } from '../src/domain/migrate'
import { sectionHeightU } from '../src/domain/recipe'
import type { CatalogLookup } from '../src/domain/schema/catalog'
import type { Plan } from '../src/domain/schema/plan'
import { defaultSettings, type Settings } from '../src/domain/schema/settings'
import { loadCatalogFromDisk, stripBom } from './lib/catalogFs'

export interface BomCliOptions {
  planPath: string
  full: boolean
  json: boolean
  spares: boolean
  out?: string
}

const USAGE = 'usage: npm run bom -- <plan.json> [--full] [--json] [--spares] [--out <file>]'

export function parseBomArgs(argv: readonly string[]): BomCliOptions | { error: string } {
  const flags = new Set(['--full', '--json', '--spares'])
  const positional: string[] = []
  let out: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ''
    if (arg === '--out') {
      out = argv[++index]
      if (out === undefined) return { error: `--out needs a file name\n${USAGE}` }
    } else if (arg.startsWith('--') && !flags.has(arg)) {
      return { error: `unknown option ${arg}\n${USAGE}` }
    } else if (!arg.startsWith('--')) {
      positional.push(arg)
    }
  }
  const [planPath, ...extra] = positional
  if (planPath === undefined || extra.length > 0) return { error: USAGE }
  return {
    planPath,
    full: argv.includes('--full'),
    json: argv.includes('--json'),
    spares: argv.includes('--spares'),
    ...(out === undefined ? {} : { out }),
  }
}

/** Default settings; spare percentages only with --spares, so the output shows exact counts. */
export function bomSettings(spares: boolean): Settings {
  const settings = defaultSettings()
  return spares ? settings : { ...settings, sparePct: { default: 0 } }
}

// ---------------------------------------------------------------------------------------------
// Formatting

function formatMinutes(minutes: number): string {
  const rounded = Math.round(minutes)
  const hours = Math.floor(rounded / 60)
  const rest = rounded % 60
  if (hours === 0) return `${rest} min`
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

function formatNumber(value: number | undefined): string {
  if (value === undefined) return ''
  return String(Math.round(value * 100) / 100)
}

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function table(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const align = headers.map((header) => (header.startsWith('>') ? '---:' : '---'))
  const names = headers.map((header) => header.replace(/^>/, ''))
  const lines = [names, align, ...rows].map((cells) => `| ${cells.map(escapeCell).join(' | ')} |`)
  return lines.join('\n')
}

/** Plate name of a print line, looked up in the frame or item that owns the print. */
function plateOf(line: BomLine, catalog: CatalogLookup): string {
  const parsed = parseLineKey(line.key)
  if (parsed?.kind !== 'print') return ''
  const owner = catalog.frame(parsed.ownerId) ?? catalog.item(parsed.ownerId)
  return owner?.prints.find((print) => print.id === parsed.printId)?.plate ?? ''
}

function hardwareLabel(line: BomLine): string {
  return line.cutLengthMm === undefined
    ? line.label
    : `${line.label}, cut to ${formatNumber(line.cutLengthMm)} mm`
}

function withUnit(value: number, line: BomLine): string {
  return line.unit === 'mm' ? `${value} mm` : String(value)
}

function stackSummary(plan: Plan, catalog: CatalogLookup): string {
  const frame = catalog.frame(plan.frame.frameId)
  const sections = plan.frame.sections.map((section) => {
    const heightU = sectionHeightU(frame, section.typeId, section.heightU)
    // An unknown frame or section type has no height: show the type id instead.
    const label = heightU > 0 ? formatU(uToSixths(heightU)) : section.typeId
    return { label, heightU, have: section.have !== undefined }
  })
  const totalU = sections.reduce((sum, section) => sum + section.heightU, 0)
  const parts = sections.map((section) => `${section.label} ${section.have ? '(have)' : '(new)'}`)
  const name = frame?.name ?? `unknown frame "${plan.frame.frameId}"`
  return `${name}, ${formatU(uToSixths(totalU))}: ${parts.join(' + ') || 'no sections'} (bottom to top)`
}

function gramsSummary(gramsByMaterial: Readonly<Record<string, number>>): string {
  const parts = Object.entries(gramsByMaterial).map(
    ([material, grams]) => `${Math.round(grams)} g ${material}`,
  )
  return parts.length > 0 ? parts.join(', ') : '0 g'
}

/** Filament plus hardware with known pack prices, in the settings currency. */
function costLine(cost: number | undefined, currency: string): string[] {
  return cost === undefined
    ? []
    : [`- Estimated cost: ${cost.toFixed(2)} ${currency} (filament and priced packs)`]
}

function markdownSection(title: string, lines: readonly BomLine[], render: () => string): string {
  return `## ${title}\n\n${lines.length === 0 ? '_Nothing._' : render()}`
}

function shoppingMarkdown(result: BomResult, catalog: CatalogLookup, currency: string): string[] {
  const lines = shoppingLines(result)
  const prints = lines.filter((line) => line.kind === 'print')
  const hardware = lines.filter((line) => line.kind === 'hardware')
  const devices = lines.filter((line) => line.kind === 'device')
  const { totals } = result
  return [
    markdownSection('Prints to make', prints, () =>
      table(
        ['Print', 'Plate', '>Qty', 'Material', '>g each', '>Time each'],
        prints.map((line) => [
          line.label,
          plateOf(line, catalog),
          String(line.need),
          line.material ?? '',
          formatNumber(line.gramsEach),
          line.minutesEach === undefined ? '' : formatMinutes(line.minutesEach),
        ]),
      ),
    ),
    markdownSection('Hardware to buy', hardware, () =>
      table(
        ['Part', '>Need', '>Buy', 'Category'],
        hardware.map((line) => [
          hardwareLabel(line),
          withUnit(line.need, line),
          withUnit(line.buy, line),
          line.category ?? '',
        ]),
      ),
    ),
    markdownSection('Equipment', devices, () =>
      table(
        ['Device', '>Qty'],
        devices.map((line) => [line.label, String(line.need)]),
      ),
    ),
    [
      '## Totals',
      '',
      `- Filament to print: ${gramsSummary(totals.needGramsByMaterial)}`,
      `- Print time: ${formatMinutes(totals.needMinutes)}`,
      ...costLine(totals.cost, currency),
    ].join('\n'),
  ]
}

function fullMarkdown(result: BomResult, catalog: CatalogLookup, currency: string): string[] {
  const byKind = (kind: BomLine['kind']): BomLine[] =>
    result.lines.filter((line) => line.kind === kind)
  const prints = byKind('print')
  const hardware = byKind('hardware')
  const devices = byKind('device')
  const { totals } = result
  return [
    markdownSection('Prints', prints, () =>
      table(
        ['Print', 'Plate', '>In plan', '>In rack', '>To make', '>Surplus', 'Material', '>g each'],
        prints.map((line) => [
          line.label,
          plateOf(line, catalog),
          String(line.target),
          String(line.asBuilt),
          String(line.need),
          String(line.surplus),
          line.material ?? '',
          formatNumber(line.gramsEach),
        ]),
      ),
    ),
    markdownSection('Hardware', hardware, () =>
      table(
        ['Part', '>In plan', '>In rack', '>Install', '>Spare', '>Need', '>Buy', '>Surplus'],
        hardware.map((line) => [
          hardwareLabel(line),
          ...[line.target, line.asBuilt, line.install, line.spare, line.need, line.buy].map(
            (value) => withUnit(value, line),
          ),
          withUnit(line.surplus, line),
        ]),
      ),
    ),
    markdownSection('Equipment', devices, () =>
      table(
        ['Device', '>In plan', '>In rack', '>To get', 'Note'],
        devices.map((line) => [
          line.label,
          String(line.target),
          String(line.asBuilt),
          String(line.need),
          line.included ? 'ships with its device' : '',
        ]),
      ),
    ),
    [
      '## Totals',
      '',
      `- Filament, whole plan: ${gramsSummary(totals.printsGramsByMaterial)}`,
      `- Print time, whole plan: ${formatMinutes(totals.printMinutes)}`,
      `- Filament still to print: ${gramsSummary(totals.needGramsByMaterial)}`,
      `- Print time still to go: ${formatMinutes(totals.needMinutes)}`,
      ...costLine(totals.cost, currency),
    ].join('\n'),
  ]
}

export interface MarkdownContext {
  plan: Plan
  catalog: CatalogLookup
  revision: string
  options: BomCliOptions
  /** ISO 4217 code of `totals.cost` (settings.currency). */
  currency: string
}

export function renderMarkdown(result: BomResult, ctx: MarkdownContext): string {
  const { plan, catalog, revision, options, currency } = ctx
  const title = options.full ? 'Bill of materials' : 'Shopping list'
  const spares = options.spares ? 'default spares' : 'no spares'
  const body = options.full
    ? fullMarkdown(result, catalog, currency)
    : shoppingMarkdown(result, catalog, currency)
  const warnings =
    result.warnings.length === 0
      ? []
      : [['## Warnings', '', ...result.warnings.map((warning) => `- ${warning}`)].join('\n')]
  const header = [
    `# ${title}: ${plan.name}`,
    '',
    `${stackSummary(plan, catalog)}.`,
    `Catalog revision ${revision}, ${spares}, empty inventory.`,
  ].join('\n')
  return `${[header, ...body, ...warnings].join('\n\n')}\n`
}

/** The shopping list as stable JSON for golden fixtures: quantities, no prose. */
export function shoppingJson(plan: Plan, result: BomResult): unknown {
  return {
    plan: { id: plan.id, name: plan.name },
    lines: shoppingLines(result).map((line) => ({
      key: line.key,
      kind: line.kind,
      refId: line.refId,
      label: line.label,
      unit: line.unit,
      ...(line.category === undefined ? {} : { category: line.category }),
      ...(line.cutLengthMm === undefined ? {} : { cutLengthMm: line.cutLengthMm }),
      target: line.target,
      asBuilt: line.asBuilt,
      need: line.need,
      buy: line.buy,
      ...(line.material === undefined ? {} : { material: line.material }),
      ...(line.gramsEach === undefined ? {} : { gramsEach: line.gramsEach }),
      ...(line.minutesEach === undefined ? {} : { minutesEach: line.minutesEach }),
    })),
    totals: {
      needGramsByMaterial: result.totals.needGramsByMaterial,
      needMinutes: result.totals.needMinutes,
    },
    warnings: result.warnings,
  }
}

// ---------------------------------------------------------------------------------------------
// CLI

function readPlan(path: string): Plan {
  const data: unknown = JSON.parse(stripBom(readFileSync(path, 'utf8')))
  return migratePlan(data).plan
}

function describeError(error: unknown): string {
  if (error instanceof PlanInvalidError && error.issues.length > 0) {
    const issues = error.issues.map((issue) => `  ${issue.path}: ${issue.message}`)
    return [error.message, ...issues].join('\n')
  }
  return error instanceof Error ? error.message : String(error)
}

function main(): void {
  const options = parseBomArgs(process.argv.slice(2))
  if ('error' in options) {
    console.error(options.error)
    process.exitCode = 1
    return
  }
  // npm runs scripts from the package root; resolve paths against where the user typed them.
  const cwd = process.env.INIT_CWD ?? process.cwd()
  let plan: Plan
  try {
    plan = readPlan(resolve(cwd, options.planPath))
  } catch (error) {
    console.error(`bom: cannot read ${options.planPath}: ${describeError(error)}`)
    process.exitCode = 1
    return
  }
  const loaded = loadCatalogFromDisk()
  for (const problem of loaded.errors) {
    console.error(`bom: skipped catalog/${problem.path}: ${problem.message}`)
  }
  const catalog = mergeLookups(loaded.lookup, plan.custom)
  const settings = bomSettings(options.spares)
  const result = computeBom(plan, catalog, settings, {})
  const output = options.json
    ? `${JSON.stringify(options.full ? result : shoppingJson(plan, result), null, 2)}\n`
    : renderMarkdown(result, {
        plan,
        catalog,
        revision: loaded.revision,
        options,
        currency: settings.currency,
      })
  if (options.out === undefined) {
    process.stdout.write(output)
  } else {
    writeFileSync(resolve(cwd, options.out), output)
    console.error(`bom: wrote ${options.out}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
