/**
 * "Removed but owned" (`plan.retired`, M3b): parts that left the plan but that the user still has
 * (an owned placement that was deleted, a retired section, owned accessories taken out). The BOM
 * counts them as built until the user decides what happens to them:
 * - Reuse: back into the plan, still owned. A placement goes back at a free spot with its Have
 *   snapshot and the owned devices that came off with it (`reuseRetiredPlacement`; `reuseSpots`
 *   and `firstReuseSpot` say where it fits), a section on top or at the bottom of the stack
 *   (`reuseRetiredSection`), accessories back on their line (`reuseRetiredExtra`).
 * - Keep as spare (`keepAsSpare`): it leaves the plan and its parts become loose spares in the
 *   global inventory. The inventory is not part of the plan, so the caller adds them:
 *   `retiredSpares` lists them by BOM line key, `sparesFreed` works them out from two BOMs.
 * - Discard (`discardRetired`): it leaves the plan and nothing is kept (sold, given away, broken).
 *
 * Pure: inputs are never mutated. Refused edits return the input plan with a user-facing `error`
 * (the `StackOpResult` contract). Lookups get the plan's own entries layered on.
 */
import type { BomLineKind, BomResult, BomUnit, StackOpResult } from './api'
import { computeBom } from './bom'
import { assignDevice } from './devices'
import { insertSection, totalHeightSixths, type StackEnd } from './frame'
import { formatU, phaseOf, SIXTHS_PER_U, uNumberAt, uToSixths } from './geometry'
import { ID_PREFIX, newId } from './ids'
import {
  allowedPhases,
  canPlace,
  resolvePlaceable,
  type FreeSpot,
  type Placeable,
  type PlaceReason,
} from './placement'
import {
  deviceName,
  withCustomEntries,
  type Bay,
  type CatalogLookup,
  type Frame,
  type SectionType,
} from './schema/catalog'
import type { Face, OptionValues } from './schema/common'
import type {
  PlacedDevice,
  Placement,
  PlacementBay,
  PlanEquipment,
  Plan,
  RetiredEntry,
  RetiredKind,
} from './schema/plan'
import type { Settings } from './schema/settings'

/** How Reuse puts a removed part back into the plan. */
export type ReuseKind = 'placement' | 'section' | 'extra'

/** A "Removed but owned" entry as the editor lists it. */
export interface RetiredView {
  id: string
  kind: RetiredKind
  /** The catalog id it was (parts and accessories). */
  itemId?: string
  /** What it is: "Lenovo Tiny mount", "3U section", "Top of the rack", "Rubber feet". */
  name: string
  /** Owned devices that came off with a placement, by name. */
  devices: string[]
  /** How many (accessories). */
  qty?: number
  /** When it left the plan (ISO date-time). */
  at: string
  /** How Reuse puts it back; undefined when it cannot go back (`reuseNote` says why). */
  reuse?: ReuseKind
  reuseNote?: string
}

/** A removed-part edit: the `StackOpResult` contract plus where a reused part went. */
export interface RetiredOpResult extends StackOpResult {
  placementId?: string
  sectionId?: string
  extraId?: string
}

/** A loose spare a removed part becomes (Keep as spare). */
export interface RetiredSpare {
  /** BOM line key, which is also the inventory key. */
  key: string
  kind: BomLineKind
  label: string
  qty: number
  unit: BomUnit
}

function failed(plan: Plan, error: string): RetiredOpResult {
  return { plan, conflicts: [], error }
}

function missingText(retiredId: string): string {
  return `There is no removed part "${retiredId}" in this plan.`
}

function withoutEntry(plan: Plan, retiredId: string): Plan {
  return { ...plan, retired: plan.retired.filter((entry) => entry.id !== retiredId) }
}

const FRAME_NOTE = 'This plan’s frame is not in your catalog, so nothing can go back on the rack.'

// ---------------------------------------------------------------------------------------------
// Listing

/** The plan's removed-but-owned entries, in plan order, named for the editor. */
export function listRetired(plan: Plan, catalog: CatalogLookup): RetiredView[] {
  const lookup = withCustomEntries(catalog, plan.custom)
  const frame = lookup.frame(plan.frame.frameId)
  return plan.retired.map((entry) => retiredView(entry, lookup, frame))
}

type ViewDetails = Pick<RetiredView, 'name' | 'reuse' | 'reuseNote'> &
  Partial<Pick<RetiredView, 'devices' | 'qty'>>

