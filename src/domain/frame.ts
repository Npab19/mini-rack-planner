/**
 * Frame stack operations.
 *
 * A frame is a stack of sections (bottom -> top) that the user arranges: insert, remove, move,
 * split, merge, set a target height, retire and mark sections. Every operation is pure and returns
 * a `StackOpResult` whose plan changes sections and placements together, so callers commit it as
 * one undo step.
 *
 * Placements travel with the sections they are mounted on (`remap`):
 * - each section's content moves by that section's shift;
 * - a placement mounted across several sections moves only when they all shift alike (the joints
 *   under it stay intact); otherwise it is a `straddle` conflict;
 * - a placement on a section that goes away is a `section-not-empty` conflict.
 * Conflicts block an operation unless the caller's `PlacementPolicy` resolves them. A blocked or
 * invalid operation returns the input plan unchanged with `error` set (and `conflicts` saying why),
 * so `result.error === undefined` means the operation applied.
 *
 * Joint dead zones (`stack.joint.deadSixths`) are not enforced here: `canPlace` (placement.ts) and
 * the checks report placements inside them.
 */
import type { Issue, StackConflict, StackOpResult } from './api'
import { uToSixths } from './geometry'
import { ID_PREFIX, newId } from './ids'
import { resolveOptionValues, sectionHeightU, sectionLabel } from './recipe'
import {
  deviceName,
  withCustomEntries,
  type CatalogLookup,
  type Frame,
  type SectionType,
} from './schema/catalog'
import type { OptionValues } from './schema/common'
import type {
  PlacedDevice,
  Placement,
  Plan,
  PlanEquipment,
  PlanSection,
  RetiredEntry,
  Snapshot,
} from './schema/plan'

export type StackEnd = 'top' | 'bottom'

// ---------------------------------------------------------------------------------------------
// Stack geometry

/** Where one section sits in the stack: heights in U, positions in sixths from the bottom of U1. */
export interface SectionSpan {
  sectionId: string
  typeId: string
  /** 0 = bottom section. */
  index: number
  startSixths: number
  endSixths: number
  heightU: number
  /** Marked as in the user's rack (it has a Have snapshot). */
  have: boolean
}

/** Sections bottom -> top. Heights come from `sectionHeightU`, exactly as the BOM counts them. */
export function sectionSpans(plan: Plan, frame: Frame): SectionSpan[] {
  return spansOf(plan.frame.sections, frame)
}

export function totalHeightU(plan: Plan, frame: Frame): number {
  return sumHeightsU(sectionSpans(plan, frame))
}

/** Top of the stack in sixths (0 for an empty stack). */
export function totalHeightSixths(plan: Plan, frame: Frame): number {
  return topOf(sectionSpans(plan, frame))
}

/** A joint between two adjacent sections. */
export interface StackJoint {
  ySixths: number
  lowerId: string
  upperId: string
  /** Dead zone [deadY0, deadY1) where nothing can mount; empty when the frame has none. */
  deadY0: number
  deadY1: number
}

/**
 * Joints bottom -> top. The dead zone is `stack.joint.deadSixths` sixths centred on the joint line;
 * an odd count puts the extra sixth above it.
 */
export function stackJoints(plan: Plan, frame: Frame): StackJoint[] {
  const spans = sectionSpans(plan, frame)
  const dead = frame.stack.joint?.deadSixths ?? 0
  const below = Math.floor(dead / 2)
  const joints: StackJoint[] = []
  for (const [index, upper] of spans.entries()) {
    const lower = spans[index - 1]
    if (lower === undefined) continue
    const y = upper.startSixths
    joints.push({
      ySixths: y,
      lowerId: lower.sectionId,
      upperId: upper.sectionId,
      deadY0: y - below,
      deadY1: y - below + dead,
    })
  }
  return joints
}

function spansOf(sections: readonly PlanSection[], frame: Frame): SectionSpan[] {
  const spans: SectionSpan[] = []
  let start = 0
  for (const [index, section] of sections.entries()) {
    const heightU = sectionHeightU(frame, section.typeId, section.heightU)
    const end = start + uToSixths(heightU)
    spans.push({
      sectionId: section.id,
      typeId: section.typeId,
      index,
      startSixths: start,
      endSixths: end,
      heightU,
      have: section.have !== undefined,
    })
    start = end
  }
  return spans
}

function topOf(spans: readonly SectionSpan[]): number {
  return spans.at(-1)?.endSixths ?? 0
}

function sumHeightsU(spans: ReadonlyArray<{ heightU: number }>): number {
  return spans.reduce((total, span) => total + span.heightU, 0)
}

// ---------------------------------------------------------------------------------------------
// Placements on the stack

/**
 * Height of a placement in sixths: the catalog's (an item, or ear-mounted gear placed directly
 * via `device.rackmount`), else the plan's denormalized copy, else 0.
 */
export function placementHeightSixths(placement: Placement, catalog?: CatalogLookup): number {
  const item = catalog?.item(placement.itemId)
  if (item !== undefined) return item.heightSixths
  const rackmount = catalog?.device(placement.itemId)?.rackmount
  return rackmount?.heightSixths ?? placement.heightSixths ?? 0
}

/** The section that holds a placement's bottom edge, and the offset from that section's bottom. */
export interface PlacementAnchor {
  sectionId: string
  /** Negative below the stack; at least the section's height above it. */
  offsetSixths: number
}

/**
 * Anchor of a placement: the section containing its bottom `y`. Out-of-rack positions anchor to
 * the nearest end section. Undefined for an empty stack.
 */
