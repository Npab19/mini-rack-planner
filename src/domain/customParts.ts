/**
 * The user's own catalog entries (M3b): plain-language inputs become valid `custom:` devices,
 * mounts/panels/shelves and frames, and plans embed copies of the custom entries they use, so an
 * exported plan or a share link stays complete without the library.
 *
 * - Builders (`newCustomDevice`, `newCustomItem`, `newCustomFrame`, `customMountForDevice`) return
 *   entries that pass the catalog schemas and `checkEntryIntegrity`, or throw `CustomPartError`
 *   with readable problems. `today` (YYYY-MM-DD: the UI passes the user's local date) stamps
 *   `verified.date`; without it the UTC date is used. Facts typed by hand are `unverified` unless
 *   the input says how they were checked.
 * - Editing: `customDeviceInputOf` / `customItemInputOf` / `customFrameInputOf` turn an entry back
 *   into the plain-language input; `editCustomDevice` / `editCustomItem` / `editCustomFrame`
 *   apply an edited input to the stored entry, keeping its id and every detail the plain form
 *   does not show (`customAdvancedDetails` names those details).
 * - Links: `parseSourceLink` reads a pasted link: MakerWorld model and profile ids and a name from
 *   the slug; any other http(s) link is kept as it is. Nothing is ever fetched.
 * - Plans: `embedCustomEntries`, `customIdsUsed` and `embedUsedCustomEntries`.
 *
 * Pure: inputs are never mutated.
 */
import {
  EIA_EAR_SPACING_MM,
  EIA_HOLE_OFFSETS_PER_U_MM,
  NOMINAL_OPENING_MM,
  PANEL_WIDTH_MM,
  sixthsToMm,
} from './geometry'
import { KEBAB_PATTERN } from './ids'
import { SHELF_HEADROOM_MM } from './placement'
import {
  DeviceCategorySchema,
  defaultMountHoles,
  deviceName,
  DeviceSchema,
  FrameSchema,
  ItemSchema,
  type CatalogEntry,
  type Device,
  type DeviceCategory,
  type DevicePower,
  type Frame,
  type Item,
  type Mount,
  type PerHole,
  type PrintGroup,
  type RecipeLine,
  type RenderStyle,
  type Slot,
} from './schema/catalog'
import {
  CUSTOM_ID_PREFIX,
  isCustomId,
  type Face,
  type Platform,
  type Source,
  type Thread,
  type Verified,
  type VerifyMethod,
} from './schema/common'
import { checkEntryIntegrity } from './schema/integrity'
import type { Plan, PlanCustom } from './schema/plan'

// ---------------------------------------------------------------------------------------------
// Errors and shared bits

/** A custom part that cannot be built: `problems` say what is wrong, one line each. */
export class CustomPartError extends Error {
  override name = 'CustomPartError'
  readonly problems: readonly string[]

  constructor(message: string, problems: readonly string[] = []) {
    super(message)
    this.problems = problems
  }
}

/** `verified.by` of the parts the user enters. */
export const CUSTOM_VERIFIED_BY = 'you'
/** `verified.note` of a hand-entered part nobody has checked yet (the catalog asks for one). */
export const UNVERIFIED_NOTE = 'Entered by hand: sizes, holes and prints are not checked yet.'

/** Fields every plain-language input may carry. */
export interface CustomEntryCommon {
  /** YYYY-MM-DD for `verified.date`: the UI passes the user's local date. Default: UTC today. */
  today?: string
  /** How the facts were checked. Default: `unverified`. */
  verifiedMethod?: VerifyMethod
}

const MAX_ID_LENGTH = 100
const MAX_KEY_LENGTH = 100
const KEY = new RegExp(`^${KEBAB_PATTERN}$`)

function utcToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function trimmed(text: string | undefined): string | undefined {
  const value = text?.trim()
  return value === undefined || value === '' ? undefined : value
}

function verifiedFor(common: CustomEntryCommon, previous?: Verified): Verified {
  const method = common.verifiedMethod ?? 'unverified'
  // An edit keeps the note while the method stays; a hand-entered part says what is unchecked.
  const note =
    previous !== undefined && previous.method === method
      ? previous.note
      : method === 'unverified'
        ? UNVERIFIED_NOTE
        : undefined
  return {
    by: CUSTOM_VERIFIED_BY,
    date: common.today ?? utcToday(),
    method,
    ...(note === undefined ? {} : { note }),
  }
}

interface ParseIssue {
  path: readonly PropertyKey[]
  message: string
}

type ParseResult<T> =
  { success: true; data: T } | { success: false; error: { issues: readonly ParseIssue[] } }

/** The parsed entry, or a `CustomPartError` with the schema's and the integrity check's problems. */
function checked<T extends CatalogEntry>(result: ParseResult<T>, what: string): T {
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const path = issue.path.map(String).join('.')
      return path === '' ? issue.message : `${path}: ${issue.message}`
    })
    throw new CustomPartError(`This ${what} is not valid.`, problems)
  }
  const problems = checkEntryIntegrity(result.data)
  if (problems.length > 0) throw new CustomPartError(`This ${what} is not consistent.`, problems)
  return result.data
}

/** Stable JSON (sorted keys, undefined fields left out) to compare entries by content. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonical(record[key])]),
    )
  }
  return value
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

// ---------------------------------------------------------------------------------------------
// Ids

const SPECIAL_CHARACTERS: ReadonlyArray<[string, string]> = [
  ['½', ' half '],
  ['⅓', ' third '],
  ['⅔', ' two thirds '],
  ['¼', ' quarter '],
  ['¾', ' three quarters '],
  ['⅙', ' sixth '],
  ['⅚', ' five sixths '],
  ['×', 'x'],
  ['ß', 'ss'],
  ['æ', 'ae'],
  ['œ', 'oe'],
  ['ø', 'o'],
  ['ł', 'l'],
  ['đ', 'd'],
]

/** Kebab-case words of `text`: "Lenovo Tiny 1½U" -> "lenovo-tiny-1-half-u"; "" when none. */
export function slugify(text: string): string {
  let result = text.toLowerCase()
  for (const [from, to] of SPECIAL_CHARACTERS) result = result.replaceAll(from, to)
  return result
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** At most `length` characters of a slug, without a hyphen left at the end. */
function cut(slug: string, length: number): string {
  return slug.slice(0, length).replace(/-+$/, '')
}

/** A unique `custom:<slug>` id for `name`, avoiding `taken` ids (adds -2, -3, ...). */
export function customId(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name) || 'part'
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : `-${n}`
    const room = MAX_ID_LENGTH - CUSTOM_ID_PREFIX.length - suffix.length
    const id = `${CUSTOM_ID_PREFIX}${cut(base, room) || 'part'}${suffix}`
    if (!taken.has(id)) return id
  }
}