function retiredView(
  entry: RetiredEntry,
  lookup: CatalogLookup,
  frame: Frame | undefined,
): RetiredView {
  const details = detailsOf(entry, lookup, frame)
  const { itemId } = entry.snapshot
  return {
    id: entry.id,
    kind: entry.kind,
    ...(itemId === undefined ? {} : { itemId }),
    at: entry.snapshot.at,
    ...details,
    devices: details.devices ?? [],
  }
}

function detailsOf(
  entry: RetiredEntry,
  lookup: CatalogLookup,
  frame: Frame | undefined,
): ViewDetails {
  switch (entry.kind) {
    case 'placement':
      return placementDetails(entry, lookup, frame)
    case 'section':
      return sectionDetails(entry, frame)
    case 'extra':
      return extraDetails(entry, lookup)
    case 'cap':
      return {
        name: capName(entry.sourceId),
        reuseNote: 'Every rack has its top and bottom: change them under Options instead.',
      }
  }
}

function placementDetails(
  entry: RetiredEntry,
  lookup: CatalogLookup,
  frame: Frame | undefined,
): ViewDetails {
  const itemId = entry.snapshot.itemId
  const placeable = itemId === undefined ? undefined : resolvePlaceable(lookup, itemId)
  const devices = (entry.devices ?? []).map((deviceId) => {
    const device = lookup.device(deviceId)
    return device === undefined ? `"${deviceId}"` : deviceName(device)
  })
  if (placeable === undefined) {
    return {
      name: itemId === undefined ? 'A removed part' : `Unknown part "${itemId}"`,
      devices,
      reuseNote: 'It is not in your catalog any more, so it cannot go back on the rack.',
    }
  }
  if (frame === undefined) return { name: placeable.name, devices, reuseNote: FRAME_NOTE }
  return { name: placeable.name, devices, reuse: 'placement' }
}

/** "3U section", "Rack (8U)" for a type with a height range, "4U section" for an unknown type. */
function sectionName(
  type: SectionType | undefined,
  typeId: string | undefined,
  heightU: number | undefined,
): string {
  const height = heightU === undefined ? undefined : formatU(uToSixths(heightU))
  if (type !== undefined) {
    return typeof type.heightU === 'number' || height === undefined
      ? type.label
      : `${type.label} (${height})`
  }
  if (height !== undefined) return `${height} section`
  return typeId === undefined ? 'A removed section' : `Section "${typeId}"`
}

function sectionDetails(entry: RetiredEntry, frame: Frame | undefined): ViewDetails {
  const typeId = entry.snapshot.typeId
  const type =
    typeId === undefined
      ? undefined
      : frame?.sectionTypes.find((candidate) => candidate.id === typeId)
  const fixedU = typeof type?.heightU === 'number' ? type.heightU : undefined
  const name = sectionName(type, typeId, entry.snapshot.heightU ?? fixedU)
  if (frame === undefined) return { name, reuseNote: FRAME_NOTE }
  if (type === undefined) {
    return {
      name,
      reuseNote: `${frame.name} has no section of this type any more, so it cannot go back into the stack.`,
    }
  }
  return { name, reuse: 'section' }
}

function extraDetails(entry: RetiredEntry, lookup: CatalogLookup): ViewDetails {
  const itemId = entry.snapshot.itemId
  const item = itemId === undefined ? undefined : lookup.item(itemId)
  const qty = entry.qty ?? 0
  const name =
    item?.name ?? (itemId === undefined ? 'Removed accessories' : `Unknown accessory "${itemId}"`)
  if (item?.kind !== 'extra') {
    return {
      name,
      qty,
      reuseNote:
        'It is not an accessory in your catalog any more, so it cannot go back on the list.',
    }
  }
  if (qty <= 0) return { name, qty, reuseNote: 'There are none left to put back.' }
  return { name, qty, reuse: 'extra' }
}

function capName(sourceId: string | undefined): string {
  if (sourceId === 'top') return 'Top of the rack'
  if (sourceId === 'bottom') return 'Bottom of the rack'
  return 'Top or bottom of the rack'
}

// ---------------------------------------------------------------------------------------------
// Reuse: a placement

export interface ReusePlacementOptions {
  /** Only this bay. Default: full width, or for half-width parts the left half, then the right. */
  bay?: PlacementBay
}

/** A removed placement resolved for going back: its part, frame and the devices it takes back. */
interface Restorable {
  lookup: CatalogLookup
  frame: Frame
  entry: RetiredEntry
  placeable: Placeable
  /** The new placement's id. */
  placementId: string
  /** The owned devices that came off with it, back in the slots that take them (all owned). */
  devices: PlacedDevice[]
  /** Owned devices no slot takes any more (the catalog changed): they go to Equipment to fit. */
  toTray: string[]
}