export function placementAnchor(
  plan: Plan,
  frame: Frame,
  placement: Pick<Placement, 'y'>,
): PlacementAnchor | undefined {
  const spans = sectionSpans(plan, frame)
  const inside = spans.find(
    (span) => placement.y >= span.startSixths && placement.y < span.endSixths,
  )
  const span = inside ?? (placement.y < 0 ? spans[0] : spans.at(-1))
  if (span === undefined) return undefined
  return { sectionId: span.sectionId, offsetSixths: placement.y - span.startSixths }
}

/** Placements mounted at least partly on a section (zero-height placeholders count at their y). */
export function placementsInSection(
  plan: Plan,
  frame: Frame,
  sectionId: string,
  catalog?: CatalogLookup,
): Placement[] {
  const span = sectionSpans(plan, frame).find((candidate) => candidate.sectionId === sectionId)
  return span === undefined ? [] : occupantsOf(plan, span, lookupFor(plan, catalog))
}

interface Probe {
  y0: number
  y1: number
}

function probeOf(placement: Placement, catalog: CatalogLookup | undefined): Probe {
  const height = placementHeightSixths(placement, catalog)
  return { y0: placement.y, y1: placement.y + Math.max(height, 1) }
}

function occupantsOf(
  plan: Plan,
  span: SectionSpan,
  catalog: CatalogLookup | undefined,
): Placement[] {
  return plan.placements.filter((placement) => {
    const probe = probeOf(placement, catalog)
    return probe.y0 < span.endSixths && probe.y1 > span.startSixths
  })
}

function lookupFor(plan: Plan, catalog: CatalogLookup | undefined): CatalogLookup | undefined {
  return catalog === undefined ? undefined : withCustomEntries(catalog, plan.custom)
}

// ---------------------------------------------------------------------------------------------
// Removing placements (shared with placement.ts)

export interface RemovePlacementsOptions {
  /** Stamped on retired entries as the time they left the rack; default: the Have snapshot's time. */
  at?: string
  /**
   * Planned (Need) devices on removed placements go back to the equipment tray (default) or are
   * dropped. Owned devices are never dropped: they retire with an owned mount or go to the tray.
   */
  needDevices?: 'tray' | 'drop'
}

/**
 * Removes placements. An owned (Have) placement becomes a `retired` entry with its snapshot and the
 * catalog ids of the owned devices on it. Every other device goes to the equipment tray (see
 * `needDevices`), so nothing the user owns silently disappears.
 */
export function removePlacements(
  plan: Plan,
  placementIds: Iterable<string>,
  options: RemovePlacementsOptions = {},
): Plan {
  const ids = new Set(placementIds)
  const removed = plan.placements.filter((placement) => ids.has(placement.id))
  if (removed.length === 0) return plan
  const retired: RetiredEntry[] = []
  const tray: PlanEquipment[] = []
  for (const placement of removed) {
    const owned = placement.devices.filter((device) => device.have)
    const planned = placement.devices.filter((device) => !device.have)
    if (placement.have === undefined) {
      tray.push(...owned.map(trayEntry))
    } else {
      retired.push(retiredPlacement(placement, placement.have, owned, options.at))
    }
    if (options.needDevices !== 'drop') tray.push(...planned.map(trayEntry))
  }
  return {
    ...plan,
    placements: plan.placements.filter((placement) => !ids.has(placement.id)),
    retired: retired.length > 0 ? [...plan.retired, ...retired] : plan.retired,
    equipment: tray.length > 0 ? [...plan.equipment, ...tray] : plan.equipment,
  }
}

function retiredPlacement(
  placement: Placement,
  have: Snapshot,
  owned: readonly PlacedDevice[],
  at: string | undefined,
): RetiredEntry {
  return {
    id: newId(ID_PREFIX.retired),
    kind: 'placement',
    snapshot: {
      ...have,
      itemId: have.itemId ?? placement.itemId,
      ...(at === undefined ? {} : { at }),
    },
    sourceId: placement.id,
    ...(owned.length > 0 ? { devices: owned.map((device) => device.deviceId) } : {}),
  }
}

function trayEntry(device: PlacedDevice): PlanEquipment {
  return { id: newId(ID_PREFIX.equipment), deviceId: device.deviceId, have: device.have }
}

// ---------------------------------------------------------------------------------------------
// Results and messages

function applied(plan: Plan): StackOpResult {
  return { plan, conflicts: [] }
}

function failed(plan: Plan, error: string): StackOpResult {
  return { plan, conflicts: [], error }
}

function blocked(plan: Plan, conflicts: StackConflict[]): StackOpResult {
  return { plan, conflicts, error: conflicts.map((conflict) => conflict.message).join(' ') }
}

function spanLabel(span: Pick<SectionSpan, 'index' | 'heightU'>): string {
  return sectionLabel(span.index, span.heightU)
}

/**
 * What to call a placement in messages: the user's label, else the catalog name (an item, or
 * ear-mounted gear), else the name stored with the placement (unknown ids), else its item id.
 */
export function placementName(placement: Placement, catalog?: CatalogLookup): string {
  const device = catalog?.device(placement.itemId)
  return (
    placement.label ??
    catalog?.item(placement.itemId)?.name ??
    (device === undefined ? undefined : deviceName(device)) ??
    placement.name ??
    placement.itemId
  )
}