/** A local key (print, recipe line) from `text`, unique within `used` (which it joins). */
function uniqueKey(text: string, used: Set<string>, fallback: string): string {
  const base = cut(slugify(text), MAX_KEY_LENGTH - 4) || fallback
  let key = base
  for (let n = 2; used.has(key); n++) key = `${base}-${n}`
  used.add(key)
  return key
}

/** `wanted` when it is a free, valid key; else a new key from `text` (either joins `used`). */
function keepOrMakeKey(
  wanted: string | undefined,
  text: string,
  used: Set<string>,
  fallback: string,
): string {
  if (
    wanted !== undefined &&
    wanted.length <= MAX_KEY_LENGTH &&
    KEY.test(wanted) &&
    !used.has(wanted)
  ) {
    used.add(wanted)
    return wanted
  }
  return uniqueKey(wanted ?? text, used, fallback)
}

// ---------------------------------------------------------------------------------------------
// Links (never fetched)

/** What a pasted link says about its page. */
export interface SourceLink {
  /** The link as stored: an absolute http(s) URL (`https://` added when it had no scheme). */
  url: string
  platform: Platform
  /** MakerWorld model id, from `/models/<id>-<slug>`. */
  modelId?: string
  /** MakerWorld print profile id, from `#profileId-<id>`. */
  profileId?: string
  /** A readable name from a MakerWorld slug: "Lenovo tiny mini pc mount". */
  name?: string
}

const MAX_URL_LENGTH = 2048
const MAKERWORLD_MODEL_PATH =
  /^\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?models\/(\d+)(?:-([^/]*))?(?:\/|$)/i
const MAX_NAME_LENGTH = 200

