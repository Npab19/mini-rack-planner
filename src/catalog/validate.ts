/**
 * Shared-catalog rules beyond one entry's schema and integrity: references between entries,
 * curation rules (source, verification, facts only), unknown keys and published ids (ids.lock).
 * `npm run validate-catalog` applies them to catalog/**; they are pure so tests and the app can
 * reuse them.
 */
import type { AlignRecord } from '../domain/schema/align'
import type {
  CatalogEntry,
  CatalogLookup,
  Frame,
  HardwareCategory,
  Item,
  Option,
  PrintGroup,
  RecipeLine,
} from '../domain/schema/catalog'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

// ---------------------------------------------------------------------------------------------
// References between entries

const NUT_CATEGORIES: readonly HardwareCategory[] = ['nut', 'cage-nut', 't-nut']

function recipeReferenceProblems(recipe: readonly RecipeLine[], lookup: CatalogLookup): string[] {
  const problems: string[] = []
  for (const line of recipe) {
    if (!('hardware' in line.ref)) continue
    const where = `recipe line "${line.id}"`
    const hardware = lookup.hardware(line.ref.hardware)
    if (hardware === undefined) {
      problems.push(`${where}: unknown hardware "${line.ref.hardware}"`)
    } else if (line.length !== undefined && hardware.unit !== 'mm') {
      problems.push(`${where}: a cut length needs hardware sold by length (unit "mm")`)
    }
  }
  return problems
}

function embedReferenceProblems(prints: readonly PrintGroup[], lookup: CatalogLookup): string[] {
  const problems: string[] = []
  for (const print of prints) {
    for (const embed of print.embeds ?? []) {
      if (lookup.hardware(embed.hardwareId) === undefined) {
        problems.push(`print "${print.id}": embeds unknown hardware "${embed.hardwareId}"`)
      }
    }
  }
  return problems
}