function restorable(plan: Plan, catalog: CatalogLookup, retiredId: string): Restorable | string {
  const lookup = withCustomEntries(catalog, plan.custom)
  const entry = plan.retired.find((candidate) => candidate.id === retiredId)
  if (entry === undefined) return missingText(retiredId)
  if (entry.kind !== 'placement') return 'Only parts that mount on the rails go back at a U.'
  const itemId = entry.snapshot.itemId
  if (itemId === undefined) {
    return 'What this part was is not recorded, so it cannot go back on the rack.'
  }
  const placeable = resolvePlaceable(lookup, itemId)
  if (placeable === undefined) {
    return `"${itemId}" is not in your catalog any more, so it cannot go back on the rack.`
  }
  const frame = lookup.frame(plan.frame.frameId)
  if (frame === undefined) {
    return `The frame "${plan.frame.frameId}" is not in your catalog, so nothing can be placed.`
  }
  const placementId = newId(ID_PREFIX.placement)
  const owned = ownedDevicesIn(plan, lookup, placeable, placementId, entry.devices ?? [])
  return { lookup, frame, entry, placeable, placementId, ...owned }
}

/**
 * The owned devices back in the part's slots, each in the first slot that accepts and fits it
 * (`assignDevice`: one device per fixed slot, area slots packed in this order).
 */
function ownedDevicesIn(
  plan: Plan,
  lookup: CatalogLookup,
  placeable: Placeable,
  placementId: string,
  deviceIds: readonly string[],
): { devices: PlacedDevice[]; toTray: string[] } {
  if (deviceIds.length === 0) return { devices: [], toTray: [] }
  const shell: Placement = {
    id: placementId,
    itemId: placeable.id,
    y: 0,
    face: placeable.faces[0] ?? 'front',
    bay: 'full',
    devices: [],
  }
  // Slots do not depend on where the part sits: fill them on a scratch copy holding it alone.
  let scratch: Plan = { ...plan, placements: [shell] }
  const toTray: string[] = []
  for (const deviceId of deviceIds) {
    let placed = false
    for (const slot of placeable.slots) {
      const result = assignDevice(scratch, lookup, placementId, slot.id, deviceId, true)
      if (result.error !== undefined) continue
      scratch = result.plan
      placed = true
      break
    }
    if (!placed) toTray.push(deviceId)
  }
  return { devices: scratch.placements[0]?.devices ?? [], toTray }
}

function baysFor(bay: Bay): PlacementBay[] {
  return bay === 'half' ? ['left', 'right'] : ['full']
}

/** "U3", or "U3 + ½U" for a start inside a U. */
function positionLabel(y: number): string {
  const phase = phaseOf(y)
  return `U${uNumberAt(y)}${phase === 0 ? '' : ` + ${formatU(phase)}`}`
}

/** Free spots for the restored part (its devices counted), bottom to top, faces in its order. */
function spotsFor(
  plan: Plan,
  restore: Restorable,
  face: Face | undefined,
  limit: number,
): FreeSpot[] {
  const { placeable, frame, lookup, devices } = restore
  const faces =
    face === undefined ? placeable.faces : placeable.faces.filter((candidate) => candidate === face)
  const top = totalHeightSixths(plan, frame)
  const { phases } = allowedPhases(placeable, frame)
  const spots: FreeSpot[] = []
  for (const candidateFace of faces) {
    for (let base = 0; base < top; base += SIXTHS_PER_U) {
      for (const phase of phases) {
        const y = base + phase
        if (y + placeable.heightSixths > top) continue
        for (const bay of baysFor(placeable.bay)) {
          const at = { itemId: placeable.id, y, face: candidateFace, bay, devices }
          if (!canPlace(plan, lookup, frame, at).ok) continue
          spots.push({ y, face: candidateFace, bay })
          if (spots.length >= limit) return spots
        }
      }
    }
  }
  return spots
}

/**
 * Every spot where a removed placement can go back (with the devices it takes back), bottom to
 * top, on `face` or on each face it mounts on. Empty when it cannot go back at all.
 */
export function reuseSpots(
  plan: Plan,
  catalog: CatalogLookup,
  retiredId: string,
  face?: Face,
): FreeSpot[] {
  const restore = restorable(plan, catalog, retiredId)
  return typeof restore === 'string' ? [] : spotsFor(plan, restore, face, Number.POSITIVE_INFINITY)
}

/** The lowest free spot for a removed placement (on the first face it mounts on with room). */
export function firstReuseSpot(
  plan: Plan,
  catalog: CatalogLookup,
  retiredId: string,
): FreeSpot | undefined {
  const restore = restorable(plan, catalog, retiredId)
  return typeof restore === 'string' ? undefined : spotsFor(plan, restore, undefined, 1)[0]
}