/** "A", "A and B", "A, B and C". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`
}

function sectionNotFound(plan: Plan, sectionId: string): StackOpResult {
  return failed(plan, `There is no section "${sectionId}" in this rack.`)
}

function notEmptyConflict(
  span: SectionSpan,
  occupants: readonly Placement[],
  catalog: CatalogLookup | undefined,
): StackConflict {
  const names = occupants.map((placement) => placementName(placement, catalog))
  return {
    kind: 'section-not-empty',
    message: `${spanLabel(span)} still holds ${listNames(names)}.`,
    placementIds: occupants.map((placement) => placement.id),
    sectionIds: [span.sectionId],
  }
}

function haveLocked(spans: readonly SectionSpan[], action: string): StackConflict {
  const labels = spans.map(spanLabel)
  const verb = spans.length === 1 ? 'is' : 'are'
  return {
    kind: 'have-locked',
    message: `${listNames(labels)} ${verb} in your rack, so ${action}.`,
    sectionIds: spans.map((span) => span.sectionId),
  }
}

function withSections(plan: Plan, sections: PlanSection[]): Plan {
  return { ...plan, frame: { ...plan.frame, sections } }
}

// ---------------------------------------------------------------------------------------------
// Remap

export type StraddlePolicy = 'block' | 'lower' | 'upper'
export type OrphanPolicy = 'block' | 'keep' | 'delete'

/** How an operation treats placements it cannot carry along rigidly. Everything blocks by default. */
export interface PlacementPolicy {
  /** Resolves placement heights and names; without it the plan's denormalized copies are used. */
  catalog?: CatalogLookup
  /**
   * A placement across a joint that changes: block (default), or move it with the lowest
   * ('lower') or highest ('upper') section it is mounted on.
   */
  straddle?: StraddlePolicy
  /**
   * A placement on a section that goes away: block (default), keep it at its y (checks then flag
   * it), or delete it (owned ones are retired, see `removePlacements`).
   */
  orphans?: OrphanPolicy
}

/** Consecutive old sections replaced by consecutive new ones (split, merge, a new planned run). */
export interface SectionReplacement {
  from: readonly string[]
  to: readonly string[]
  /**
   * The end of the run whose content stays put: 'start' keeps offsets from the run's bottom
   * (default), 'end' from its top. Content beyond the new run's height is lost.
   */
  align?: 'start' | 'end'
}

export interface RemapOptions extends PlacementPolicy {
  replacements?: readonly SectionReplacement[]
}

/** Where an old section's content goes: old positions in [keepFrom, keepTo) move by `delta`. */
interface SectionShift {
  delta: number
  keepFrom: number
  keepTo: number
}

type Projection =
  | { kind: 'moved'; y: number }
  | { kind: 'orphan'; lostSectionIds: string[] }
  | { kind: 'straddle'; lowerDelta: number; upperDelta: number; sectionIds: string[] }

/**
 * Re-projects every placement of `oldPlan` onto `newSections` (bottom -> top) and returns the plan
 * with both changed. Sections are matched by id; `replacements` map runs of sections that were
 * rebuilt (their content keeps its offset within the run). A placement that sits entirely beyond
 * an end of the stack keeps its distance to that end.
 */
export function remap(
  oldPlan: Plan,
  newSections: readonly PlanSection[],
  frame: Frame,
  options: RemapOptions = {},
): StackOpResult {
  const duplicate = firstDuplicate(newSections.map((section) => section.id))
  if (duplicate !== undefined) return failed(oldPlan, `Section id "${duplicate}" is used twice.`)
  const oldSpans = sectionSpans(oldPlan, frame)
  const newSpans = spansOf(newSections, frame)
  const shifts = sectionShifts(oldSpans, newSpans, options.replacements ?? [])
  if (typeof shifts === 'string') return failed(oldPlan, shifts)
  const catalog = lookupFor(oldPlan, options.catalog)
  const oldTop = topOf(oldSpans)
  const newTop = topOf(newSpans)

  const moved = new Map<string, number>()
  const deleted: string[] = []
  const orphans = new Map<string, string[]>()
  const straddles: StackConflict[] = []
  for (const placement of oldPlan.placements) {
    // Nothing to anchor to in an empty stack: placements stay where they are.
    const projection: Projection =
      oldSpans.length === 0
        ? { kind: 'moved', y: placement.y }
        : project(placement.y, probeOf(placement, catalog), oldSpans, oldTop, newTop, shifts)
    if (projection.kind === 'moved') {
      moved.set(placement.id, projection.y)
    } else if (projection.kind === 'orphan') {
      const policy = options.orphans ?? 'block'
      if (policy === 'delete') deleted.push(placement.id)
      if (policy !== 'block') continue // 'keep' leaves it at its y
      for (const sectionId of projection.lostSectionIds) {
        orphans.set(sectionId, [...(orphans.get(sectionId) ?? []), placement.id])
      }
    } else if (options.straddle === 'lower' || options.straddle === 'upper') {
      const delta = options.straddle === 'lower' ? projection.lowerDelta : projection.upperDelta
      moved.set(placement.id, placement.y + delta)
    } else {
      straddles.push(straddleConflict(placement, projection.sectionIds, oldSpans, catalog))
    }
  }

  const conflicts = [...orphanConflicts(orphans, oldSpans, oldPlan, catalog), ...straddles]
  if (conflicts.length > 0) return blocked(oldPlan, conflicts)
  const placements = oldPlan.placements.map((placement) => {
    const y = moved.get(placement.id)
    return y === undefined || y === placement.y ? placement : { ...placement, y }
  })
  const next: Plan = { ...withSections(oldPlan, [...newSections]), placements }
  return applied(removePlacements(next, deleted))
}

