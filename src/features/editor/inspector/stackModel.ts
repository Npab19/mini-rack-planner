/**
 * Pure view helpers for the inspector: stack rows with U ranges, what a planned section can be
 * split into or merged with, the heights "Set height" can reach, and where a placement can go.
 * Everything delegates the rules to the domain (frame.ts, placement.ts); this only shapes text.
 */
import {
  composeHeight,
  listNames,
  sectionSpans,
  totalHeightSixths,
  type SectionPart,
  type StackEnd,
} from '@/domain/frame'
import { formatU, SIXTHS_PER_U, uNumberAt, uToSixths } from '@/domain/geometry'
import { allowedPhases, canPlace, resolvePlaceable, type Placeable } from '@/domain/placement'
import { sectionLabel } from '@/domain/recipe'
import type { CatalogLookup, Frame, SectionType } from '@/domain/schema/catalog'
import type { Face } from '@/domain/schema/common'
import type { PlacedDevice, Placement, PlacementBay, Plan } from '@/domain/schema/plan'
import { positionText } from '../rack/labels'

// ---------------------------------------------------------------------------------------------
// Positions

/** "U4", "U4–U9" for the sixths [start, end). */
export function uRange(startSixths: number, endSixths: number): string {
  const first = uNumberAt(startSixths)
  const last = uNumberAt(Math.max(startSixths, endSixths - 1))
  return first === last ? `U${first}` : `U${first}–U${last}`
}

/**
 * "U4", "U4–U5", or "U4 + ½U" for a start inside a U: the rack's wording (`rack/labels.ts`), so
 * the inspector, the rack and its announcements say the same.
 */
export { positionText }

/** "U4–U5 · front", "U3 · rear · left half". */
export function placementWhere(
  placement: Pick<Placement, 'y' | 'face' | 'bay'>,
  heightSixths: number,
): string {
  const bay = placement.bay === 'full' ? '' : ` · ${placement.bay} half`
  return `${positionText(placement.y, heightSixths)} · ${placement.face}${bay}`
}

// ---------------------------------------------------------------------------------------------
// Stack rows

export interface StackRow {
  sectionId: string
  /** 0 = bottom. */
  index: number
  typeId: string
  /** "3U section"; a type the frame does not have reads "Unknown section …". */
  typeLabel: string
  heightU: number
  startSixths: number
  endSixths: number
  /** "U10–U12". */
  range: string
  have: boolean
  /** "3U section, U10–U12": names the row in buttons and announcements. */
  name: string
  /** "Section 3 (3U)": the domain's wording, which conflict messages use. */
  sectionLabel: string
}

/** Sections bottom -> top. */
export function stackRows(plan: Plan, frame: Frame): StackRow[] {
  return sectionSpans(plan, frame).map((span) => {
    const type = frame.sectionTypes.find((candidate) => candidate.id === span.typeId)
    const typeLabel = type?.label ?? `Unknown section “${span.typeId}”`
    const range =
      span.endSixths > span.startSixths
        ? uRange(span.startSixths, span.endSixths)
        : `at U${uNumberAt(span.startSixths)}`
    return {
      sectionId: span.sectionId,
      index: span.index,
      typeId: span.typeId,
      typeLabel,
      heightU: span.heightU,
      startSixths: span.startSixths,
      endSixths: span.endSixths,
      range,
      have: span.have,
      name: `${typeLabel}, ${range}`,
      sectionLabel: sectionLabel(span.index, span.heightU),
    }
  })
}

export function stackHeightU(rows: readonly StackRow[]): number {
  return rows.reduce((total, row) => total + row.heightU, 0)
}

function heightText(heightU: number): string {
  return formatU(uToSixths(heightU))
}

function fixedHeightU(type: SectionType): number | undefined {
  return typeof type.heightU === 'number' ? type.heightU : undefined
}

// ---------------------------------------------------------------------------------------------
// Split and merge

export interface SplitChoice {
  /** Section types bottom -> top. */
  parts: SectionType[]
  /** "3U + 3U". */
  text: string
}

/**
 * The split a planned section offers: the fewest smaller fixed-height sections that add up to its
 * height (larger ones lower), e.g. a planned 6U into 3U + 3U. Undefined when there is none.
 */
export function splitChoice(frame: Frame, row: StackRow): SplitChoice | undefined {
  if (row.have) return undefined
  const smaller = frame.sectionTypes.filter((type) => (fixedHeightU(type) ?? 0) < row.heightU)
  const parts = composeHeight(row.heightU, smaller)
  if (parts === undefined || parts.length < 2) return undefined
  return { parts, text: parts.map((part) => heightText(fixedHeightU(part) ?? 0)).join(' + ') }
}

export interface MergeChoice {
  /** The neighbouring section it merges with. */
  other: StackRow
  direction: 'above' | 'below'
  into: SectionPart
  /** "6U section". */
  intoLabel: string
}

function mergeTarget(
  frame: Frame,
  heightU: number,
): { part: SectionPart; label: string } | undefined {
  const fixed = frame.sectionTypes.find((type) => fixedHeightU(type) === heightU)
  if (fixed !== undefined) return { part: fixed.id, label: fixed.label }
  const range = frame.sectionTypes.find(
    (type) =>
      typeof type.heightU !== 'number' &&
      type.heightU.min <= heightU &&
      heightU <= type.heightU.max,
  )
  if (range === undefined) return undefined
  return { part: { typeId: range.id, heightU }, label: `${range.label} (${heightText(heightU)})` }
}