function restoredAt(plan: Plan, restore: Restorable, spot: FreeSpot): Plan {
  const { entry, placeable } = restore
  const options = entry.snapshot.options
  const placement: Placement = {
    id: restore.placementId,
    itemId: placeable.id,
    name: placeable.name,
    heightSixths: placeable.heightSixths,
    y: spot.y,
    face: spot.face,
    bay: spot.bay,
    // Planned as it was built, so it is not on the shopping list again.
    ...(Object.keys(options).length === 0 ? {} : { options: { ...options } }),
    have: { ...entry.snapshot, itemId: placeable.id, options: { ...options } },
    devices: restore.devices,
  }
  const tray: PlanEquipment[] = restore.toTray.map((deviceId) => ({
    id: newId(ID_PREFIX.equipment),
    deviceId,
    have: true,
  }))
  const next = withoutEntry(plan, entry.id)
  return {
    ...next,
    placements: [...next.placements, placement],
    equipment: tray.length === 0 ? next.equipment : [...next.equipment, ...tray],
  }
}

/**
 * Puts a removed placement back at `y` on `face`, still owned: its Have snapshot (planned with
 * the options it was built with) and the owned devices that came off with it, each in the first
 * slot that takes it (a device no slot takes any more goes to Equipment to fit, owned). The spot
 * must be free (`canPlace`, devices counted); half-width parts try the left half, then the right,
 * unless `options.bay` names one. On success `placementId` is the new placement.
 */
export function reuseRetiredPlacement(
  plan: Plan,
  catalog: CatalogLookup,
  retiredId: string,
  y: number,
  face: Face,
  options: ReusePlacementOptions = {},
): RetiredOpResult {
  const restore = restorable(plan, catalog, retiredId)
  if (typeof restore === 'string') return failed(plan, restore)
  const { placeable, lookup, frame, devices } = restore
  const bays = options.bay === undefined ? baysFor(placeable.bay) : [options.bay]
  let firstReasons: PlaceReason[] | undefined
  for (const bay of bays) {
    const check = canPlace(plan, lookup, frame, { itemId: placeable.id, y, face, bay, devices })
    if (check.ok) {
      return {
        plan: restoredAt(plan, restore, { y, face, bay }),
        conflicts: [],
        placementId: restore.placementId,
      }
    }
    firstReasons ??= check.reasons
  }
  const why = (firstReasons ?? []).map((reason) => reason.message).join(' ')
  return failed(
    plan,
    `${placeable.name} cannot go back at ${positionLabel(y)} on the ${face}. ${why}`.trim(),
  )
}

// ---------------------------------------------------------------------------------------------
// Reuse: a section or accessories

/** The section-scoped values among a snapshot's resolved options. */
function sectionOptionsOf(frame: Frame, options: OptionValues): OptionValues {
  const scoped = new Set(
    frame.options.filter((option) => option.scope === 'section').map((option) => option.id),
  )
  return Object.fromEntries(Object.entries(options).filter(([key]) => scoped.has(key)))
}

/**
 * Puts a removed section back into the stack, on top or at the bottom (what is above moves up
 * with its sections), still owned: its snapshot (type, height, options) comes back, and the
 * section is planned as it was built. Refused past the frame's height limit (`conflicts` say so).
 */
export function reuseRetiredSection(
  plan: Plan,
  catalog: CatalogLookup,
  retiredId: string,
  at: StackEnd,
): RetiredOpResult {
  const lookup = withCustomEntries(catalog, plan.custom)
  const entry = plan.retired.find((candidate) => candidate.id === retiredId)
  if (entry === undefined) return failed(plan, missingText(retiredId))
  if (entry.kind !== 'section') return failed(plan, 'Only sections go back into the stack.')
  const frame = lookup.frame(plan.frame.frameId)
  if (frame === undefined) {
    return failed(plan, `The frame "${plan.frame.frameId}" is not in your catalog.`)
  }
  const typeId = entry.snapshot.typeId
  const type = frame.sectionTypes.find((candidate) => candidate.id === typeId)
  if (typeId === undefined || type === undefined) {
    return failed(
      plan,
      `${frame.name} has no section of this type any more, so it cannot go back into the stack.`,
    )
  }
  const sectionId = newId(ID_PREFIX.section)
  const options = sectionOptionsOf(frame, entry.snapshot.options)
  const heightU = typeof type.heightU === 'number' ? undefined : entry.snapshot.heightU
  const inserted = insertSection(
    plan,
    frame,
    at === 'top' ? plan.frame.sections.length : 0,
    typeId,
    {
      id: sectionId,
      catalog: lookup,
      ...(heightU === undefined ? {} : { heightU }),
      ...(Object.keys(options).length === 0 ? {} : { options }),
    },
  )
  if (inserted.error !== undefined || inserted.conflicts.length > 0) {
    return { plan, conflicts: inserted.conflicts, error: inserted.error ?? 'It does not fit.' }
  }
  const next = withoutEntry(inserted.plan, entry.id)
  const sections = next.frame.sections.map((section) =>
    section.id === sectionId ? { ...section, have: { ...entry.snapshot } } : section,
  )
  return { plan: { ...next, frame: { ...next.frame, sections } }, conflicts: [], sectionId }
}