function project(
  y: number,
  probe: Probe,
  oldSpans: readonly SectionSpan[],
  oldTop: number,
  newTop: number,
  shifts: ReadonlyMap<string, SectionShift>,
): Projection {
  const lo = Math.max(probe.y0, 0)
  const hi = Math.min(probe.y1, oldTop)
  if (lo >= hi) return { kind: 'moved', y: y >= oldTop ? y + newTop - oldTop : y }
  const lost: string[] = []
  const deltas: number[] = []
  const sectionIds: string[] = []
  for (const span of oldSpans) {
    const from = Math.max(lo, span.startSixths)
    const to = Math.min(hi, span.endSixths)
    if (from >= to) continue
    sectionIds.push(span.sectionId)
    const shift = shifts.get(span.sectionId)
    if (shift === undefined || from < shift.keepFrom || to > shift.keepTo) {
      lost.push(span.sectionId)
    } else {
      deltas.push(shift.delta)
    }
  }
  if (lost.length > 0) return { kind: 'orphan', lostSectionIds: lost }
  const lowerDelta = deltas[0] ?? 0
  const upperDelta = deltas.at(-1) ?? lowerDelta
  if (deltas.every((delta) => delta === lowerDelta)) return { kind: 'moved', y: y + lowerDelta }
  return { kind: 'straddle', lowerDelta, upperDelta, sectionIds }
}

function sectionShifts(
  oldSpans: readonly SectionSpan[],
  newSpans: readonly SectionSpan[],
  replacements: readonly SectionReplacement[],
): Map<string, SectionShift> | string {
  const shifts = new Map<string, SectionShift>()
  const replaced = new Set<string>()
  for (const replacement of replacements) {
    const from = runOf(oldSpans, replacement.from)
    const to = runOf(newSpans, replacement.to)
    if (from === undefined || to === undefined) {
      return 'A replacement must name consecutive sections of the old and the new stack.'
    }
    for (const span of from) replaced.add(span.sectionId)
    const oldFirst = from[0]
    const oldLast = from.at(-1)
    const newFirst = to[0]
    const newLast = to.at(-1)
    // A run replaced by nothing loses its content.
    if (!oldFirst || !oldLast || !newFirst || !newLast) continue
    const oldStart = oldFirst.startSixths
    const oldEnd = oldLast.endSixths
    const newHeight = newLast.endSixths - newFirst.startSixths
    const alignEnd = replacement.align === 'end'
    const shift: SectionShift = alignEnd
      ? {
          delta: newLast.endSixths - oldEnd,
          keepFrom: Math.max(oldStart, oldEnd - newHeight),
          keepTo: oldEnd,
        }
      : {
          delta: newFirst.startSixths - oldStart,
          keepFrom: oldStart,
          keepTo: Math.min(oldEnd, oldStart + newHeight),
        }
    for (const span of from) shifts.set(span.sectionId, shift)
  }
  for (const span of oldSpans) {
    if (replaced.has(span.sectionId)) continue
    const next = newSpans.find((candidate) => candidate.sectionId === span.sectionId)
    if (next === undefined) continue
    const keptHeight = Math.min(
      span.endSixths - span.startSixths,
      next.endSixths - next.startSixths,
    )
    shifts.set(span.sectionId, {
      delta: next.startSixths - span.startSixths,
      keepFrom: span.startSixths,
      keepTo: span.startSixths + keptHeight,
    })
  }
  return shifts
}

/** Spans for `ids` if they are consecutive bottom -> top in `spans`. */
function runOf(spans: readonly SectionSpan[], ids: readonly string[]): SectionSpan[] | undefined {
  const run: SectionSpan[] = []
  for (const id of ids) {
    const span = spans.find((candidate) => candidate.sectionId === id)
    const previous = run.at(-1)
    if (span === undefined) return undefined
    if (previous !== undefined && span.index !== previous.index + 1) return undefined
    run.push(span)
  }
  return run
}

function firstDuplicate(ids: readonly string[]): string | undefined {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) return id
    seen.add(id)
  }
  return undefined
}

function orphanConflicts(
  orphans: ReadonlyMap<string, string[]>,
  oldSpans: readonly SectionSpan[],
  plan: Plan,
  catalog: CatalogLookup | undefined,
): StackConflict[] {
  const conflicts: StackConflict[] = []
  for (const [sectionId, placementIds] of orphans) {
    const span = oldSpans.find((candidate) => candidate.sectionId === sectionId)
    const occupants = plan.placements.filter((placement) => placementIds.includes(placement.id))
    if (span !== undefined) conflicts.push(notEmptyConflict(span, occupants, catalog))
  }
  return conflicts
}

function straddleConflict(
  placement: Placement,
  sectionIds: readonly string[],
  oldSpans: readonly SectionSpan[],
  catalog: CatalogLookup | undefined,
): StackConflict {
  const labels = oldSpans.filter((span) => sectionIds.includes(span.sectionId)).map(spanLabel)
  return {
    kind: 'straddle',
    message: `${placementName(placement, catalog)} spans ${listNames(labels)}, which this change moves apart.`,
    placementIds: [placement.id],
    sectionIds: [...sectionIds],
  }
}

function policyOf(options: PlacementPolicy): PlacementPolicy {
  return { catalog: options.catalog, straddle: options.straddle, orphans: options.orphans }
}

// ---------------------------------------------------------------------------------------------
// Section types

/** A section type id, or a type with a chosen height (for types with a height range). */
export type SectionPart = string | { typeId: string; heightU?: number }

interface ResolvedPart {
  type: SectionType
  heightU: number
}

function findType(frame: Frame, typeId: string): SectionType | undefined {
  return frame.sectionTypes.find((type) => type.id === typeId)
}

function isRangeType(type: SectionType): boolean {
  return typeof type.heightU !== 'number'
}

function typeNames(frame: Frame): string {
  return listNames(frame.sectionTypes.map((type) => `"${type.id}"`))
}