function platformOf(host: string): Platform {
  const bare = host.replace(/^www\./, '')
  const on = (domain: string): boolean => bare === domain || bare.endsWith(`.${domain}`)
  if (bare === 'makerworld.com' || bare === 'makerworld.com.cn') return 'makerworld'
  if (on('printables.com')) return 'printables'
  if (on('thingiverse.com')) return 'thingiverse'
  if (on('github.com') || bare.endsWith('.github.io')) return 'github'
  return 'other'
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** "lenovo-tiny-mini-pc-mount" -> "Lenovo tiny mini pc mount". */
function nameFromSlug(slug: string): string | undefined {
  const words = decoded(slug)
    .replace(/[-_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
  return words === '' ? undefined : words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Reads a pasted link. MakerWorld links (`makerworld.com/<lang>/models/<id>-<slug>#profileId-<pid>`)
 * give the model id, the print profile id and a name from the slug; Printables, Thingiverse and
 * any other http(s) link is kept as it is (only its platform is recognised). Undefined for empty
 * text, anything that is not an http(s) web address, or links over 2048 characters.
 */
export function parseSourceLink(text: string): SourceLink | undefined {
  const input = text.trim()
  if (input === '') return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  // A web page needs a domain: "lenovo" alone is a name typed in the wrong field.
  if (!url.hostname.includes('.') || url.href.length > MAX_URL_LENGTH) return undefined
  const platform = platformOf(url.hostname.toLowerCase())
  const link: SourceLink = { url: url.href, platform }
  if (platform !== 'makerworld') return link
  const model = MAKERWORLD_MODEL_PATH.exec(url.pathname)
  if (model === null) return link
  const [, modelId, slug] = model
  if (modelId !== undefined) link.modelId = modelId
  const profileId =
    /profileId-(\d+)/i.exec(url.hash)?.[1] ??
    /^\d+$/.exec(url.searchParams.get('profileId') ?? '')?.[0]
  if (profileId !== undefined) link.profileId = profileId
  const name = slug === undefined ? undefined : nameFromSlug(slug)
  if (name !== undefined) link.name = name
  return link
}

interface Credits {
  designer?: string
  license?: string
}

/** The entry's `source` for a link (or none without one); unknown hosts get `fallback`. */
function sourceFor(
  url: string | undefined,
  credits: Credits,
  fallback: Platform,
): Source | undefined {
  const text = trimmed(url)
  if (text === undefined) return undefined
  const link = parseSourceLink(text)
  if (link === undefined) {
    throw new CustomPartError('The link is not a web address.', [
      `source.url: "${text}" is not an http(s) link`,
    ])
  }
  const designer = trimmed(credits.designer)
  const license = trimmed(credits.license)
  return {
    platform: link.platform === 'other' ? fallback : link.platform,
    url: link.url,
    ...(link.modelId === undefined ? {} : { modelId: link.modelId }),
    ...(link.profileId === undefined ? {} : { profileId: link.profileId }),
    ...(designer === undefined ? {} : { designer }),
    ...(license === undefined ? {} : { license }),
  }
}

/**
 * The source after an edit: a new link gives the new source; the same link keeps the stored one
 * (ids, credits), with the form's credits when the form shows them (`credits`, items only).
 */
function editedSource(
  previous: Source | undefined,
  next: Source | undefined,
  credits?: Credits,
): Source | undefined {
  if (previous === undefined || next === undefined || previous.url !== next.url) return next
  if (credits === undefined) return previous
  const source: Source = { ...previous }
  const designer = trimmed(credits.designer)
  const license = trimmed(credits.license)
  if (designer === undefined) delete source.designer
  else source.designer = designer
  if (license === undefined) delete source.license
  else source.license = license
  return source
}

// ---------------------------------------------------------------------------------------------
// Devices

/** How a device is powered, in plain words: `brick` is an included external power supply. */
export type CustomPowerChoice = 'ac' | 'brick' | 'usb-c' | 'poe' | 'dc' | 'none'

/** Plain-language device input (mm, W, U as numbers); the result passes `DeviceSchema`. */
export interface CustomDeviceInput extends CustomEntryCommon {
  brand: string
  model: string
  category: Device['category']
  widthMm: number
  depthMm: number
  heightMm: number
  weightG?: number
  typicalW?: number
  maxW?: number
  /** How it is powered; `brick` adds an included external power supply. */
  power?: CustomPowerChoice
  /** With `power: 'brick'`: the brick plugs straight into the wall (it blocks two outlets). */
  brickPlugsIntoWall?: boolean
  /** Ear-mounted 10" gear: its rack height in sixths. */
  rackmountSixths?: number
  sourceUrl?: string
}

/**
 * The `device.power` for a choice. Watts are kept with any choice but `none`; without a choice
 * there is no power entry (and the watts are ignored).
 */
function powerFor(input: CustomDeviceInput): DevicePower | undefined {
  if (input.power === undefined) return undefined
  if (input.power === 'none') return { input: { kind: 'none' } }
  const watts = {
    ...(input.typicalW === undefined ? {} : { typW: input.typicalW }),
    ...(input.maxW === undefined ? {} : { maxW: input.maxW }),
  }
  switch (input.power) {
    case 'ac':
      return { ...watts, input: { kind: 'ac' } }
    case 'brick':
      return {
        ...watts,
        input: {
          kind: 'dc',
          brick: { included: true, ...(input.brickPlugsIntoWall === true ? { plug: 'wall' } : {}) },
        },
      }
    case 'usb-c':
      return { ...watts, input: { kind: 'usb-c-pd' } }
    case 'poe':
      return { ...watts, input: { kind: 'poe' } }
    case 'dc':
      return { ...watts, input: { kind: 'dc' } }
  }
}

/** The plain-language choice for a device's power. */
export function powerChoiceOf(power: DevicePower): CustomPowerChoice {
  if (power.input.brick !== undefined) return 'brick'
  switch (power.input.kind) {
    case 'ac':
      return 'ac'
    case 'usb-c-pd':
      return 'usb-c'
    case 'poe':
      return 'poe'
    case 'dc':
      return 'dc'
    case 'none':
      return 'none'
  }
}

export function newCustomDevice(input: CustomDeviceInput, taken: ReadonlySet<string>): Device {
  const brand = input.brand.trim()
  const model = input.model.trim()
  const power = powerFor(input)
  const source = sourceFor(input.sourceUrl, {}, 'vendor')
  return checked(
    DeviceSchema.safeParse({
      kind: 'device',
      id: customId(`${brand} ${model}`, taken),
      brand,
      model,
      category: input.category,
      dims: { w: input.widthMm, d: input.depthMm, h: input.heightMm },
      ...(input.weightG === undefined ? {} : { weightG: input.weightG }),
      ...(power === undefined ? {} : { power }),
      ...(input.rackmountSixths === undefined
        ? {}
        : {
            rackmount: {
              heightSixths: input.rackmountSixths,
              face: 'front',
              depthMm: input.depthMm,
            },
          }),
      ...(source === undefined ? {} : { source }),
      verified: verifiedFor(input),
    }),
    'device',
  )
}

/** The plain-language input that shows `device` in the device form. */
export function customDeviceInputOf(device: Device): CustomDeviceInput {
  const { power } = device
  return {
    brand: device.brand,
    model: device.model,
    category: device.category,
    widthMm: device.dims.w,
    depthMm: device.dims.d,
    heightMm: device.dims.h,
    ...(device.weightG === undefined ? {} : { weightG: device.weightG }),
    ...(power?.typW === undefined ? {} : { typicalW: power.typW }),
    ...(power?.maxW === undefined ? {} : { maxW: power.maxW }),
    ...(power === undefined ? {} : { power: powerChoiceOf(power) }),
    ...(power?.input.brick?.plug === 'wall' ? { brickPlugsIntoWall: true } : {}),
    ...(device.rackmount === undefined ? {} : { rackmountSixths: device.rackmount.heightSixths }),
    ...(device.source === undefined ? {} : { sourceUrl: device.source.url }),
    verifiedMethod: device.verified.method,
  }
}

/** The new power; for the same choice, details the form does not show are kept. */
function mergePower(
  previous: DevicePower | undefined,
  next: DevicePower | undefined,
): DevicePower | undefined {
  if (previous === undefined || next === undefined) return next
  if (powerChoiceOf(previous) !== powerChoiceOf(next)) {
    // What the device hands out (outlets, PoE ports) does not depend on how it is powered.
    return previous.outputs === undefined ? next : { ...next, outputs: previous.outputs }
  }
  const merged: DevicePower = { ...previous, input: { ...previous.input } }
  if (next.typW === undefined) delete merged.typW
  else merged.typW = next.typW
  if (next.maxW === undefined) delete merged.maxW
  else merged.maxW = next.maxW
  const brick = merged.input.brick
  if (brick !== undefined) {
    const plug = next.input.brick?.plug
    const updated = { ...brick }
    if (plug === 'wall') updated.plug = 'wall'
    else if (brick.plug === 'wall') delete updated.plug
    merged.input.brick = updated
  }
  return merged
}

/** `existing` with the device form's input applied: same id, details the form hides are kept. */
export function editCustomDevice(existing: Device, input: CustomDeviceInput): Device {
  const made = newCustomDevice(input, new Set())
  const next: Device = {
    ...existing,
    brand: made.brand,
    model: made.model,
    category: made.category,
    dims: made.dims,
    verified: verifiedFor(input, existing.verified),
  }
  if (made.weightG === undefined) delete next.weightG
  else next.weightG = made.weightG
  const power = mergePower(existing.power, made.power)
  if (power === undefined) delete next.power
  else next.power = power
  if (made.rackmount === undefined) delete next.rackmount
  else next.rackmount = { ...made.rackmount, face: existing.rackmount?.face ?? 'front' }
  const source = editedSource(existing.source, made.source)
  if (source === undefined) delete next.source
  else next.source = source
  return checked(DeviceSchema.safeParse(next), 'device')
}

// ---------------------------------------------------------------------------------------------
// Items: mounts, panels and shelves

/** One printed plate of a part, as the model page lists it. */
export interface CustomPrintRow {
  /** The print's id when an existing part is edited (keeps inventory keys stable). */
  id?: string
  plate: string
  count: number
  gramsPerPrint?: number
  minutesPerPrint?: number
  material?: string
}

export interface CustomHardwareRow {
  hardwareId: string
  count: number
}

/** What a mount, panel or shelf holds. */
export type CustomHolds =
  | { kind: 'nothing' }
  | { kind: 'device'; maxW: number; maxD: number; maxH: number; categories?: string[] }
  | { kind: 'shelf'; maxW: number; maxD: number; maxH?: number }

/** Plain-language mount/panel/shelf input; the result passes `ItemSchema`. */
export interface CustomItemInput extends CustomEntryCommon {
  name: string
  category: string
  heightSixths: number
  depthMm: number
  faces?: Array<'front' | 'rear'>
  /** What it holds: none (blank/vent), one fixed device slot, or a shelf area. */
  holds: CustomHolds
  render?: Item['render']
  /** Rows the user typed from the model page: printed plates and hardware. */
  prints?: CustomPrintRow[]
  hardware?: CustomHardwareRow[]
  sourceUrl?: string
  designer?: string
  license?: string
}

/** Slot ids of the parts built here. */
export const DEVICE_SLOT_ID = 'device'
export const SHELF_SLOT_ID = 'shelf'
/** How high a slot's floor sits above the item's bottom edge, at most. */
const SLOT_FLOOR_MM = 3

/**
 * Where a slot sits: centred in the nominal 222.25 mm opening, its floor up to 3 mm above the
 * bottom edge but low enough that its tallest device (plus headroom) stays within the item.
 */
function slotLayout(maxW: number, maxH: number | undefined, heightSixths: number): Slot['layout'] {
  const xMm = round2(Math.max(0, (NOMINAL_OPENING_MM - maxW) / 2))
  const room =
    maxH === undefined ? SLOT_FLOOR_MM : sixthsToMm(heightSixths) - maxH - SHELF_HEADROOM_MM
  return { xMm, yMm: round2(Math.min(SLOT_FLOOR_MM, Math.max(0, room))), zMm: 0 }
}

const DEVICE_CATEGORIES: ReadonlySet<string> = new Set(DeviceCategorySchema.options)

function isDeviceCategory(value: string): value is DeviceCategory {
  return DEVICE_CATEGORIES.has(value)
}

/** The device categories a slot takes (each once); an unknown category is an error. */
function deviceCategories(values: readonly string[]): DeviceCategory[] {
  const result: DeviceCategory[] = []
  for (const value of values) {
    if (!isDeviceCategory(value)) {
      throw new CustomPartError('This part is not valid.', [
        `slots.0.accepts.categories: "${value}" is not a device category`,
      ])
    }
    if (!result.includes(value)) result.push(value)
  }
  return result
}

function slotsFor(holds: CustomHolds, heightSixths: number): Slot[] {
  switch (holds.kind) {
    case 'nothing':
      return []
    case 'device': {
      const categories = deviceCategories(holds.categories ?? [])
      return [
        {
          id: DEVICE_SLOT_ID,
          label: 'Device',
          kind: 'fixed',
          maxW: holds.maxW,
          maxD: holds.maxD,
          maxH: holds.maxH,
          orientations: ['flat', 'flat-rotated'],
          ...(categories.length === 0 ? {} : { accepts: { categories } }),
          layout: slotLayout(holds.maxW, holds.maxH, heightSixths),
        },
      ]
    }
    case 'shelf':
      return [
        {
          id: SHELF_SLOT_ID,
          label: 'Shelf',
          kind: 'area',
          maxW: holds.maxW,
          maxD: holds.maxD,
          ...(holds.maxH === undefined ? {} : { maxH: holds.maxH }),
          orientations: ['flat', 'flat-rotated'],
          layout: slotLayout(holds.maxW, holds.maxH, heightSixths),
        },
      ]
  }
}

function defaultRenderStyle(holds: CustomHolds['kind'], category: string): RenderStyle {
  if (holds === 'device') return 'tray'
  if (holds === 'shelf') return 'shelf'
  return category === 'power' ? 'power' : 'blank'
}

function facesOf(faces: readonly Face[] | undefined): Face[] {
  const wanted = new Set(faces ?? [])
  const result = (['front', 'rear'] as const).filter((face) => wanted.has(face))
  return result.length === 0 ? ['front'] : result
}

interface RecipeParts {
  prints: PrintGroup[]
  recipe: RecipeLine[]
}

/**
 * Print groups and `unit: item` recipe lines for the typed rows. Print ids come from the row ids
 * (when free) or the plate names; `reservedPrints` / `reservedLines` are ids already in use.
 */
function recipeFor(
  prints: readonly CustomPrintRow[],
  hardware: readonly CustomHardwareRow[],
  reservedPrints: ReadonlySet<string> = new Set(),
  reservedLines: ReadonlySet<string> = new Set(),
): RecipeParts {
  const printIds = new Set(reservedPrints)
  const lineIds = new Set(reservedLines)
  const groups: PrintGroup[] = []
  const recipe: RecipeLine[] = []
  for (const row of prints) {
    const plate = row.plate.trim()
    const id = keepOrMakeKey(row.id, plate, printIds, 'print')
    const material = trimmed(row.material)
    groups.push({
      id,
      plate,
      label: plate,
      ...(material === undefined ? {} : { material }),
      ...(row.gramsPerPrint === undefined ? {} : { gramsPerPrint: row.gramsPerPrint }),
      ...(row.minutesPerPrint === undefined ? {} : { minutesPerPrint: row.minutesPerPrint }),
    })
    recipe.push({
      id: uniqueKey(id, lineIds, 'print'),
      unit: 'item',
      ref: { print: id },
      count: row.count,
      role: 'assembly',
    })
  }
  // The same hardware twice becomes one line.
  const counts = new Map<string, number>()
  for (const row of hardware) {
    counts.set(row.hardwareId, (counts.get(row.hardwareId) ?? 0) + row.count)
  }
  for (const [hardwareId, count] of counts) {
    recipe.push({
      id: uniqueKey(hardwareId, lineIds, 'hardware'),
      unit: 'item',
      ref: { hardware: hardwareId },
      count,
      role: 'assembly',
    })
  }
  return { prints: groups, recipe }
}

interface ItemDraft {
  name: string
  category: string
  source: Source | undefined
}

function itemDraft(input: CustomItemInput): ItemDraft {
  return {
    name: input.name.trim(),
    category: trimmed(input.category) ?? 'other',
    source: sourceFor(
      input.sourceUrl,
      {
        ...(input.designer === undefined ? {} : { designer: input.designer }),
        ...(input.license === undefined ? {} : { license: input.license }),
      },
      'other',
    ),
  }
}

export function newCustomItem(input: CustomItemInput, taken: ReadonlySet<string>): Item {
  const { name, category, source } = itemDraft(input)
  const { prints, recipe } = recipeFor(input.prints ?? [], input.hardware ?? [])
  return checked(
    ItemSchema.safeParse({
      kind: 'item',
      id: customId(name, taken),
      name,
      category,
      ...(source === undefined ? {} : { source }),
      verified: verifiedFor(input),
      heightSixths: input.heightSixths,
      faces: facesOf(input.faces),
      bay: 'full',
      depthMm: input.depthMm,
      options: [],
      prints,
      recipe,
      mount: { front: defaultMountHoles(input.heightSixths, 'full'), rear: 0 },
      slots: slotsFor(input.holds, input.heightSixths),
      render: input.render ?? { style: defaultRenderStyle(input.holds.kind, category) },
    }),
    'part',
  )
}

/** A line the item form shows as a row: once per item, a fixed count, no condition or extras. */
function isPlainLine(line: RecipeLine): line is RecipeLine & { count: number } {
  return (
    line.unit === 'item' &&
    line.when === undefined &&
    line.length === undefined &&
    line.note === undefined &&
    line.role === 'assembly' &&
    typeof line.count === 'number'
  )
}

function refKey(ref: RecipeLine['ref']): string {
  return 'print' in ref ? `print:${ref.print}` : `hardware:${ref.hardware}`
}

/** Print groups the item form shows: those counted by at least one plain line. */
function shownPrintIds(item: Item): Set<string> {
  const ids = new Set<string>()
  for (const line of item.recipe) {
    if (isPlainLine(line) && 'print' in line.ref) ids.add(line.ref.print)
  }
  return ids
}

function holdsOf(item: Item): CustomHolds {
  const [slot] = item.slots
  if (slot === undefined) return { kind: 'nothing' }
  if (slot.kind === 'area') {
    return {
      kind: 'shelf',
      maxW: slot.maxW,
      maxD: slot.maxD,
      ...(slot.maxH === undefined ? {} : { maxH: slot.maxH }),
    }
  }
  const categories = slot.accepts?.categories
  return {
    kind: 'device',
    maxW: slot.maxW,
    maxD: slot.maxD,
    // A fixed slot without a height limit: as tall as the item leaves room for.
    maxH:
      slot.maxH ??
      round2(Math.max(1, sixthsToMm(item.heightSixths) - slot.layout.yMm - SHELF_HEADROOM_MM)),
    ...(categories === undefined ? {} : { categories: [...categories] }),
  }
}

/** The plain-language input that shows `item` in the mount/panel/shelf form. */
export function customItemInputOf(item: Item): CustomItemInput {
  const shown = shownPrintIds(item)
  const printCounts = new Map<string, number>()
  const hardwareCounts = new Map<string, number>()
  for (const line of item.recipe) {
    if (!isPlainLine(line)) continue
    if ('print' in line.ref) {
      printCounts.set(line.ref.print, (printCounts.get(line.ref.print) ?? 0) + line.count)
    } else {
      const id = line.ref.hardware
      hardwareCounts.set(id, (hardwareCounts.get(id) ?? 0) + line.count)
    }
  }
  const prints: CustomPrintRow[] = item.prints
    .filter((print) => shown.has(print.id))
    .map((print) => ({
      id: print.id,
      plate: print.plate,
      count: printCounts.get(print.id) ?? 1,
      ...(print.gramsPerPrint === undefined ? {} : { gramsPerPrint: print.gramsPerPrint }),
      ...(print.minutesPerPrint === undefined ? {} : { minutesPerPrint: print.minutesPerPrint }),
      ...(print.material === undefined ? {} : { material: print.material }),
    }))
  const hardware: CustomHardwareRow[] = [...hardwareCounts].map(([hardwareId, count]) => ({
    hardwareId,
    count,
  }))
  const { source } = item
  return {
    name: item.name,
    category: item.category,
    heightSixths: item.heightSixths,
    depthMm: item.depthMm,
    faces: [...item.faces],
    holds: holdsOf(item),
    ...(item.render === undefined ? {} : { render: { ...item.render } }),
    prints,
    hardware,
    ...(source === undefined ? {} : { sourceUrl: source.url }),
    ...(source?.designer === undefined ? {} : { designer: source.designer }),
    ...(source?.license === undefined ? {} : { license: source.license }),
    verifiedMethod: item.verified.method,
  }
}

function sameSize(a: Slot, b: Slot): boolean {
  return a.maxW === b.maxW && a.maxD === b.maxD && a.maxH === b.maxH
}

/**
 * The form edits the first slot (or replaces it when what the part holds changed); further slots
 * are kept. The first slot keeps its id (placed devices refer to it), label, orientations and
 * accepted device ids; its layout follows new sizes.
 */
function mergeSlots(
  previous: readonly Slot[],
  next: readonly Slot[],
  heightChanged: boolean,
): Slot[] {
  const [made] = next
  if (made === undefined) return []
  const [first, ...rest] = previous
  if (first === undefined) return [made]
  if (first.kind !== made.kind) {
    const used = new Set(rest.map((slot) => slot.id))
    const id = used.has(made.id) ? uniqueKey(made.id, used, 'slot') : made.id
    return [{ ...made, id }, ...rest]
  }
  const merged: Slot = { ...first, maxW: made.maxW, maxD: made.maxD }
  if (made.maxH === undefined) delete merged.maxH
  else merged.maxH = made.maxH
  const categories = made.accepts?.categories
  const deviceIds = first.accepts?.deviceIds
  if (categories === undefined && deviceIds === undefined) delete merged.accepts
  else {
    merged.accepts = {
      ...(categories === undefined ? {} : { categories }),
      ...(deviceIds === undefined ? {} : { deviceIds }),
    }
  }
  if (heightChanged || !sameSize(first, made)) merged.layout = made.layout
  return [merged, ...rest]
}

/** The mount after a height change: default hole counts, hole positions dropped. */
function remount(previous: Mount, item: Pick<Item, 'heightSixths' | 'bay'>): Mount {
  const holes = defaultMountHoles(item.heightSixths, item.bay)
  const mount: Mount = { ...previous, front: holes, rear: previous.rear > 0 ? holes : 0 }
  delete mount.holeOffsetsMm
  return mount
}

/** `existing` with the item form's input applied: same id, details the form hides are kept. */
export function editCustomItem(existing: Item, input: CustomItemInput): Item {
  const { name, category, source } = itemDraft(input)
  const shown = shownPrintIds(existing)
  const hiddenPrints = existing.prints.filter((print) => !shown.has(print.id))
  const keptLines = existing.recipe.filter(
    (line) =>
      !isPlainLine(line) &&
      (!('print' in line.ref) || existing.prints.some((print) => print.id === refId(line))),
  )
  const parts = recipeFor(
    input.prints ?? [],
    input.hardware ?? [],
    new Set(hiddenPrints.map((print) => print.id)),
    new Set(keptLines.map((line) => line.id)),
  )
  const previousPrints = new Map(existing.prints.map((print) => [print.id, print]))
  const prints = [
    ...parts.prints.map((print) => {
      const previous = previousPrints.get(print.id)
      if (previous === undefined) return print
      // Pieces and embedded hardware stay; the label follows a renamed plate.
      const merged: PrintGroup = {
        ...previous,
        plate: print.plate,
        label: previous.plate === print.plate ? previous.label : print.label,
      }
      if (print.material === undefined) delete merged.material
      else merged.material = print.material
      if (print.gramsPerPrint === undefined) delete merged.gramsPerPrint
      else merged.gramsPerPrint = print.gramsPerPrint
      if (print.minutesPerPrint === undefined) delete merged.minutesPerPrint
      else merged.minutesPerPrint = print.minutesPerPrint
      return merged
    }),
    ...hiddenPrints,
  ]
  const printIds = new Set(prints.map((print) => print.id))
  // Plain lines keep their ids for the same print or hardware (saved state may refer to them).
  const previousLineIds = new Map<string, string>()
  for (const line of existing.recipe) {
    const key = refKey(line.ref)
    if (isPlainLine(line) && !previousLineIds.has(key)) previousLineIds.set(key, line.id)
  }
  const lineIds = new Set(keptLines.map((line) => line.id))
  const plainLines = parts.recipe.map((line) => ({
    ...line,
    id: keepOrMakeKey(previousLineIds.get(refKey(line.ref)), line.id, lineIds, 'line'),
  }))
  const recipe = [
    ...plainLines,
    ...keptLines.filter((line) => !('print' in line.ref) || printIds.has(refId(line))),
  ]
  const heightChanged = existing.heightSixths !== input.heightSixths
  const next: Item = {
    ...existing,
    name,
    category,
    verified: verifiedFor(input, existing.verified),
    heightSixths: input.heightSixths,
    faces: facesOf(input.faces),
    depthMm: input.depthMm,
    prints,
    recipe,
    mount: heightChanged
      ? remount(existing.mount, { heightSixths: input.heightSixths, bay: existing.bay })
      : existing.mount,
    slots: mergeSlots(existing.slots, slotsFor(input.holds, input.heightSixths), heightChanged),
    render: {
      ...existing.render,
      style:
        input.render?.style ??
        existing.render?.style ??
        defaultRenderStyle(input.holds.kind, category),
      ...(input.render?.color === undefined ? {} : { color: input.render.color }),
    },
  }
  const edited = editedSource(existing.source, source, {
    ...(input.designer === undefined ? {} : { designer: input.designer }),
    ...(input.license === undefined ? {} : { license: input.license }),
  })
  if (edited === undefined) delete next.source
  else next.source = edited
  return checked(ItemSchema.safeParse(next), 'part')
}

function refId(line: RecipeLine): string {
  return 'print' in line.ref ? line.ref.print : line.ref.hardware
}

// ---------------------------------------------------------------------------------------------
// "Needs a mount?": a mount sized for one device

/** Room around the device in a mount made for it, on each of width, depth and height. */
export const DEVICE_MOUNT_CLEARANCE_MM = 2
/** A mount made for a device reaches this much deeper than the device. */
export const DEVICE_MOUNT_EXTRA_DEPTH_MM = 10

export interface CustomMountOptions extends CustomEntryCommon {
  heightSixths: number
  name?: string
}

/** A mount sized for `device` (Needs a mount?): one fixed slot with clearance, height in U. */
export function customMountForDevice(
  device: Device,
  options: CustomMountOptions,
  taken: ReadonlySet<string>,
): Item {
  const name = trimmed(options.name) ?? `${deviceName(device)} mount`
  const maxW = round2(device.dims.w + DEVICE_MOUNT_CLEARANCE_MM)
  const maxD = round2(device.dims.d + DEVICE_MOUNT_CLEARANCE_MM)
  const maxH = round2(device.dims.h + DEVICE_MOUNT_CLEARANCE_MM)
  return checked(
    ItemSchema.safeParse({
      kind: 'item',
      id: customId(name, taken),
      name,
      // The catalog's own category for mounts (the palette shows it as "Mounts").
      category: 'mount',
      verified: verifiedFor(options),
      heightSixths: options.heightSixths,
      faces: ['front'],
      bay: 'full',
      depthMm: round2(device.dims.d + DEVICE_MOUNT_EXTRA_DEPTH_MM),
      options: [],
      prints: [],
      recipe: [],
      mount: { front: defaultMountHoles(options.heightSixths, 'full'), rear: 0 },
      slots: [
        {
          id: DEVICE_SLOT_ID,
          label: deviceName(device),
          kind: 'fixed',
          maxW,
          maxD,
          maxH,
          orientations: ['flat'],
          accepts: { categories: [device.category] },
          layout: slotLayout(maxW, maxH, options.heightSixths),
        },
      ],
      render: { style: 'device' },
    }),
    'mount',
  )
}

// ---------------------------------------------------------------------------------------------
// Frames

/** Plain-language frame input for commercial or self-designed racks (one fixed section). */
export interface CustomFrameInput extends CustomEntryCommon {
  name: string
  heightU: number
  innerWidthMm: number
  depthMm: number
  rearOpen: boolean
  thread: Frame['equipmentFastener']['thread']
  perHole: Frame['equipmentFastener']['perHole']
  sourceUrl?: string
}

/** The one section type of a frame built here: the whole rack. */
export const CUSTOM_FRAME_SECTION_ID = 'rack'
/** Rail hole tolerance of a frame built here (like the generic 10" rack). */
export const CUSTOM_FRAME_HOLE_TOLERANCE_MM = 1

/** Stock screws (shortest first) and nuts of the shared catalog, per thread. */
const THREAD_HARDWARE: Readonly<
  Record<Thread, { screws: readonly string[]; nut?: string; cageNut?: string }>
> = {
  M3: {
    screws: [
      'screw-m3x6-shcs',
      'screw-m3x8-shcs',
      'screw-m3x10-shcs',
      'screw-m3x12-shcs',
      'screw-m3x16-shcs',
      'screw-m3x20-shcs',
    ],
    nut: 'nut-m3-hex',
  },
  M4: {
    screws: [
      'screw-m4x6-shcs',
      'screw-m4x8-shcs',
      'screw-m4x10-shcs',
      'screw-m4x12-shcs',
      'screw-m4x16-shcs',
      'screw-m4x20-shcs',
    ],
    nut: 'nut-m4-hex',
  },
  M5: {
    screws: ['screw-m5x10-shcs', 'screw-m5x12-shcs', 'screw-m5x16-shcs', 'screw-m5x20-shcs'],
    nut: 'nut-m5-hex',
  },
  M6: {
    screws: [
      'screw-m6x8-shcs',
      'screw-m6x10-shcs',
      'screw-m6x12-shcs',
      'screw-m6x16-shcs',
      'screw-m6x20-shcs',
    ],
    nut: 'nut-m6-hex',
    cageNut: 'cage-nut-m6',
  },
  '10-32': { screws: ['screw-10-32x5-16in', 'screw-10-32x1-2in'] },
  '12-24': { screws: [] },
}

/**
 * Thread beyond the ear the screw needs: into a tapped hole or insert 6 mm, through a rail and a
 * cage nut 8 mm, through a rail and a hex nut 10 mm. With the BOM's default 4 mm ear that picks
 * M6×10 / M6×12 / M6×16 (and #10-32 × 1/2" for a tapped 10-32 rail).
 */
const ENGAGEMENT_MM: Readonly<Record<PerHole, number>> = {
  screw: 6,
  'screw+cage-nut': 8,
  'screw+nut': 10,
}

/**
 * Rack screws and nuts for a thread from the shared catalog's hardware. Threads without stock
 * screws (12-24) list none (the BOM then says rack screws are not counted); a nut the catalog
 * does not have (an M5 cage nut, 10-32 nuts) is left out the same way.
 */
export function customFrameFastener(thread: Thread, perHole: PerHole): Frame['equipmentFastener'] {
  const known = THREAD_HARDWARE[thread]
  const nutId =
    perHole === 'screw+nut' ? known.nut : perHole === 'screw+cage-nut' ? known.cageNut : undefined
  return {
    thread,
    perHole,
    screwIds: [...known.screws],
    engagementMm: ENGAGEMENT_MM[perHole],
    ...(nutId === undefined ? {} : { nutId }),
  }
}

export function newCustomFrame(input: CustomFrameInput, taken: ReadonlySet<string>): Frame {
  const name = input.name.trim()
  const source = sourceFor(input.sourceUrl, {}, 'vendor')
  return checked(
    FrameSchema.safeParse({
      kind: 'frame',
      id: customId(name, taken),
      name,
      ...(source === undefined ? {} : { source }),
      verified: verifiedFor(input),
      standard: {
        panelWidthMm: PANEL_WIDTH_MM,
        innerWidthMm: input.innerWidthMm,
        depthMm: input.depthMm,
        rearOpen: input.rearOpen,
      },
      rail: {
        earSpacingMm: EIA_EAR_SPACING_MM,
        holeOffsetsPerUMm: [...EIA_HOLE_OFFSETS_PER_U_MM],
        holeTolMm: CUSTOM_FRAME_HOLE_TOLERANCE_MM,
      },
      equipmentFastener: customFrameFastener(input.thread, input.perHole),
      sectionTypes: [{ id: CUSTOM_FRAME_SECTION_ID, label: 'Whole rack', heightU: input.heightU }],
      stack: { minU: input.heightU, maxU: input.heightU },
      options: [],
      prints: [],
      recipe: [],
    }),
    'frame',
  )
}

/** A frame of one fixed-height section that is the whole rack, as `newCustomFrame` builds. */
export function isOnePieceCustomFrame(frame: Frame): boolean {
  const [type, ...others] = frame.sectionTypes
  return (
    type !== undefined &&
    others.length === 0 &&
    typeof type.heightU === 'number' &&
    frame.stack.minU === type.heightU &&
    frame.stack.maxU === type.heightU
  )
}

/** The plain-language input that shows `frame` in the frame form. */
export function customFrameInputOf(frame: Frame): CustomFrameInput {
  const [type] = frame.sectionTypes
  const heightU =
    isOnePieceCustomFrame(frame) && type !== undefined && typeof type.heightU === 'number'
      ? type.heightU
      : frame.stack.maxU
  return {
    name: frame.name,
    heightU,
    innerWidthMm: frame.standard.innerWidthMm,
    depthMm: frame.standard.depthMm,
    rearOpen: frame.standard.rearOpen,
    thread: frame.equipmentFastener.thread,
    perHole: frame.equipmentFastener.perHole,
    ...(frame.source === undefined ? {} : { sourceUrl: frame.source.url }),
    verifiedMethod: frame.verified.method,
  }
}

function mergeFastener(
  previous: Frame['equipmentFastener'],
  next: Frame['equipmentFastener'],
): Frame['equipmentFastener'] {
  if (previous.thread !== next.thread) return next
  if (previous.perHole === next.perHole) return previous
  const merged = { ...previous, perHole: next.perHole, engagementMm: next.engagementMm }
  if (next.nutId === undefined) delete merged.nutId
  else merged.nutId = next.nutId
  return merged
}

/**
 * `existing` with the frame form's input applied: same id; options, prints, recipe, rails and 3D
 * data are kept. The height only changes on one-piece frames (`isOnePieceCustomFrame`).
 */
export function editCustomFrame(existing: Frame, input: CustomFrameInput): Frame {
  const made = newCustomFrame(input, new Set())
  const next: Frame = {
    ...existing,
    name: made.name,
    verified: verifiedFor(input, existing.verified),
    standard: {
      ...existing.standard,
      innerWidthMm: input.innerWidthMm,
      depthMm: input.depthMm,
      rearOpen: input.rearOpen,
    },
    equipmentFastener: mergeFastener(existing.equipmentFastener, made.equipmentFastener),
  }
  const [type] = existing.sectionTypes
  if (isOnePieceCustomFrame(existing) && type !== undefined) {
    next.sectionTypes = [{ ...type, heightU: input.heightU }]
    next.stack = { ...existing.stack, minU: input.heightU, maxU: input.heightU }
  }
  const source = editedSource(existing.source, made.source)
  if (source === undefined) delete next.source
  else next.source = source
  return checked(FrameSchema.safeParse(next), 'frame')
}

// ---------------------------------------------------------------------------------------------
// What the plain forms do not show

function countText(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/**
 * Details of an entry the plain-language forms do not show (editing keeps them), as short
 * phrases: "2 options", "3D parts", "rail hole positions". Empty for entries the forms made.
 */
export function customAdvancedDetails(entry: CatalogEntry): string[] {
  const details: string[] = []
  switch (entry.kind) {
    case 'device': {
      const power = entry.power
      if ((power?.outputs?.length ?? 0) > 0) details.push('the outlets or ports it provides')
      if (power?.input.connector !== undefined) details.push('its power connector')
      const brick = power?.input.brick
      if (brick !== undefined) {
        // The form shows a wall plug; other plugs, the brick's size and its watts it does not.
        const plug = brick.plug !== undefined && brick.plug !== 'wall'
        if (plug || brick.dims !== undefined || brick.outputW !== undefined) {
          details.push('power brick details')
        }
      }
      if (entry.rackmount?.face === 'rear') details.push('mounting on the rear rails')
      break
    }
    case 'item':
    case 'extra': {
      if (entry.options.length > 0) details.push(countText(entry.options.length, 'option'))
      if ((entry.parts3d?.length ?? 0) > 0) details.push('3D parts')
      if ((entry.compat?.frames?.length ?? 0) > 0) details.push('the frames it is made for')
      if (entry.requiresRearSupport === true) details.push('rear support')
      if (entry.bay === 'half') details.push('half width')
      if (entry.slots.length > 1) details.push(countText(entry.slots.length - 1, 'more slot'))
      if (entry.mount.holeOffsetsMm !== undefined) details.push('ear hole positions')
      const plain = entry.recipe.filter(isPlainLine).length
      if (plain < entry.recipe.length) {
        details.push(countText(entry.recipe.length - plain, 'conditional print or hardware line'))
      }
      break
    }
    case 'frame': {
      if (!isOnePieceCustomFrame(entry)) details.push('its section types and stack height')
      if (entry.options.length > 0) details.push(countText(entry.options.length, 'option'))
      if (entry.prints.length + entry.recipe.length > 0) details.push('its prints and hardware')
      const rail = entry.rail
      const eia =
        rail.earSpacingMm === EIA_EAR_SPACING_MM &&
        rail.holeOffsetsPerUMm.length === EIA_HOLE_OFFSETS_PER_U_MM.length &&
        rail.holeOffsetsPerUMm.every((offset, index) => offset === EIA_HOLE_OFFSETS_PER_U_MM[index])
      if (!eia) details.push('rail hole positions')
      if ((entry.parts3d?.length ?? 0) + (entry.assembly3d?.length ?? 0) > 0) {
        details.push('3D parts')
      }
      break
    }
    case 'hardware':
      break
  }
  return details
}

// ---------------------------------------------------------------------------------------------
// Copies

/** A copy of a custom entry under a new id, named "<name> (copy)". */
export function duplicateCustomEntry(
  entry: CatalogEntry,
  taken: ReadonlySet<string>,
): CatalogEntry {
  if (entry.kind === 'device') {
    const model = `${entry.model} (copy)`
    return { ...entry, id: customId(`${entry.brand} ${model}`, taken), model }
  }
  const name = `${entry.name} (copy)`
  return { ...entry, id: customId(name, taken), name }
}

// ---------------------------------------------------------------------------------------------
// Plans

type CustomListKey = keyof PlanCustom

const CUSTOM_LISTS: readonly CustomListKey[] = ['frames', 'items', 'devices', 'hardware']

function listKeyOf(kind: CatalogEntry['kind']): CustomListKey {
  switch (kind) {
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

/** `list` with `entry` added or in place of the same id; undefined when it is already there. */
function upsert<T extends { id: string }>(list: readonly T[], entry: T): T[] | undefined {
  const index = list.findIndex((candidate) => candidate.id === entry.id)
  if (index === -1) return [...list, entry]
  const current = list[index]
  if (current !== undefined && sameJson(current, entry)) return undefined
  return list.with(index, entry)
}

/** `custom` without `id` in lists other than `keep` (one id, one entry). */
function withoutElsewhere(custom: PlanCustom, id: string, keep: CustomListKey): PlanCustom {
  let result = custom
  for (const key of CUSTOM_LISTS) {
    if (key === keep) continue
    const list: ReadonlyArray<{ id: string }> = result[key]
    if (!list.some((entry) => entry.id === id)) continue
    switch (key) {
      case 'frames':
        result = { ...result, frames: result.frames.filter((entry) => entry.id !== id) }
        break
      case 'items':
        result = { ...result, items: result.items.filter((entry) => entry.id !== id) }
        break
      case 'devices':
        result = { ...result, devices: result.devices.filter((entry) => entry.id !== id) }
        break
      case 'hardware':
        result = { ...result, hardware: result.hardware.filter((entry) => entry.id !== id) }
        break
    }
  }
  return result
}

/**
 * Copies the given custom entries into `plan.custom` (replacing same ids); others untouched.
 * Entries without a `custom:` id are skipped (a plan never shadows the shared catalog). Returns
 * the same plan object when every entry is already there unchanged.
 */
export function embedCustomEntries(plan: Plan, entries: readonly CatalogEntry[]): Plan {
  let custom: PlanCustom = plan.custom
  for (const entry of entries) {
    if (!isCustomId(entry.id)) continue
    custom = withoutElsewhere(custom, entry.id, listKeyOf(entry.kind))
    switch (entry.kind) {
      case 'frame': {
        const frames = upsert(custom.frames, entry)
        if (frames !== undefined) custom = { ...custom, frames }
        break
      }
      case 'item':
      case 'extra': {
        const items = upsert(custom.items, entry)
        if (items !== undefined) custom = { ...custom, items }
        break
      }
      case 'device': {
        const devices = upsert(custom.devices, entry)
        if (devices !== undefined) custom = { ...custom, devices }
        break
      }
      case 'hardware': {
        const hardware = upsert(custom.hardware, entry)
        if (hardware !== undefined) custom = { ...custom, hardware }
        break
      }
    }
  }
  return custom === plan.custom ? plan : { ...plan, custom }
}

/**
 * `custom:` ids an entry needs to be complete: the hardware of its recipe, print embeds and rack
 * screws and nuts. (Frames an item is made for and devices a slot names are only filters.)
 */
export function customRefsOf(entry: CatalogEntry): string[] {
  const refs: string[] = []
  const recipeRefs = (recipe: readonly RecipeLine[], prints: readonly PrintGroup[]): void => {
    for (const line of recipe) if ('hardware' in line.ref) refs.push(line.ref.hardware)
    for (const print of prints) for (const embed of print.embeds ?? []) refs.push(embed.hardwareId)
  }
  switch (entry.kind) {
    case 'frame':
      recipeRefs(entry.recipe, entry.prints)
      refs.push(...entry.equipmentFastener.screwIds)
      if (entry.equipmentFastener.nutId !== undefined) refs.push(entry.equipmentFastener.nutId)
      break
    case 'item':
    case 'extra':
      recipeRefs(entry.recipe, entry.prints)
      break
    case 'device':
    case 'hardware':
      break
  }
  return [...new Set(refs.filter(isCustomId))]
}

/** `custom:` ids the plan's own structure names (not what those entries refer to). */
function directCustomIds(plan: Plan): Set<string> {
  const ids = new Set<string>()
  const add = (id: string | undefined): void => {
    if (id !== undefined && isCustomId(id)) ids.add(id)
  }
  add(plan.frame.frameId)
  for (const placement of plan.placements) {
    add(placement.itemId)
    add(placement.have?.itemId)
    for (const device of placement.devices) add(device.deviceId)
  }
  for (const entry of plan.equipment) add(entry.deviceId)
  for (const extra of plan.extras) add(extra.itemId)
  for (const retired of plan.retired) {
    add(retired.snapshot.itemId)
    for (const deviceId of retired.devices ?? []) add(deviceId)
  }
  return ids
}

/** `ids` plus everything the resolvable ones refer to, transitively (`ids` is extended). */
function withReferences(
  ids: Set<string>,
  resolve: (id: string) => CatalogEntry | undefined,
): Set<string> {
  const queue = [...ids]
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    const entry = resolve(id)
    if (entry === undefined) continue
    for (const ref of customRefsOf(entry)) {
      if (ids.has(ref)) continue
      ids.add(ref)
      queue.push(ref)
    }
  }
  return ids
}

function ownEntries(plan: Plan): Map<string, CatalogEntry> {
  const { frames, items, devices, hardware } = plan.custom
  const entries = new Map<string, CatalogEntry>()
  for (const entry of [...frames, ...items, ...devices, ...hardware]) entries.set(entry.id, entry)
  return entries
}

/**
 * Ids of every `custom:` entry the plan references (frame, placements and their Have snapshots,
 * placed devices, equipment, extras, retired parts), plus the custom hardware those of the
 * plan's own entries need (`customRefsOf`).
 */
export function customIdsUsed(plan: Plan): Set<string> {
  const own = ownEntries(plan)
  return withReferences(directCustomIds(plan), (id) => own.get(id))
}

/**
 * Embeds the entries of `available` (the user's library) that the plan uses but does not carry
 * yet, with the custom hardware they need, so the plan exports and shares complete. Entries the
 * plan already has are left as they are: a plan keeps the version it was planned with.
 */
export function embedUsedCustomEntries(plan: Plan, available: readonly CatalogEntry[]): Plan {
  const own = ownEntries(plan)
  const offered = new Map<string, CatalogEntry>()
  for (const entry of available) if (isCustomId(entry.id)) offered.set(entry.id, entry)
  const used = withReferences(directCustomIds(plan), (id) => own.get(id) ?? offered.get(id))
  const missing: CatalogEntry[] = []
  for (const id of used) {
    const entry = own.has(id) ? undefined : offered.get(id)
    if (entry !== undefined) missing.push(entry)
  }
  return embedCustomEntries(plan, missing)
}