/**
 * Puts removed accessories back on their line, owned: they first cover what the plan still has
 * to get (the planned quantity stays), the rest are added to it.
 */
export function reuseRetiredExtra(plan: Plan, retiredId: string): RetiredOpResult {
  const entry = plan.retired.find((candidate) => candidate.id === retiredId)
  if (entry === undefined) return failed(plan, missingText(retiredId))
  if (entry.kind !== 'extra') return failed(plan, 'Only accessories go back on the list.')
  const itemId = entry.snapshot.itemId
  const count = entry.qty ?? 0
  if (itemId === undefined || count <= 0) {
    return failed(plan, 'There are no accessories to put back.')
  }
  const next = withoutEntry(plan, entry.id)
  const index = next.extras.findIndex((extra) => extra.itemId === itemId)
  const existing = next.extras[index]
  if (existing !== undefined) {
    const toGet = Math.max(0, existing.qty - existing.haveQty)
    const updated = {
      ...existing,
      qty: existing.qty + Math.max(0, count - toGet),
      haveQty: existing.haveQty + count,
    }
    return {
      plan: { ...next, extras: next.extras.with(index, updated) },
      conflicts: [],
      extraId: existing.id,
    }
  }
  const extra = { id: newId(ID_PREFIX.extra), itemId, qty: count, haveQty: count }
  return { plan: { ...next, extras: [...next.extras, extra] }, conflicts: [], extraId: extra.id }
}

// ---------------------------------------------------------------------------------------------
// Keep as spare, discard

function dropped(plan: Plan, retiredId: string): RetiredOpResult {
  if (!plan.retired.some((entry) => entry.id === retiredId)) {
    return failed(plan, missingText(retiredId))
  }
  return { plan: withoutEntry(plan, retiredId), conflicts: [] }
}

/**
 * Keep as spare: the part leaves the plan (the BOM no longer counts it as built here). Its parts
 * become loose spares, which the caller adds to the inventory (`retiredSpares`): the inventory is
 * global, not part of the plan.
 */
export function keepAsSpare(plan: Plan, retiredId: string): RetiredOpResult {
  return dropped(plan, retiredId)
}

/** Discard: the part leaves the plan and nothing is kept (it was sold, given away or broke). */
export function discardRetired(plan: Plan, retiredId: string): RetiredOpResult {
  return dropped(plan, retiredId)
}

/**
 * Per BOM line key, how many owned parts leave the as-built between two BOMs: reusable lines
 * only (hardware embedded in prints stays in them) and never accessories that ship with a device.
 * The inverse of `consumeInventory` (bom.ts): what Keep as spare adds to the inventory.
 */
export function sparesFreed(before: BomResult, after: BomResult): Record<string, number> {
  const builtAfter = new Map(after.lines.map((line) => [line.key, line.asBuilt]))
  const freed: Record<string, number> = {}
  for (const line of before.lines) {
    if (line.included === true || !line.reusable) continue
    const gone = line.asBuilt - (builtAfter.get(line.key) ?? 0)
    if (gone > 0) freed[line.key] = gone
  }
  return freed
}

/**
 * The loose spares a removed part becomes when it is kept as spare, as BOM lines (prints,
 * hardware, devices) in BOM order. Empty for an unknown id.
 */
export function retiredSpares(
  plan: Plan,
  catalog: CatalogLookup,
  retiredId: string,
  settings: Settings,
): RetiredSpare[] {
  const kept = keepAsSpare(plan, retiredId)
  if (kept.error !== undefined) return []
  const before = computeBom(plan, catalog, settings, {})
  const after = computeBom(kept.plan, catalog, settings, {})
  const freed = sparesFreed(before, after)
  return before.lines.flatMap((line) => {
    const qty = freed[line.key]
    return qty === undefined
      ? []
      : [{ key: line.key, kind: line.kind, label: line.label, qty, unit: line.unit }]
  })
}