/** Height of a section of `type`: fixed, or `requested` (default `fallback`, then the minimum). */
function heightForType(
  type: SectionType,
  requested: number | undefined,
  fallback?: number,
): number | string {
  if (typeof type.heightU === 'number') {
    if (requested !== undefined && requested !== type.heightU) {
      return `${type.label} is always ${type.heightU}U.`
    }
    return type.heightU
  }
  const { min, max } = type.heightU
  const heightU = requested ?? fallback ?? min
  if (!Number.isInteger(heightU) || heightU < min || heightU > max) {
    return `${type.label} can be ${min}U to ${max}U, not ${heightU}U.`
  }
  return heightU
}

function resolvePart(frame: Frame, part: SectionPart, fallback?: number): ResolvedPart | string {
  const typeId = typeof part === 'string' ? part : part.typeId
  const type = findType(frame, typeId)
  if (type === undefined) {
    return `${frame.name} has no section type "${typeId}" (it has ${typeNames(frame)}).`
  }
  const requested = typeof part === 'string' ? undefined : part.heightU
  const heightU = heightForType(type, requested, fallback)
  return typeof heightU === 'string' ? heightU : { type, heightU }
}

function newSection(part: ResolvedPart, id: string, options?: OptionValues): PlanSection {
  return {
    id,
    typeId: part.type.id,
    ...(isRangeType(part.type) ? { heightU: part.heightU } : {}),
    ...(options === undefined ? {} : { options: { ...options } }),
  }
}

/** Rack- and section-scoped option values the section's recipe lines see right now. */
function sectionSnapshot(plan: Plan, frame: Frame, section: PlanSection, at: string): Snapshot {
  const heightU = sectionHeightU(frame, section.typeId, section.heightU)
  const scoped = frame.options.filter(
    (option) => option.scope === 'rack' || option.scope === 'section',
  )
  return {
    at,
    typeId: section.typeId,
    ...(heightU > 0 ? { heightU } : {}),
    options: resolveOptionValues(scoped, plan.frame.options, section.options),
  }
}

// ---------------------------------------------------------------------------------------------
// Operations

export interface InsertSectionOptions extends PlacementPolicy {
  /** Insert it as already in the user's rack (Recording mode). */
  have?: boolean
  /** Capture time of the Have snapshot (ISO date-time); default now. */
  at?: string
  /** For section types with a height range; default the range minimum. */
  heightU?: number
  options?: OptionValues
  id?: string
}

/** Inserts a section at `atIndex` (0 = below everything, `sections.length` = on top). */
export function insertSection(
  plan: Plan,
  frame: Frame,
  atIndex: number,
  typeId: string,
  options: InsertSectionOptions = {},
): StackOpResult {
  const sections = plan.frame.sections
  if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex > sections.length) {
    return failed(plan, `Position ${atIndex} is outside a stack of ${sections.length} sections.`)
  }
  const part = resolvePart(frame, { typeId, heightU: options.heightU })
  if (typeof part === 'string') return failed(plan, part)
  const id = options.id ?? newId(ID_PREFIX.section)
  if (sections.some((section) => section.id === id)) {
    return failed(plan, `Section id "${id}" is already used.`)
  }
  const totalU = totalHeightU(plan, frame) + part.heightU
  if (totalU > frame.stack.maxU) {
    return blocked(plan, [
      {
        kind: 'out-of-bounds',
        message: `${frame.name} stacks go up to ${frame.stack.maxU}U; this would make ${totalU}U.`,
      },
    ])
  }
  const section = newSection(part, id, options.options)
  const inserted: PlanSection =
    options.have === true
      ? { ...section, have: sectionSnapshot(plan, frame, section, options.at ?? nowIso()) }
      : section
  const next = [...sections.slice(0, atIndex), inserted, ...sections.slice(atIndex)]
  return remap(plan, next, frame, policyOf(options))
}

export interface RemoveSectionOptions extends PlacementPolicy {
  /** Also remove what is mounted on the section (owned placements are retired). */
  removePlacements?: boolean
  /** What happens to planned devices on removed placements (see `removePlacements`). */
  needDevices?: 'tray' | 'drop'
}

/** Removes a planned section; the sections above move down. Owned sections must be retired. */
export function removeSection(
  plan: Plan,
  frame: Frame,
  sectionId: string,
  options: RemoveSectionOptions = {},
): StackOpResult {
  const span = sectionSpans(plan, frame).find((candidate) => candidate.sectionId === sectionId)
  if (span === undefined) return sectionNotFound(plan, sectionId)
  if (span.have) return blocked(plan, [haveLocked([span], 'retire it instead of removing it')])
  const catalog = lookupFor(plan, options.catalog)
  const occupants = occupantsOf(plan, span, catalog)
  if (occupants.length > 0 && options.removePlacements !== true) {
    return blocked(plan, [notEmptyConflict(span, occupants, catalog)])
  }
  const base = removePlacements(
    plan,
    occupants.map((placement) => placement.id),
    { needDevices: options.needDevices },
  )
  const next = base.frame.sections.filter((section) => section.id !== sectionId)
  return remap(base, next, frame, policyOf(options))
}

/**
 * Moves a section to `toIndex` (its index after the move). What is mounted on it travels with it;
 * the sections in between shift. Owned sections can move too (the user rebuilds the rack).
 */
export function moveSection(
  plan: Plan,
  frame: Frame,
  sectionId: string,
  toIndex: number,
  options: PlacementPolicy = {},
): StackOpResult {
  const sections = plan.frame.sections
  const index = sections.findIndex((section) => section.id === sectionId)
  const section = sections[index]
  if (section === undefined) return sectionNotFound(plan, sectionId)
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= sections.length) {
    return failed(plan, `Position ${toIndex} is outside a stack of ${sections.length} sections.`)
  }
  if (toIndex === index) return applied(plan)
  const rest = sections.filter((candidate) => candidate.id !== sectionId)
  const next = [...rest.slice(0, toIndex), section, ...rest.slice(toIndex)]
  return remap(plan, next, frame, policyOf(options))
}