/** Planned neighbours a planned section can merge with into one section of a type the frame has. */
export function mergeChoices(
  frame: Frame,
  rows: readonly StackRow[],
  row: StackRow,
): MergeChoice[] {
  if (row.have) return []
  const neighbours = [
    ['above', rows[row.index + 1]],
    ['below', rows[row.index - 1]],
  ] as const
  const choices: MergeChoice[] = []
  for (const [direction, other] of neighbours) {
    if (other === undefined || other.have) continue
    const target = mergeTarget(frame, row.heightU + other.heightU)
    if (target !== undefined) {
      choices.push({ other, direction, into: target.part, intoLabel: target.label })
    }
  }
  return choices
}

// ---------------------------------------------------------------------------------------------
// Set height

/** Height of the planned (not Have) sections at one end: the run Set height rebuilds. */
export function plannedRunU(rows: readonly StackRow[], at: StackEnd): number {
  const fromEnd = at === 'top' ? rows.toReversed() : rows
  let total = 0
  for (const row of fromEnd) {
    if (row.have) break
    total += row.heightU
  }
  return total
}

/**
 * Heights Set height can reach when it rebuilds the planned run at `at` (sections you have stay):
 * the kept height plus any sum of fixed-height sections, within the frame's limits. The current
 * height is included (a no-op), ascending.
 */
export function reachableHeights(rows: readonly StackRow[], frame: Frame, at: StackEnd): number[] {
  const currentU = stackHeightU(rows)
  const keptU = currentU - plannedRunU(rows, at)
  const heights: number[] = []
  for (let heightU = Math.max(frame.stack.minU, keptU); heightU <= frame.stack.maxU; heightU++) {
    const reachable =
      heightU === currentU || composeHeight(heightU - keptU, frame.sectionTypes) !== undefined
    if (reachable) heights.push(heightU)
  }
  return heights
}

/** The smallest height above the current one, else the current one, else the first. */
export function defaultTargetU(heights: readonly number[], currentU: number): number | undefined {
  return (
    heights.find((heightU) => heightU > currentU) ??
    (heights.includes(currentU) ? currentU : heights[0])
  )
}

function sectionsText(rows: readonly StackRow[], planned: boolean): string {
  const count = rows.length
  const sizes = rows.map((row) => heightText(row.heightU)).join(' + ')
  return `${count} ${planned ? 'planned ' : ''}${count === 1 ? 'section' : 'sections'} (${sizes})`
}

/** "9U → 12U: adds 1 section (3U) on top." from the rows before and after. */
export function heightChangeText(
  before: readonly StackRow[],
  after: readonly StackRow[],
  at: StackEnd,
): string {
  const beforeIds = new Set(before.map((row) => row.sectionId))
  const afterIds = new Set(after.map((row) => row.sectionId))
  const added = after.filter((row) => !beforeIds.has(row.sectionId))
  const removed = before.filter((row) => !afterIds.has(row.sectionId))
  const changes: string[] = []
  if (removed.length > 0) changes.push(`removes ${sectionsText(removed, true)}`)
  if (added.length > 0) changes.push(`adds ${sectionsText(added, false)}`)
  const where = at === 'top' ? 'on top' : 'at the bottom'
  const what = changes.length === 0 ? 'no change' : `${listNames(changes)} ${where}`
  return `${stackHeightU(before)}U → ${stackHeightU(after)}U: ${what}.`
}

// ---------------------------------------------------------------------------------------------
// Where a placement can go

function candidateYs(plan: Plan, frame: Frame, placeable: Placeable): number[] {
  const top = totalHeightSixths(plan, frame)
  const { phases } = allowedPhases(placeable, frame)
  const ys: number[] = []
  for (let base = 0; base < top; base += SIXTHS_PER_U) {
    for (const phase of phases) {
      const y = base + phase
      if (y + placeable.heightSixths <= top) ys.push(y)
    }
  }
  return ys
}

/**
 * Starts (bottom edges) the placement can move to on its own face and bay, the current one
 * included: allowed hole phases inside the stack where `canPlace` passes. Unknown items: none.
 */
export function placementStarts(
  plan: Plan,
  lookup: CatalogLookup,
  frame: Frame,
  placement: Placement,
): number[] {
  const placeable = resolvePlaceable(lookup, placement.itemId)
  if (placeable === undefined) return []
  return candidateYs(plan, frame, placeable).filter(
    (y) =>
      canPlace(plan, lookup, frame, {
        itemId: placement.itemId,
        y,
        face: placement.face,
        bay: placement.bay,
        ignorePlacementId: placement.id,
      }).ok,
  )
}

export interface FreeStart {
  y: number
  face: Face
  bay: PlacementBay
}

/**
 * The free start nearest to `near` for an item on `face` (devices counted, so a shelf's height
 * is), trying `bays` in order at each height; ties go to the higher spot. Undefined when the face
 * has no room.
 */
export function nearestFreeStart(
  plan: Plan,
  lookup: CatalogLookup,
  frame: Frame,
  wanted: {
    itemId: string
    face: Face
    near: number
    bays?: readonly PlacementBay[]
    devices?: readonly PlacedDevice[]
  },
): FreeStart | undefined {
  const placeable = resolvePlaceable(lookup, wanted.itemId)
  if (placeable === undefined || !placeable.faces.includes(wanted.face)) return undefined
  const bays = wanted.bays ?? (placeable.bay === 'half' ? ['left', 'right'] : ['full'])
  const ys = candidateYs(plan, frame, placeable).toSorted(
    (a, b) => Math.abs(a - wanted.near) - Math.abs(b - wanted.near) || b - a,
  )
  for (const y of ys) {
    for (const bay of bays) {
      const check = canPlace(plan, lookup, frame, {
        itemId: wanted.itemId,
        y,
        face: wanted.face,
        bay,
        devices: wanted.devices ?? [],
      })
      if (check.ok) return { y, face: wanted.face, bay }
    }
  }
  return undefined
}
