/**
 * My parts (the user's library of `custom:` entries): groups, search, one-line facts, and the way
 * to the shared catalog. A part leaves as a catalog entry file (its `custom:` ids made into
 * catalog ids) or through GitHub's catalog submission form, opened in a new tab with the entry
 * filled in when it fits in a link. Nothing is sent from the app itself. Pure.
 */
import { createCatalogSearch, entryName } from '@/catalog/search'
import { crossReferenceProblems, curationReport } from '@/catalog/validate'
import { formatU } from '@/domain/geometry'
import { isOnePieceCustomFrame } from '@/domain/customParts'
import type {
  CatalogEntry,
  CatalogLookup,
  Frame,
  Item,
  PrintGroup,
  RecipeLine,
} from '@/domain/schema/catalog'
import { CUSTOM_ID_PREFIX, isCustomId } from '@/domain/schema/common'

// ---------------------------------------------------------------------------------------------
// Groups and facts

export type LibraryGroupId = 'frames' | 'items' | 'devices' | 'hardware'

export interface LibraryGroup {
  id: LibraryGroupId
  title: string
  entries: CatalogEntry[]
}

const GROUPS: ReadonlyArray<{ id: LibraryGroupId; title: string }> = [
  { id: 'devices', title: 'Devices' },
  { id: 'items', title: 'Mounts, panels and shelves' },
  { id: 'frames', title: 'Rack frames' },
  { id: 'hardware', title: 'Hardware' },
]

function groupOf(entry: CatalogEntry): LibraryGroupId {
  switch (entry.kind) {
    case 'frame':
      return 'frames'
    case 'item':
    case 'extra':
      return 'items'
    case 'device':
      return 'devices'
    case 'hardware':
      return 'hardware'
  }
}

/** What to call a part: brand and model for devices, else its name. */
export const partName = entryName

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

/** Non-empty groups in a fixed order (devices, mounts, frames, hardware), each by name. */
export function groupLibrary(entries: readonly CatalogEntry[]): LibraryGroup[] {
  return GROUPS.map(({ id, title }) => ({
    id,
    title,
    entries: entries
      .filter((entry) => groupOf(entry) === id)
      .toSorted((a, b) => collator.compare(partName(a), partName(b))),
  })).filter((group) => group.entries.length > 0)
}

/** The entries matching `query` (every word starts a word of the name, category or id). */
export function filterLibrary(entries: readonly CatalogEntry[], query: string): CatalogEntry[] {
  if (query.trim() === '') return [...entries]
  return createCatalogSearch(entries)(query).map((hit) => hit.entry)
}

/** Parts that the plain-language editors can change (devices, items, frames). */
export function canEditPart(entry: CatalogEntry): boolean {
  return entry.kind === 'device' || entry.kind === 'item' || entry.kind === 'frame'
}

function mm(value: number): string {
  return `${Math.round(value * 10) / 10}`
}

const DEVICE_KINDS: Readonly<Record<string, string>> = {
  'mini-pc': 'Mini PC',
  sbc: 'Single-board computer',
  nas: 'NAS',
  drive: 'Drive',
  switch: 'Switch',
  router: 'Router',
  gateway: 'Gateway',
  pdu: 'Power strip',
  ups: 'UPS',
  'power-brick': 'Power supply',
  kvm: 'KVM',
  'patch-panel': 'Patch panel',
  other: 'Other device',
}

const PER_HOLE_TEXT: Readonly<Record<Frame['equipmentFastener']['perHole'], string>> = {
  screw: 'screws',
  'screw+nut': 'screws and nuts',
  'screw+cage-nut': 'screws and cage nuts',
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).replaceAll('-', ' ')
}