export interface SplitSectionOptions extends PlacementPolicy {
  /** Ids for the new sections, bottom -> top (generated when missing). */
  ids?: readonly string[]
}

/**
 * Splits a planned section into sections of `intoTypeIds` (bottom -> top) whose heights add up to
 * its height. The new sections copy its options; placements keep their positions.
 */
export function splitSection(
  plan: Plan,
  frame: Frame,
  sectionId: string,
  intoTypeIds: readonly SectionPart[],
  options: SplitSectionOptions = {},
): StackOpResult {
  const span = sectionSpans(plan, frame).find((candidate) => candidate.sectionId === sectionId)
  const section = plan.frame.sections.find((candidate) => candidate.id === sectionId)
  if (span === undefined || section === undefined) return sectionNotFound(plan, sectionId)
  if (span.have) return blocked(plan, [haveLocked([span], 'only planned sections can be split')])
  if (intoTypeIds.length === 0) return failed(plan, 'Pick the sections to split it into.')
  const parts: ResolvedPart[] = []
  for (const into of intoTypeIds) {
    const part = resolvePart(frame, into)
    if (typeof part === 'string') return failed(plan, part)
    parts.push(part)
  }
  const sumU = sumHeightsU(parts)
  if (sumU !== span.heightU) {
    const sum = parts.map((part) => `${part.heightU}U`).join(' + ')
    return failed(plan, `${sum} = ${sumU}U, but ${spanLabel(span)} is ${span.heightU}U.`)
  }
  const pieces = parts.map((part, index) =>
    newSection(part, options.ids?.[index] ?? newId(ID_PREFIX.section), section.options),
  )
  const others = plan.frame.sections.filter((candidate) => candidate.id !== sectionId)
  const clash = pieces.find((piece) => others.some((other) => other.id === piece.id))
  if (clash !== undefined) return failed(plan, `Section id "${clash.id}" is already used.`)
  const next = [
    ...plan.frame.sections.slice(0, span.index),
    ...pieces,
    ...plan.frame.sections.slice(span.index + 1),
  ]
  return remap(plan, next, frame, {
    ...policyOf(options),
    replacements: [{ from: [sectionId], to: pieces.map((piece) => piece.id) }],
  })
}

export interface MergeSectionsOptions extends PlacementPolicy {
  /** Id for the merged section (generated when missing). */
  id?: string
}

/**
 * Merges two adjacent planned sections into one section of `intoTypeId`, whose height must equal
 * theirs combined. The merged section takes the lower section's options; placements stay put.
 */
export function mergeSections(
  plan: Plan,
  frame: Frame,
  sectionIdA: string,
  sectionIdB: string,
  intoTypeId: SectionPart,
  options: MergeSectionsOptions = {},
): StackOpResult {
  const spans = sectionSpans(plan, frame)
  const a = spans.find((span) => span.sectionId === sectionIdA)
  const b = spans.find((span) => span.sectionId === sectionIdB)
  if (a === undefined) return sectionNotFound(plan, sectionIdA)
  if (b === undefined) return sectionNotFound(plan, sectionIdB)
  if (a === b) return failed(plan, 'Pick two different sections to merge.')
  const [lower, upper] = a.index < b.index ? [a, b] : [b, a]
  if (upper.index !== lower.index + 1) {
    return failed(plan, `${spanLabel(lower)} and ${spanLabel(upper)} are not neighbours.`)
  }
  const locked = [lower, upper].filter((span) => span.have)
  if (locked.length > 0) {
    return blocked(plan, [haveLocked(locked, 'only planned sections can be merged')])
  }
  const sumU = lower.heightU + upper.heightU
  const part = resolvePart(frame, intoTypeId, sumU)
  if (typeof part === 'string') return failed(plan, part)
  if (part.heightU !== sumU) {
    return failed(
      plan,
      `${part.type.label} is ${part.heightU}U; the two sections add up to ${sumU}U.`,
    )
  }
  const id = options.id ?? newId(ID_PREFIX.section)
  const sections = plan.frame.sections
  if (
    sections.some(
      (section) => section.id === id && id !== lower.sectionId && id !== upper.sectionId,
    )
  ) {
    return failed(plan, `Section id "${id}" is already used.`)
  }
  const merged = newSection(part, id, sections[lower.index]?.options)
  const next = [...sections.slice(0, lower.index), merged, ...sections.slice(upper.index + 1)]
  return remap(plan, next, frame, {
    ...policyOf(options),
    replacements: [{ from: [lower.sectionId, upper.sectionId], to: [id] }],
  })
}

/**
 * Fixed-height section types that add up to `heightU` with the fewest sections; ties go to the
 * combination with the larger sections. Sorted larger first (bottom -> top, so larger sections sit
 * lower, like the designer's 6U-first stacks). `[]` for 0, undefined when it cannot be made.
 * Range-height types are never used; of several types with one height, the first declared wins.
 */
export function composeHeight(
  heightU: number,
  sectionTypes: readonly SectionType[],
): SectionType[] | undefined {
  if (!Number.isInteger(heightU) || heightU < 0) return undefined
  const fixed = fixedTypes(sectionTypes)
  const best: Array<ResolvedPart[] | undefined> = [[]]
  for (let total = 1; total <= heightU; total++) {
    let winner: ResolvedPart[] | undefined
    for (const part of fixed) {
      const rest = best[total - part.heightU]
      if (rest === undefined) continue
      const candidate = [...rest, part].toSorted((x, y) => y.heightU - x.heightU)
      if (winner === undefined || betterComposition(candidate, winner)) winner = candidate
    }
    best[total] = winner
  }
  return best[heightU]?.map((part) => part.type)
}

