/**
 * Share links: `p=1.<base64url(deflate-raw(compact JSON))>`, opened as `/view#p=1.…`.
 *
 * The compact JSON keeps only what a viewer needs. Plan and entity ids, timestamps, revisions and
 * schema defaults are dropped; entities are identified by their position. Decoding regenerates
 * ids and timestamps, then runs the usual migrate + validate path.
 *
 * - template: no ownership at all (Have, owned devices and quantities, retired parts) and no notes.
 *   Decoding enforces this, so a forged template link cannot smuggle Have flags in.
 * - showoff: keeps Have; snapshots are reduced to what was built (no capture time).
 *
 * Catalog ids, including the plan's own `custom:` entries, are kept verbatim. Unknown ids stay in
 * the plan as placeholders (with a warning when a catalog is given).
 */
import { z } from 'zod'
import type { ShareMode } from './api'
import { base64UrlLength, decodeBase64Url, encodeBase64Url } from './base64url'
import { ID_PREFIX, newId } from './ids'
import {
  migratePlan,
  PlanInvalidError,
  PlanLoadError,
  PlanTooNewError,
  toPlanIssues,
  type PlanDocument,
  type PlanIssue,
} from './migrate'
import { withCustomEntries, type CatalogLookup } from './schema/catalog'
import {
  FaceSchema,
  OptionValuesSchema,
  OrientationSchema,
  type OptionValues,
} from './schema/common'
import {
  PLAN_SCHEMA_VERSION,
  PlacementBaySchema,
  RetiredKindSchema,
  type CapState,
  type PlacedDevice,
  type Placement,
  type Plan,
  type PlanCustom,
  type PlanEquipment,
  type PlanExtra,
  type PlanSection,
  type RetiredEntry,
  type Snapshot,
} from './schema/plan'

export const SHARE_CODEC_VERSION = 1
/** Longer links are offered as a file instead. */
export const SHARE_TARGET_LENGTH = 2000
/** Cap on the decompressed JSON, enforced while inflating so a tiny forged link cannot balloon. */
export const MAX_SHARE_JSON_BYTES = 256 * 1024
// Deflate grows incompressible data by a few bytes per 64 KiB block at most, so a payload longer
// than this cannot inflate to valid JSON under the cap and is rejected unread.
const MAX_PAYLOAD_CHARS = base64UrlLength(MAX_SHARE_JSON_BYTES + 1024)
const LINK_PATTERN = /^p=(\d{1,9})\.([A-Za-z0-9_-]*)$/

// ---------------------------------------------------------------------------------------------
// Errors

/**
 * - malformed: not a share link, or characters a link cannot contain
 * - unsupported-version: made by a newer version of the app
 * - too-large: over the size cap (link text or decompressed data)
 * - corrupt: damaged or truncated (decompression, UTF-8 or JSON fails)
 * - invalid: readable, but not a valid plan (issues lists why)
 */
export type ShareErrorReason =
  'malformed' | 'unsupported-version' | 'too-large' | 'corrupt' | 'invalid'

export class ShareLinkError extends PlanLoadError {
  override name = 'ShareLinkError'
  readonly reason: ShareErrorReason
  readonly issues: readonly PlanIssue[]

  constructor(
    reason: ShareErrorReason,
    message: string,
    details: { cause?: unknown; issues?: readonly PlanIssue[] } = {},
  ) {
    super(message, 'cause' in details ? { cause: details.cause } : undefined)
    this.reason = reason
    this.issues = details.issues ?? []
  }
}

const DAMAGED = 'This share link is damaged or incomplete.'
const NOT_A_PLAN = 'This share link does not contain a valid plan.'

// ---------------------------------------------------------------------------------------------
// Compact form (codec v1). One-letter keys keep links short; entities have no ids, their
// position in each array identifies them. Unknown keys are ignored.

/** A set flag (Have, show-off mode); the key is omitted when the flag is off. */
const FlagSchema = z.literal(1)

const CompactSnapshotSchema = z.object({
  t: z.string().optional(), // typeId
  u: z.number().optional(), // heightU
  i: z.string().optional(), // itemId
  o: OptionValuesSchema.optional(), // options, omitted when empty
})
type CompactSnapshot = z.infer<typeof CompactSnapshotSchema>

const CompactCapSchema = z.object({
  o: OptionValuesSchema.optional(), // options
  h: CompactSnapshotSchema.optional(), // have
})
type CompactCap = z.infer<typeof CompactCapSchema>