function holdsText(item: Item): string | undefined {
  const [slot] = item.slots
  if (slot === undefined) return undefined
  const size = `${mm(slot.maxW)} × ${mm(slot.maxD)}${slot.maxH === undefined ? '' : ` × ${mm(slot.maxH)}`} mm`
  const more = item.slots.length > 1 ? ` (+${item.slots.length - 1} more)` : ''
  return slot.kind === 'fixed' ? `holds a device up to ${size}${more}` : `shelf ${size}${more}`
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/** One line of facts: "1U · Mount · holds a device up to 180 × 184 × 36 mm · 2 prints". */
export function partFacts(entry: CatalogEntry): string {
  switch (entry.kind) {
    case 'device': {
      const facts = [
        `${mm(entry.dims.w)} × ${mm(entry.dims.d)} × ${mm(entry.dims.h)} mm`,
        DEVICE_KINDS[entry.category] ?? capitalized(entry.category),
      ]
      if (entry.rackmount !== undefined) {
        facts.push(`${formatU(entry.rackmount.heightSixths)} rack ears`)
      }
      return facts.join(' · ')
    }
    case 'item':
    case 'extra': {
      const facts = [
        entry.kind === 'extra' ? 'Accessory' : formatU(entry.heightSixths),
        capitalized(entry.category),
      ]
      const holds = holdsText(entry)
      if (holds !== undefined) facts.push(holds)
      if (entry.prints.length > 0) facts.push(count(entry.prints.length, 'print'))
      return facts.join(' · ')
    }
    case 'frame': {
      const height = isOnePieceCustomFrame(entry)
        ? `${entry.stack.maxU}U`
        : `${entry.stack.minU}U to ${entry.stack.maxU}U`
      return [
        height,
        `${mm(entry.standard.innerWidthMm)} mm between the rails`,
        `${mm(entry.standard.depthMm)} mm deep`,
        `${entry.equipmentFastener.thread} ${PER_HOLE_TEXT[entry.equipmentFastener.perHole]}`,
      ].join(' · ')
    }
    case 'hardware':
      return [capitalized(entry.category), entry.spec.thread].filter(Boolean).join(' · ')
  }
}

// ---------------------------------------------------------------------------------------------
// To the shared catalog

export const CATALOG_REPO_URL = 'https://github.com/Npab19/mini-rack-planner'
export const SUBMISSION_TEMPLATE = 'catalog-submission.yml'
/** Longer submission links get cut off or refused, so the entry is attached as a file instead. */
export const MAX_SUBMISSION_URL_LENGTH = 6000

/** The id a part gets in the shared catalog: its `custom:` id without the prefix. */
export function catalogId(id: string): string {
  return isCustomId(id) ? id.slice(CUSTOM_ID_PREFIX.length) : id
}

export interface SharedEntry {
  /** The entry with catalog ids. */
  entry: CatalogEntry
  /** Other parts of yours it refers to (custom hardware, frames…): share those too. */
  ownRefs: string[]
}

/** The part as a shared-catalog entry: its own id and the ids it refers to lose `custom:`. */
export function sharedCatalogEntry(part: CatalogEntry): SharedEntry {
  const refs = new Set<string>()
  const ref = (id: string): string => {
    if (isCustomId(id) && id !== part.id) refs.add(id)
    return catalogId(id)
  }
  const recipe = (lines: readonly RecipeLine[]): RecipeLine[] =>
    lines.map((line) =>
      'hardware' in line.ref ? { ...line, ref: { hardware: ref(line.ref.hardware) } } : line,
    )
  const prints = (groups: readonly PrintGroup[]): PrintGroup[] =>
    groups.map((group) =>
      group.embeds === undefined
        ? group
        : {
            ...group,
            embeds: group.embeds.map((embed) => ({ ...embed, hardwareId: ref(embed.hardwareId) })),
          },
    )
  let entry: CatalogEntry
  switch (part.kind) {
    case 'frame': {
      const fastener = part.equipmentFastener
      entry = {
        ...part,
        id: catalogId(part.id),
        recipe: recipe(part.recipe),
        prints: prints(part.prints),
        equipmentFastener: {
          ...fastener,
          screwIds: fastener.screwIds.map(ref),
          ...(fastener.nutId === undefined ? {} : { nutId: ref(fastener.nutId) }),
        },
      }
      break
    }
    case 'item':
    case 'extra':
      entry = {
        ...part,
        id: catalogId(part.id),
        recipe: recipe(part.recipe),
        prints: prints(part.prints),
        slots: part.slots.map((slot) =>
          slot.accepts?.deviceIds === undefined
            ? slot
            : { ...slot, accepts: { ...slot.accepts, deviceIds: slot.accepts.deviceIds.map(ref) } },
        ),
        ...(part.compat?.frames === undefined
          ? {}
          : { compat: { ...part.compat, frames: part.compat.frames.map(ref) } }),
      }
      break
    case 'device':
    case 'hardware':
      entry = { ...part, id: catalogId(part.id) }
      break
  }
  return { entry, ownRefs: [...refs] }
}

/** Defaults the catalog files leave out, so a submission reads like one. */
function withoutDefaults(entry: CatalogEntry): Record<string, unknown> {
  const tidy: Record<string, unknown> = { ...entry }
  for (const key of ['options', 'prints', 'recipe', 'slots']) {
    const value = tidy[key]
    if (Array.isArray(value) && value.length === 0) delete tidy[key]
  }
  if (entry.kind === 'item' || entry.kind === 'extra') {
    if (entry.bay === 'full') delete tidy.bay
    if (entry.faces.length === 1 && entry.faces[0] === 'front') delete tidy.faces
    if (entry.mount.rear === 0) {
      const mount: Record<string, unknown> = { ...entry.mount }
      delete mount.rear
      tidy.mount = mount
    }
  }
  return tidy
}

/** The catalog entry file's text (two-space JSON, trailing newline). */
export function catalogEntryJson(part: CatalogEntry, compact = false): string {
  const tidy = withoutDefaults(sharedCatalogEntry(part).entry)
  return compact ? JSON.stringify(tidy) : `${JSON.stringify(tidy, null, 2)}\n`
}

export function catalogFileName(part: CatalogEntry): string {
  return `${catalogId(part.id)}.json`
}

const KIND_OPTIONS: Readonly<Record<CatalogEntry['kind'], string>> = {
  frame: 'Frame (a rack system, e.g. KWS Rack v2)',
  item: 'Item (a printed mount, shelf, panel or accessory)',
  extra: 'Item (a printed mount, shelf, panel or accessory)',
  device: 'Device (equipment such as a mini PC, switch or drive)',
  hardware: 'Hardware (screw, insert, nut, magnet…)',
}

/**
 * GitHub's catalog submission form for the part, its fields filled in from the entry (the form's
 * field ids: kind, link, designer, licence, entry). Without `json` the entry field stays empty.
 */
export function submissionUrl(part: CatalogEntry, json?: string): string {
  const fields: Array<[string, string]> = [
    ['template', SUBMISSION_TEMPLATE],
    ['title', `catalog: ${partName(part)}`],
    ['kind', KIND_OPTIONS[part.kind]],
  ]
  const source = part.source
  if (source !== undefined) {
    fields.push(['link', source.url])
    if (source.designer !== undefined) fields.push(['designer', source.designer])
    if (source.license !== undefined) fields.push(['licence', source.license])
  }
  if (json !== undefined) fields.push(['entry', json])
  const query = fields.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
  return `${CATALOG_REPO_URL}/issues/new?${query}`
}

export interface ShareLink {
  url: string
  /** The entry is in the link; otherwise attach the downloaded file to the form. */
  prefilled: boolean
}

/** The submission link with the entry filled in when the link stays short enough. */
export function shareLink(part: CatalogEntry): ShareLink {
  for (const compact of [false, true]) {
    const url = submissionUrl(part, catalogEntryJson(part, compact).trim())
    if (url.length <= MAX_SUBMISSION_URL_LENGTH) return { url, prefilled: true }
  }
  return { url: submissionUrl(part), prefilled: false }
}

export interface ShareReport {
  /** What reviewers will ask for before the part can be added. */
  needed: string[]
  /** Good to add. */
  suggested: string[]
  /** Other parts of yours it uses (share them too). */
  ownRefs: string[]
}

function plainProblem(problem: string): string {
  if (problem.startsWith('source:')) {
    return 'A link to the page its facts come from (edit the part to add one).'
  }
  if (problem.startsWith('source.designer:')) return 'The designer’s name, as the page shows it.'
  if (problem.startsWith('source.license:')) return 'The licence, exactly as the page shows it.'
  if (problem.startsWith('verified.note:')) return 'A note on what still needs checking.'
  return problem
}

/**
 * What the shared catalog's checks (validate-catalog) would say about the part: curation rules
 * and references to entries it does not have, in plain words.
 */
export function shareReport(part: CatalogEntry, catalog: CatalogLookup): ShareReport {
  const shared = sharedCatalogEntry(part)
  const curation = curationReport(shared.entry)
  const references = crossReferenceProblems(shared.entry, catalog).filter(
    // Your own parts it refers to are listed separately.
    (problem) => !shared.ownRefs.some((id) => problem.includes(`"${catalogId(id)}"`)),
  )
  return {
    needed: [...curation.errors.map(plainProblem), ...references],
    suggested: curation.warnings.map(plainProblem),
    ownRefs: shared.ownRefs,
  }
}