function fixedTypes(sectionTypes: readonly SectionType[]): ResolvedPart[] {
  const byHeight = new Map<number, ResolvedPart>()
  for (const type of sectionTypes) {
    if (typeof type.heightU !== 'number' || byHeight.has(type.heightU)) continue
    byHeight.set(type.heightU, { type, heightU: type.heightU })
  }
  return [...byHeight.values()].toSorted((x, y) => y.heightU - x.heightU)
}

function betterComposition(a: readonly ResolvedPart[], b: readonly ResolvedPart[]): boolean {
  if (a.length !== b.length) return a.length < b.length
  for (const [index, part] of a.entries()) {
    const other = b[index]?.heightU ?? 0
    if (part.heightU !== other) return part.heightU > other
  }
  return false
}

/** Heights from `fromU` up to `toU` that `keptU` plus fixed-height sections can make. */
function reachableHeights(keptU: number, fromU: number, toU: number, frame: Frame): number[] {
  const heights: number[] = []
  for (let heightU = Math.max(fromU, keptU); heightU <= toU; heightU++) {
    if (composeHeight(heightU - keptU, frame.sectionTypes) !== undefined) heights.push(heightU)
  }
  return heights
}

function nearestHeightsHint(targetU: number, keptU: number, frame: Frame): string {
  const reachable = reachableHeights(keptU, frame.stack.minU, frame.stack.maxU, frame)
  const below = reachable.filter((heightU) => heightU < targetU).at(-1)
  const above = reachable.find((heightU) => heightU > targetU)
  const options = [below, above].filter((heightU) => heightU !== undefined)
  return options.length === 0 ? '' : ` Try ${options.map((heightU) => `${heightU}U`).join(' or ')}.`
}

/** The planned (not Have) sections at one end of the stack, bottom -> top. */
function plannedRunAt(spans: readonly SectionSpan[], at: StackEnd): SectionSpan[] {
  const fromEnd = at === 'top' ? spans.toReversed() : [...spans]
  const run: SectionSpan[] = []
  for (const span of fromEnd) {
    if (span.have) break
    run.push(span)
  }
  return at === 'top' ? run.toReversed() : run
}

/**
 * Reuses old run sections (id and options) where the new run has the same type at the same place,
 * counted from the end that touches the rest of the stack.
 */
function rebuildRun(
  sections: readonly PlanSection[],
  oldRun: readonly SectionSpan[],
  types: readonly SectionType[],
  at: StackEnd,
): PlanSection[] {
  const fromInside = <T>(items: readonly T[]): T[] =>
    at === 'top' ? [...items] : items.toReversed()
  const oldInside = fromInside(oldRun)
  let reusing = true
  const rebuilt = fromInside(types).map((type): PlanSection => {
    const old = oldInside.shift()
    const section = old === undefined ? undefined : sections[old.index]
    reusing = reusing && old?.typeId === type.id && old.heightU === type.heightU
    if (reusing && section !== undefined) return section
    return { id: newId(ID_PREFIX.section), typeId: type.id }
  })
  return fromInside(rebuilt)
}

/**
 * Sets the stack height by rebuilding the planned run at one end (sections you have never change):
 * the fewest fixed-height sections that make up the difference, larger ones lower. Content of the
 * old run keeps its offset from the side that touches the rest of the stack.
 */
export function setHeight(
  plan: Plan,
  frame: Frame,
  targetU: number,
  at: StackEnd,
  options: PlacementPolicy = {},
): StackOpResult {
  if (!Number.isInteger(targetU)) return failed(plan, 'Rack heights are whole U.')
  const { minU, maxU } = frame.stack
  if (targetU < minU || targetU > maxU) {
    return blocked(plan, [
      {
        kind: 'out-of-bounds',
        message: `${frame.name} stacks are ${minU}U to ${maxU}U, so ${targetU}U is not possible.`,
      },
    ])
  }
  const spans = sectionSpans(plan, frame)
  const currentU = sumHeightsU(spans)
  if (targetU === currentU) return applied(plan)
  const run = plannedRunAt(spans, at)
  const keptU = currentU - sumHeightsU(run)
  const types = composeHeight(targetU - keptU, frame.sectionTypes)
  if (types === undefined) {
    const sizes = listNames(
      fixedTypes(frame.sectionTypes)
        .toReversed()
        .map((part) => `${part.heightU}U`),
    )
    const why =
      targetU < keptU
        ? `the sections that stay add up to ${keptU}U (sections you have are never removed)`
        : `${keptU}U stays and the rest has to be made of ${sizes || 'fixed-height'} sections`
    return blocked(plan, [
      {
        kind: 'unreachable-height',
        message: `${targetU}U is not possible: ${why}.${nearestHeightsHint(targetU, keptU, frame)}`,
      },
    ])
  }
  const sections = plan.frame.sections
  const newRun = rebuildRun(sections, run, types, at)
  const kept =
    at === 'top' ? sections.slice(0, sections.length - run.length) : sections.slice(run.length)
  const next = at === 'top' ? [...kept, ...newRun] : [...newRun, ...kept]
  const replacements: SectionReplacement[] =
    run.length === 0
      ? []
      : [
          {
            from: run.map((span) => span.sectionId),
            to: newRun.map((section) => section.id),
            align: at === 'top' ? 'start' : 'end',
          },
        ]
  return remap(plan, next, frame, { ...policyOf(options), replacements })
}

/**
 * Takes an owned section out of the rack: it becomes a `retired` entry (what was built, stamped
 * with `at`) and the sections above move down. What is mounted on it must be removed with it
 * (`removePlacements`); owned placements retire too.
 */