const CompactSectionSchema = z.object({
  t: z.string(), // typeId
  u: z.number().optional(), // heightU
  o: OptionValuesSchema.optional(), // options
  h: CompactSnapshotSchema.optional(), // have
})
type CompactSection = z.infer<typeof CompactSectionSchema>

const CompactDeviceSchema = z.object({
  i: z.string(), // deviceId
  s: z.string(), // slotId
  x: z.number().optional(), // xMm
  r: OrientationSchema.optional(), // orientation
  h: FlagSchema.optional(), // have
})
type CompactDevice = z.infer<typeof CompactDeviceSchema>

const CompactPlacementSchema = z.object({
  i: z.string(), // itemId
  n: z.string().optional(), // name (denormalized)
  s: z.number().optional(), // heightSixths (denormalized)
  y: z.number(),
  f: FaceSchema.optional(), // face, omitted for front
  b: PlacementBaySchema.optional(), // bay, omitted for full
  o: OptionValuesSchema.optional(), // options
  h: CompactSnapshotSchema.optional(), // have
  l: z.string().optional(), // label
  d: z.array(CompactDeviceSchema).optional(), // devices
})
type CompactPlacement = z.infer<typeof CompactPlacementSchema>

const CompactEquipmentSchema = z.object({
  i: z.string(), // deviceId
  h: FlagSchema.optional(), // have
  t: z.string().optional(), // note
})
type CompactEquipment = z.infer<typeof CompactEquipmentSchema>

const CompactExtraSchema = z.object({
  i: z.string(), // itemId
  q: z.number(), // qty
  h: z.number().optional(), // haveQty
})
type CompactExtra = z.infer<typeof CompactExtraSchema>

const CompactRetiredSchema = z.object({
  k: RetiredKindSchema, // kind
  v: CompactSnapshotSchema, // snapshot
  c: z.enum(['top', 'bottom']).optional(), // sourceId of a retired cap
  d: z.array(z.string()).optional(), // owned device ids
  q: z.number().optional(), // qty
})
type CompactRetired = z.infer<typeof CompactRetiredSchema>

// Custom entries travel verbatim; PlanSchema validates them after expansion.
const CompactCustomSchema = z.object({
  f: z.array(z.unknown()).optional(), // frames
  i: z.array(z.unknown()).optional(), // items
  d: z.array(z.unknown()).optional(), // devices
  h: z.array(z.unknown()).optional(), // hardware
})
type CompactCustom = z.infer<typeof CompactCustomSchema>

const CompactPlanSchema = z.object({
  m: FlagSchema.optional(), // 1 = showoff; absent = template
  n: z.string(), // name
  t: z.string().optional(), // notes
  f: z.string(), // frameId
  o: OptionValuesSchema.optional(), // rack options
  c: z.object({ t: CompactCapSchema.optional(), b: CompactCapSchema.optional() }).optional(),
  s: z.array(CompactSectionSchema).optional(), // sections, bottom -> top
  p: z.array(CompactPlacementSchema).optional(), // placements
  e: z.array(CompactEquipmentSchema).optional(), // equipment
  x: z.array(CompactExtraSchema).optional(), // extras
  r: z.array(CompactRetiredSchema).optional(), // retired
  u: CompactCustomSchema.optional(), // the plan's custom entries
})
type CompactPlan = z.infer<typeof CompactPlanSchema>

// ---------------------------------------------------------------------------------------------
// Plan -> compact. JSON.stringify drops undefined values, so absent fields are left undefined.

function nonEmpty<T>(values: T[]): T[] | undefined {
  return values.length > 0 ? values : undefined
}

function nonEmptyOptions(options: OptionValues): OptionValues | undefined {
  return Object.keys(options).length > 0 ? options : undefined
}

function compactSnapshot(snapshot: Snapshot): CompactSnapshot {
  return {
    t: snapshot.typeId,
    u: snapshot.heightU,
    i: snapshot.itemId,
    o: nonEmptyOptions(snapshot.options),
  }
}

/** What gets written for an owned thing: its snapshot in show-off links, nothing in templates. */
function ownedSnapshot(
  snapshot: Snapshot | undefined,
  showoff: boolean,
): CompactSnapshot | undefined {
  return showoff && snapshot !== undefined ? compactSnapshot(snapshot) : undefined
}

function flag(on: boolean): 1 | undefined {
  return on ? 1 : undefined
}

function compactCap(cap: CapState, showoff: boolean): CompactCap | undefined {
  const have = ownedSnapshot(cap.have, showoff)
  return cap.options === undefined && have === undefined ? undefined : { o: cap.options, h: have }
}

function compactSection(section: PlanSection, showoff: boolean): CompactSection {
  return {
    t: section.typeId,
    u: section.heightU,
    o: section.options,
    h: ownedSnapshot(section.have, showoff),
  }
}