/** "M5" and "m5" or "#10-32" and "10-32" are the same thread. */
function sameThread(a: string, b: string): boolean {
  const normalize = (thread: string): string => thread.trim().replace(/^#/, '').toUpperCase()
  return normalize(a) === normalize(b)
}

function fastenerProblems(frame: Frame, lookup: CatalogLookup): string[] {
  const fastener = frame.equipmentFastener
  const where = 'equipmentFastener'
  const problems: string[] = []
  if (fastener.screwIds.length === 0) problems.push(`${where}.screwIds: list at least one screw`)
  for (const id of fastener.screwIds) {
    const screw = lookup.hardware(id)
    if (screw === undefined) {
      problems.push(`${where}.screwIds: unknown hardware "${id}"`)
      continue
    }
    if (screw.category !== 'screw') {
      problems.push(`${where}.screwIds: "${id}" is not a screw (category "${screw.category}")`)
    }
    const thread = screw.spec.thread
    if (thread !== undefined && !sameThread(thread, fastener.thread)) {
      problems.push(`${where}.screwIds: "${id}" is ${thread} but the frame uses ${fastener.thread}`)
    }
    if (screw.spec.lengthMm === undefined) {
      problems.push(`${where}.screwIds: "${id}" needs spec.lengthMm to pick a long enough screw`)
    }
  }
  if (fastener.nutId === undefined) {
    if (fastener.perHole !== 'screw') {
      problems.push(`${where}.nutId: "${fastener.perHole}" needs the nut's hardware id`)
    }
    return problems
  }
  const nut = lookup.hardware(fastener.nutId)
  if (nut === undefined) {
    problems.push(`${where}.nutId: unknown hardware "${fastener.nutId}"`)
  } else if (!NUT_CATEGORIES.includes(nut.category)) {
    problems.push(`${where}.nutId: "${nut.id}" is not a nut (category "${nut.category}")`)
  }
  return problems
}

function itemReferenceProblems(item: Item, lookup: CatalogLookup): string[] {
  const problems: string[] = []
  for (const slot of item.slots) {
    for (const deviceId of slot.accepts?.deviceIds ?? []) {
      if (lookup.device(deviceId) === undefined) {
        problems.push(`slot "${slot.id}": accepts unknown device "${deviceId}"`)
      }
    }
  }
  for (const frameId of item.compat?.frames ?? []) {
    if (lookup.frame(frameId) === undefined) {
      problems.push(`compat.frames: unknown frame "${frameId}"`)
    }
  }
  return problems
}

/** Hardware, device and frame ids an entry refers to that are missing or of the wrong kind. */
export function crossReferenceProblems(entry: CatalogEntry, lookup: CatalogLookup): string[] {
  switch (entry.kind) {
    case 'frame':
      return [
        ...recipeReferenceProblems(entry.recipe, lookup),
        ...embedReferenceProblems(entry.prints, lookup),
        ...fastenerProblems(entry, lookup),
      ]
    case 'item':
    case 'extra':
      return [
        ...recipeReferenceProblems(entry.recipe, lookup),
        ...embedReferenceProblems(entry.prints, lookup),
        ...itemReferenceProblems(entry, lookup),
      ]
    case 'device':
    case 'hardware':
      return []
  }
}

// ---------------------------------------------------------------------------------------------
// Curation rules

/** Platforms that host designs: entries from them credit the designer and the licence label. */
const DESIGN_PLATFORMS: readonly string[] = ['makerworld', 'printables', 'thingiverse']
const MAKERWORLD_MODEL_URL =
  /^https:\/\/makerworld\.com\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?models\/(\d+)(?:[-/?#]|$)/i
/** Longer text is almost certainly a copied description, which the catalog must not hold. */
export const MAX_TEXT_LENGTH = 400

export interface RuleReport {
  errors: string[]
  warnings: string[]
}

function longTexts(value: unknown, path: string, found: Array<[string, number]>): void {
  if (typeof value === 'string') {
    if (value.length > MAX_TEXT_LENGTH) found.push([path, value.length])
  } else if (Array.isArray(value)) {
    value.forEach((inner, index) => longTexts(inner, `${path}[${index}]`, found))
  } else if (isRecord(value)) {
    for (const [key, inner] of Object.entries(value)) {
      if (key !== 'url') longTexts(inner, path === '' ? key : `${path}.${key}`, found)
    }
  }
}

function sourceRules(entry: CatalogEntry, report: RuleReport): void {
  const source = entry.source
  if (source === undefined) {
    report.errors.push('source: link to the page the facts come from')
    return
  }
  if (DESIGN_PLATFORMS.includes(source.platform)) {
    if (source.designer === undefined) {
      report.warnings.push('source.designer: credit the designer as the page shows them')
    }
    if (source.license === undefined) {
      report.warnings.push('source.license: add the licence label exactly as the page shows it')
    }
  }
  if (source.platform !== 'makerworld') return
  const modelId = MAKERWORLD_MODEL_URL.exec(source.url)?.[1]
  if (modelId === undefined) {
    report.errors.push('source.url: use the model page link, https://makerworld.com/en/models/<id>')
  } else if (source.modelId !== modelId) {
    report.errors.push(`source.modelId: must be "${modelId}", the id in the link`)
  }
}

/**
 * Rules every shared entry follows (the schema leaves some of these optional for private parts):
 * a source link, a verified block with a note when unverified, designer and licence credits for
 * designs, and facts only.
 */
export function curationReport(entry: CatalogEntry): RuleReport {
  const report: RuleReport = { errors: [], warnings: [] }
  sourceRules(entry, report)
  const verified = entry.verified
  if (verified === undefined) {
    report.errors.push('verified: say who checked the facts, when and how')
  } else if (verified.method === 'unverified' && !verified.note) {
    report.errors.push('verified.note: say what still needs checking')
  }
  const found: Array<[string, number]> = []
  longTexts(entry, '', found)
  for (const [path, length] of found) {
    report.errors.push(
      `${path}: ${length} characters; the catalog stores facts and links only (max ${MAX_TEXT_LENGTH})`,
    )
  }
  return report
}

/**
 * Keys of `raw` that the schema dropped while parsing it into `parsed`: unknown (usually
 * misspelt) fields, which would otherwise disappear silently.
 */
export function unknownKeys(raw: unknown, parsed: unknown, path = ''): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    return raw.flatMap((inner, index) => unknownKeys(inner, parsed[index], `${path}[${index}]`))
  }
  if (!isRecord(raw) || !isRecord(parsed)) return []
  return Object.keys(raw).flatMap((key) => {
    const at = path === '' ? key : `${path}.${key}`
    return Object.hasOwn(parsed, key) ? unknownKeys(raw[key], parsed[key], at) : [at]
  })
}

// ---------------------------------------------------------------------------------------------
// Published ids (catalog/ids.lock and catalog/replaced.json)

/**
 * Every id saved user data can refer to: the entry id, and `<entry id>#<kind>:<local id>` for
 * section types (plan sections), options and their choices (plan option values), prints
 * (inventory keys), 3D parts (linked model files, alignments) and slots (placed devices).
 */
export function publishedKeys(entry: CatalogEntry): string[] {
  const local = (kind: string, id: string): string => `${entry.id}#${kind}:${id}`
  const optionKeys = (options: readonly Option[]): string[] =>
    options.flatMap((option) => [
      local('option', option.id),
      ...(option.choices ?? []).map((choice) => local('option', `${option.id}=${choice.id}`)),
    ])
  switch (entry.kind) {
    case 'frame':
      return [
        entry.id,
        ...entry.sectionTypes.map((type) => local('section', type.id)),
        ...optionKeys(entry.options),
        ...entry.prints.map((print) => local('print', print.id)),
        ...(entry.parts3d ?? []).map((part) => local('part', part.id)),
      ]
    case 'item':
    case 'extra':
      return [
        entry.id,
        ...optionKeys(entry.options),
        ...entry.prints.map((print) => local('print', print.id)),
        ...(entry.parts3d ?? []).map((part) => local('part', part.id)),
        ...entry.slots.map((slot) => local('slot', slot.id)),
      ]
    case 'device':
    case 'hardware':
      return [entry.id]
  }
}

/** "entry", or the local kind of a key: "section", "option", "choice", "print", "part", "slot". */
export function publishedKeyKind(key: string): string {
  const hash = key.indexOf('#')
  if (hash === -1) return 'entry'
  const local = key.slice(hash + 1)
  const kind = local.slice(0, local.indexOf(':'))
  return kind === 'option' && local.includes('=') ? 'choice' : kind
}

const IDS_LOCK_HEADER = [
  '# Published catalog ids: never remove or rename one. To retire an id, keep the entry or map the',
  '# id to its replacement in catalog/replaced.json. Updated by `npm run validate-catalog`.',
]

export function parseIdsLock(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

export function formatIdsLock(keys: Iterable<string>): string {
  const sorted = [...new Set(keys)].toSorted(compareStrings)
  return `${[...IDS_LOCK_HEADER, ...sorted].join('\n')}\n`
}

/** catalog/replaced.json: `{ "<retired id>": "<replacement id>" }`, both in ids.lock key format. */
export function parseReplacedMap(data: unknown): {
  map: Record<string, string>
  problems: string[]
} {
  if (!isRecord(data)) return { map: {}, problems: ['must be a JSON object of id -> id'] }
  const map: Record<string, string> = {}
  const problems: string[] = []
  for (const [from, to] of Object.entries(data)) {
    if (typeof to === 'string') map[from] = to
    else problems.push(`"${from}": the replacement must be an id string`)
  }
  return { map, problems }
}

export interface LockProblem {
  file: 'ids.lock' | 'replaced.json'
  message: string
}

export interface LockReport {
  problems: LockProblem[]
  /** Keys in the catalog that ids.lock does not list yet. */
  unlocked: string[]
}

/**
 * A locked key must still be in the catalog, or be mapped in replaced.json to a key that is (of
 * the same kind). Replacements may only retire keys that were published.
 */
export function checkIdsLock(
  locked: readonly string[],
  current: ReadonlySet<string>,
  replaced: Readonly<Record<string, string>>,
): LockReport {
  const problems: LockProblem[] = []
  const lockedSet = new Set(locked)
  for (const key of lockedSet) {
    if (current.has(key) || Object.hasOwn(replaced, key)) continue
    problems.push({
      file: 'ids.lock',
      message: `"${key}" is published but missing from the catalog: restore it, or map it to its replacement in replaced.json`,
    })
  }
  for (const [from, to] of Object.entries(replaced)) {
    const fail = (message: string): void => {
      problems.push({ file: 'replaced.json', message })
    }
    if (!lockedSet.has(from)) fail(`"${from}" was never published (it is not in ids.lock)`)
    if (!current.has(to)) {
      fail(`"${from}" maps to "${to}", which is not in the catalog`)
    } else if (publishedKeyKind(from) !== publishedKeyKind(to)) {
      fail(`"${from}" (${publishedKeyKind(from)}) cannot be replaced by a ${publishedKeyKind(to)}`)
    }
  }
  const unlocked = [...current].filter((key) => !lockedSet.has(key)).toSorted(compareStrings)
  return { problems, unlocked }
}

// ---------------------------------------------------------------------------------------------
// Curated alignment records (catalog/alignments)

export function alignmentProblems(
  record: AlignRecord,
  fileName: string,
  lookup: CatalogLookup,
): string[] {
  const problems: string[] = []
  if (record.id !== fileName) {
    problems.push(`id must match the file name (${fileName}.json)`)
  }
  if (record.provenance.method !== 'curated') {
    problems.push('provenance.method: shared alignments are "curated"')
  }
  const slash = record.catalogPartId.indexOf('/')
  const entryId = record.catalogPartId.slice(0, slash)
  const partId = record.catalogPartId.slice(slash + 1)
  const owner = slash > 0 ? (lookup.frame(entryId) ?? lookup.item(entryId)) : undefined
  if (owner === undefined) {
    problems.push(`catalogPartId: "${record.catalogPartId}" must be <frame or item id>/<part id>`)
  } else if (!(owner.parts3d ?? []).some((part) => part.id === partId)) {
    problems.push(`catalogPartId: "${entryId}" has no 3D part "${partId}"`)
  }
  return problems
}