export function retireSection(
  plan: Plan,
  frame: Frame,
  sectionId: string,
  at: string,
  options: RemoveSectionOptions = {},
): StackOpResult {
  const span = sectionSpans(plan, frame).find((candidate) => candidate.sectionId === sectionId)
  const section = plan.frame.sections.find((candidate) => candidate.id === sectionId)
  if (span === undefined || section === undefined) return sectionNotFound(plan, sectionId)
  if (section.have === undefined) {
    return failed(plan, `${spanLabel(span)} is not in your rack yet; remove it instead.`)
  }
  const catalog = lookupFor(plan, options.catalog)
  const occupants = occupantsOf(plan, span, catalog)
  if (occupants.length > 0 && options.removePlacements !== true) {
    return blocked(plan, [notEmptyConflict(span, occupants, catalog)])
  }
  const base = removePlacements(
    plan,
    occupants.map((placement) => placement.id),
    { at, needDevices: options.needDevices },
  )
  const entry: RetiredEntry = {
    id: newId(ID_PREFIX.retired),
    kind: 'section',
    snapshot: { ...section.have, at },
    sourceId: section.id,
  }
  const withRetired: Plan = { ...base, retired: [...base.retired, entry] }
  const next = withRetired.frame.sections.filter((candidate) => candidate.id !== sectionId)
  return remap(withRetired, next, frame, policyOf(options))
}

/**
 * Marks a section as in the user's rack (captures a Snapshot of its type, height and resolved
 * options at `at`) or as still to get (drops the snapshot). Re-marking an unchanged owned section
 * returns the plan as it is.
 */
export function markSection(
  plan: Plan,
  sectionId: string,
  have: boolean,
  at: string,
  frame: Frame,
): StackOpResult {
  const sections = plan.frame.sections
  const section = sections.find((candidate) => candidate.id === sectionId)
  if (section === undefined) return sectionNotFound(plan, sectionId)
  let updated: PlanSection
  if (have) {
    if (findType(frame, section.typeId) === undefined) {
      return failed(plan, `${frame.name} has no section type "${section.typeId}".`)
    }
    const snapshot = sectionSnapshot(plan, frame, section, at)
    if (section.have !== undefined && sameBuild(section.have, snapshot)) return applied(plan)
    updated = { ...section, have: snapshot }
  } else {
    if (section.have === undefined) return applied(plan)
    updated = { ...section }
    delete updated.have
  }
  return applied(
    withSections(
      plan,
      sections.map((candidate) => (candidate === section ? updated : candidate)),
    ),
  )
}

function sameBuild(a: Snapshot, b: Snapshot): boolean {
  const keys = new Set([...Object.keys(a.options), ...Object.keys(b.options)])
  return (
    a.typeId === b.typeId &&
    a.heightU === b.heightU &&
    [...keys].every((key) => a.options[key] === b.options[key])
  )
}

function nowIso(): string {
  return new Date().toISOString()
}

// ---------------------------------------------------------------------------------------------
// Validation

/**
 * Problems with the stack itself: wrong frame, unknown section types, invalid heights, duplicate
 * ids and a height outside `stack.minU..maxU`. Owned sections the plan rebuilds as something else
 * are reported as info. Placements are checked elsewhere (`canPlace`, checks.ts).
 */
export function validateStack(plan: Plan, frame: Frame): Issue[] {
  const issues: Issue[] = []
  if (plan.frame.frameId !== frame.id) {
    issues.push({
      severity: 'error',
      code: 'frame-mismatch',
      message: `This plan is for frame "${plan.frame.frameId}", not ${frame.name}.`,
    })
  }
  const spans = sectionSpans(plan, frame)
  if (spans.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'empty-stack',
      message: 'The rack has no sections yet.',
    })
  }
  const seen = new Set<string>()
  for (const [index, section] of plan.frame.sections.entries()) {
    const span = spans[index]
    if (span === undefined) continue
    const label = spanLabel(span)
    if (seen.has(section.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-section-id',
        message: `${label} reuses the id "${section.id}".`,
        targetId: section.id,
      })
    }
    seen.add(section.id)
    issues.push(...sectionIssues(frame, section, label))
  }
  const totalU = sumHeightsU(spans)
  if (spans.length > 0 && (totalU < frame.stack.minU || totalU > frame.stack.maxU)) {
    issues.push({
      severity: 'error',
      code: 'out-of-bounds',
      message: `${frame.name} stacks are ${frame.stack.minU}U to ${frame.stack.maxU}U; this one is ${totalU}U.`,
    })
  }
  return issues
}

function sectionIssues(frame: Frame, section: PlanSection, label: string): Issue[] {
  const type = findType(frame, section.typeId)
  if (type === undefined) {
    return [
      {
        severity: 'error',
        code: 'unknown-section-type',
        message: `${label} uses section type "${section.typeId}", which ${frame.name} does not have.`,
        targetId: section.id,
      },
    ]
  }
  const issues: Issue[] = []
  const heightU = heightForType(type, section.heightU)
  if (typeof heightU === 'string') {
    issues.push({
      severity: 'error',
      code: 'section-height',
      message: `${label}: ${heightU}`,
      targetId: section.id,
    })
  }
  const built = section.have
  const plannedU = sectionHeightU(frame, section.typeId, section.heightU)
  const rebuilt =
    built?.typeId !== undefined &&
    (built.typeId !== section.typeId || (built.heightU !== undefined && built.heightU !== plannedU))
  if (built?.typeId !== undefined && rebuilt) {
    const builtType = findType(frame, built.typeId)?.label ?? built.typeId
    issues.push({
      severity: 'info',
      code: 'have-changed',
      message: `${label} is built as ${builtType} (${built.heightU ?? '?'}U); the plan rebuilds it as ${type.label}.`,
      targetId: section.id,
    })
  }
  return issues
}