function compactDevice(device: PlacedDevice, showoff: boolean): CompactDevice {
  return {
    i: device.deviceId,
    s: device.slotId,
    x: device.xMm,
    r: device.orientation,
    h: flag(showoff && device.have),
  }
}

function compactPlacement(placement: Placement, showoff: boolean): CompactPlacement {
  return {
    i: placement.itemId,
    n: placement.name,
    s: placement.heightSixths,
    y: placement.y,
    f: placement.face === 'front' ? undefined : placement.face,
    b: placement.bay === 'full' ? undefined : placement.bay,
    o: placement.options,
    h: ownedSnapshot(placement.have, showoff),
    l: placement.label,
    d: nonEmpty(placement.devices.map((device) => compactDevice(device, showoff))),
  }
}

function compactEquipment(equipment: PlanEquipment, showoff: boolean): CompactEquipment {
  return {
    i: equipment.deviceId,
    h: flag(showoff && equipment.have),
    t: showoff ? equipment.note : undefined,
  }
}

function compactExtra(extra: PlanExtra, showoff: boolean): CompactExtra {
  return {
    i: extra.itemId,
    q: extra.qty,
    h: showoff && extra.haveQty > 0 ? extra.haveQty : undefined,
  }
}

function compactRetired(entry: RetiredEntry): CompactRetired {
  const { sourceId } = entry
  return {
    k: entry.kind,
    v: compactSnapshot(entry.snapshot),
    // Other source ids point at entities that were removed; ids are regenerated anyway.
    c: sourceId === 'top' || sourceId === 'bottom' ? sourceId : undefined,
    d: entry.devices,
    q: entry.qty,
  }
}

function compactCustom(custom: PlanCustom): CompactCustom | undefined {
  const compact = {
    f: nonEmpty(custom.frames),
    i: nonEmpty(custom.items),
    d: nonEmpty(custom.devices),
    h: nonEmpty(custom.hardware),
  }
  return Object.values(compact).some((entries) => entries !== undefined) ? compact : undefined
}

function compactPlan(plan: Plan, mode: ShareMode): CompactPlan {
  const showoff = mode === 'showoff'
  const top = compactCap(plan.frame.caps.top, showoff)
  const bottom = compactCap(plan.frame.caps.bottom, showoff)
  return {
    m: flag(showoff),
    n: plan.name,
    t: showoff ? plan.notes : undefined,
    f: plan.frame.frameId,
    o: nonEmptyOptions(plan.frame.options),
    c: top === undefined && bottom === undefined ? undefined : { t: top, b: bottom },
    s: nonEmpty(plan.frame.sections.map((section) => compactSection(section, showoff))),
    p: nonEmpty(plan.placements.map((placement) => compactPlacement(placement, showoff))),
    e: nonEmpty(plan.equipment.map((equipment) => compactEquipment(equipment, showoff))),
    x: nonEmpty(plan.extras.map((extra) => compactExtra(extra, showoff))),
    r: showoff ? nonEmpty(plan.retired.map(compactRetired)) : undefined,
    u: compactCustom(plan.custom),
  }
}

// ---------------------------------------------------------------------------------------------
// Compact -> plan document (validated afterwards by migratePlan)

/** Drops undefined values, so an expanded plan has the same keys as one parsed from storage. */
function defined(record: PlanDocument): PlanDocument {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

function expandSnapshot(snapshot: CompactSnapshot, at: string): PlanDocument {
  return defined({
    at,
    typeId: snapshot.t,
    heightU: snapshot.u,
    itemId: snapshot.i,
    options: snapshot.o ?? {},
  })
}

function expandPlacement(
  placement: CompactPlacement,
  have: (snapshot: CompactSnapshot | undefined) => PlanDocument | undefined,
  showoff: boolean,
): PlanDocument {
  return defined({
    id: newId(ID_PREFIX.placement),
    itemId: placement.i,
    name: placement.n,
    heightSixths: placement.s,
    y: placement.y,
    face: placement.f ?? 'front',
    bay: placement.b ?? 'full',
    options: placement.o,
    have: have(placement.h),
    label: placement.l,
    devices: (placement.d ?? []).map((device) =>
      defined({
        id: newId(ID_PREFIX.placedDevice),
        deviceId: device.i,
        slotId: device.s,
        xMm: device.x,
        orientation: device.r,
        have: showoff && device.h === 1,
      }),
    ),
  })
}

function expandRetired(entry: CompactRetired, at: string): PlanDocument {
  return defined({
    id: newId(ID_PREFIX.retired),
    kind: entry.k,
    snapshot: expandSnapshot(entry.v, at),
    sourceId: entry.c,
    devices: entry.d,
    qty: entry.q,
  })
}

/** Ownership is only read from show-off links; template links never carry it. */
function expandPlan(compact: CompactPlan, at: string): PlanDocument {
  const showoff = compact.m === 1
  const have = (snapshot: CompactSnapshot | undefined): PlanDocument | undefined =>
    showoff && snapshot !== undefined ? expandSnapshot(snapshot, at) : undefined
  const cap = (state: CompactCap | undefined): PlanDocument =>
    defined({ options: state?.o, have: have(state?.h) })
  return defined({
    schema: PLAN_SCHEMA_VERSION,
    id: newId(ID_PREFIX.plan),
    rackId: newId(ID_PREFIX.rack),
    name: compact.n,
    notes: showoff ? compact.t : undefined,
    createdAt: at,
    updatedAt: at,
    frame: {
      frameId: compact.f,
      options: compact.o ?? {},
      caps: { top: cap(compact.c?.t), bottom: cap(compact.c?.b) },
      sections: (compact.s ?? []).map((section) =>
        defined({
          id: newId(ID_PREFIX.section),
          typeId: section.t,
          heightU: section.u,
          options: section.o,
          have: have(section.h),
        }),
      ),
    },
    placements: (compact.p ?? []).map((placement) => expandPlacement(placement, have, showoff)),
    equipment: (compact.e ?? []).map((equipment) =>
      defined({
        id: newId(ID_PREFIX.equipment),
        deviceId: equipment.i,
        have: showoff && equipment.h === 1,
        note: showoff ? equipment.t : undefined,
      }),
    ),
    extras: (compact.x ?? []).map((extra) => ({
      id: newId(ID_PREFIX.extra),
      itemId: extra.i,
      qty: extra.q,
      haveQty: showoff ? (extra.h ?? 0) : 0,
    })),
    retired: showoff ? (compact.r ?? []).map((entry) => expandRetired(entry, at)) : [],
    custom: {
      frames: compact.u?.f ?? [],
      items: compact.u?.i ?? [],
      devices: compact.u?.d ?? [],
      hardware: compact.u?.h ?? [],
    },
  })
}

// ---------------------------------------------------------------------------------------------
// Bytes and streams

function streamOf(bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** Reads a whole stream, stopping as soon as it grows past `maxBytes`. */
async function readCapped(
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new ShareLinkError(
        'too-large',
        `This share link expands to more than ${maxBytes / 1024} KB, so it was not opened.`,
      )
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

// ---------------------------------------------------------------------------------------------
// Decode steps; each throws a ShareLinkError with its reason.

/**
 * The payload of "p=1.…", "#p=1.…" or a whole …/view#p=1.… URL. Whitespace is ignored, so a link
 * wrapped across lines in an email still opens.
 */
function payloadOf(text: string): string {
  if (text.length > 2 * MAX_PAYLOAD_CHARS) {
    throw new ShareLinkError('too-large', 'This share link is too long to open.')
  }
  const hash = text.indexOf('#')
  const fragment = (hash >= 0 ? text.slice(hash + 1) : text).replace(/\s+/g, '')
  const match = LINK_PATTERN.exec(fragment)
  if (match === null) {
    throw new ShareLinkError('malformed', 'This is not a Mini Rack Planner share link.')
  }
  const version = Number(match[1])
  if (version > SHARE_CODEC_VERSION) {
    throw new ShareLinkError(
      'unsupported-version',
      `This link was made by a newer version of Mini Rack Planner (link format ${version}). Update the app to open it.`,
    )
  }
  if (version !== SHARE_CODEC_VERSION) {
    throw new ShareLinkError('malformed', 'This is not a Mini Rack Planner share link.')
  }
  const payload = match[2] ?? ''
  if (payload.length > MAX_PAYLOAD_CHARS) {
    throw new ShareLinkError('too-large', 'This share link is too long to open.')
  }
  return payload
}

function bytesOf(payload: string): Uint8Array<ArrayBuffer> {
  try {
    return decodeBase64Url(payload)
  } catch (error) {
    throw new ShareLinkError('malformed', DAMAGED, { cause: error })
  }
}

async function inflateJson(compressed: Uint8Array<ArrayBuffer>): Promise<unknown> {
  let bytes: Uint8Array<ArrayBuffer>
  try {
    const inflated = streamOf(compressed).pipeThrough(new DecompressionStream('deflate-raw'))
    bytes = await readCapped(inflated, MAX_SHARE_JSON_BYTES)
  } catch (error) {
    if (error instanceof ShareLinkError) throw error
    throw new ShareLinkError('corrupt', DAMAGED, { cause: error })
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw new ShareLinkError('corrupt', DAMAGED, { cause: error })
  }
}

function parseCompact(json: unknown): CompactPlan {
  const result = CompactPlanSchema.safeParse(json)
  if (!result.success) {
    throw new ShareLinkError('invalid', NOT_A_PLAN, { issues: toPlanIssues(result.error) })
  }
  return result.data
}

function validatePlan(doc: PlanDocument): { plan: Plan; warnings: string[] } {
  try {
    return migratePlan(doc)
  } catch (error) {
    if (error instanceof PlanTooNewError) {
      throw new ShareLinkError('unsupported-version', error.message, { cause: error })
    }
    const issues = error instanceof PlanInvalidError ? error.issues : []
    // Anything else (e.g. a stack overflow on absurdly nested custom entries) is a bad link too.
    throw new ShareLinkError('invalid', NOT_A_PLAN, { cause: error, issues })
  }
}

/** One warning per catalog id the catalog (and the plan's custom entries) does not know. */
function unknownEntryWarnings(plan: Plan, catalog: CatalogLookup): string[] {
  const lookup = withCustomEntries(catalog, plan.custom)
  const unknown = new Map<string, string>()
  const check = (id: string, what: string, known: boolean): void => {
    if (!known && !unknown.has(id)) unknown.set(id, what)
  }
  check(plan.frame.frameId, 'frame', lookup.frame(plan.frame.frameId) !== undefined)
  const item = (id: string): void => check(id, 'part', lookup.item(id) !== undefined)
  const device = (id: string): void => check(id, 'device', lookup.device(id) !== undefined)
  for (const placement of plan.placements) {
    item(placement.itemId)
    for (const placed of placement.devices) device(placed.deviceId)
  }
  for (const equipment of plan.equipment) device(equipment.deviceId)
  for (const extra of plan.extras) item(extra.itemId)
  for (const entry of plan.retired) {
    if (entry.snapshot.itemId !== undefined) item(entry.snapshot.itemId)
    for (const id of entry.devices ?? []) device(id)
  }
  return [...unknown].map(
    ([id, what]) => `Unknown ${what} "${id}": kept as a labelled placeholder.`,
  )
}

// ---------------------------------------------------------------------------------------------
// Public API

export interface DecodedShare {
  plan: Plan
  mode: ShareMode
  /** Plain-language notes for the viewer (migrations, unknown catalog entries). */
  warnings: string[]
}

export interface DecodeShareOptions {
  /** Shared catalog: unknown frame/part/device ids then produce warnings (they are kept anyway). */
  catalog?: CatalogLookup
  /** Time stamped on the decoded plan and its Have snapshots; defaults to now. */
  now?: Date
}

/**
 * Encodes a plan as a share link fragment ("p=1.…"); see `shareUrl` for the full link.
 * @throws ShareLinkError ('too-large') when the plan is over the size a link may carry.
 */
export async function encodeShare(plan: Plan, mode: ShareMode): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(compactPlan(plan, mode)))
  if (json.byteLength > MAX_SHARE_JSON_BYTES) {
    throw new ShareLinkError(
      'too-large',
      'This plan is too large for a share link. Export it as a file instead.',
    )
  }
  const compressed = streamOf(json).pipeThrough(new CompressionStream('deflate-raw'))
  const bytes = await readCapped(compressed, Number.POSITIVE_INFINITY)
  return `p=${SHARE_CODEC_VERSION}.${encodeBase64Url(bytes)}`
}

/**
 * Opens a share link: the fragment, a "#…" hash or a whole URL. Ids and timestamps are new.
 * @throws ShareLinkError with a `reason` for anything that is not a valid link.
 */
export async function decodeShare(
  text: string,
  options: DecodeShareOptions = {},
): Promise<DecodedShare> {
  const compressed = bytesOf(payloadOf(text))
  const compact = parseCompact(await inflateJson(compressed))
  const at = (options.now ?? new Date()).toISOString()
  const { plan, warnings } = validatePlan(expandPlan(compact, at))
  if (options.catalog !== undefined) warnings.push(...unknownEntryWarnings(plan, options.catalog))
  return { plan, mode: compact.m === 1 ? 'showoff' : 'template', warnings }
}

/** The read-only viewer link: `<origin>/view#p=1.…`. */
export function shareUrl(origin: string, encoded: string): string {
  return `${origin.replace(/\/+$/, '')}/view#${encoded}`
}
