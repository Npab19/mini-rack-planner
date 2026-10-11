/**
 * Spike-local rack model: geometry, snapping and occupancy checks.
 *
 * It mirrors what `src/domain` (geometry.ts, placement.ts) will own, but is inlined here so the
 * spike does not depend on domain code that is being written at the same time. Everything in this
 * file is pure (no DOM, no React) so the M3b version can move into the domain unchanged.
 */

export const U_MM = 44.45
export const SIXTHS_PER_U = 6
export const SIXTH_MM = U_MM / SIXTHS_PER_U
export const RACK_WIDTH_MM = 254
export const RACK_UNITS = 12
export const RACK_SIXTHS = RACK_UNITS * SIXTHS_PER_U
export const RACK_HEIGHT_MM = RACK_UNITS * U_MM
/** A panel is 44.45·n − 0.794 mm tall so neighbouring panels never touch. */
export const PANEL_CLEARANCE_MM = 0.794
/** 10" ear holes are 236.525 mm apart, centred on the 254 mm panel. */
export const EAR_HOLE_SPACING_MM = 236.525
/** Rail hole centres within each U, measured up from the bottom of the U. */
export const HOLE_OFFSETS_IN_U_MM: readonly number[] = [6.35, 22.225, 38.1]

/** Integer sixths of a U (1U = 6), measured up from the bottom of U1. */
export type Sixths = number

export type ItemKind = '1u' | '2u' | 'half'

export interface CatalogItem {
  kind: ItemKind
  name: string
  heightSixths: Sixths
  /** Start grid: whole-U items snap to whole U (6), half-U items to half U (3). */
  stepSixths: Sixths
}

export const CATALOG: Readonly<Record<ItemKind, CatalogItem>> = {
  '1u': { kind: '1u', name: '1U patch panel', heightSixths: 6, stepSixths: 6 },
  '2u': { kind: '2u', name: '2U mini PC shelf', heightSixths: 12, stepSixths: 6 },
  half: { kind: 'half', name: '½U Pi mount', heightSixths: 3, stepSixths: 3 },
}

/** Palette order. */
export const ITEM_KINDS: readonly ItemKind[] = ['1u', '2u', 'half']

export function isItemKind(value: unknown): value is ItemKind {
  return value === '1u' || value === '2u' || value === 'half'
}

export interface Placement {
  id: string
  kind: ItemKind
  y: Sixths
}

export function heightOf(placement: Placement): Sixths {
  return CATALOG[placement.kind].heightSixths
}

export function sixthsToMm(sixths: number): number {
  return sixths * SIXTH_MM
}

export function mmToSixths(mm: number): number {
  return mm / SIXTH_MM
}

/** U number of a start position: y = 0 → 1, y = 3 → 1.5, y = 24 → 5. */
export function uNumber(y: Sixths): number {
  return y / SIXTHS_PER_U + 1
}

/** Human-readable span, e.g. "U5–U6", "U8", "lower half of U3". */
export function formatSpan(y: Sixths, height: Sixths): string {
  const bottomU = Math.floor(y / SIXTHS_PER_U) + 1
  const topU = Math.floor((y + height - 1) / SIXTHS_PER_U) + 1
  if (y % SIXTHS_PER_U === 0 && height % SIXTHS_PER_U === 0) {
    return bottomU === topU ? `U${bottomU}` : `U${bottomU}–U${topU}`
  }
  if (bottomU === topU && height * 2 === SIXTHS_PER_U) {
    return `${y % SIXTHS_PER_U === 0 ? 'lower' : 'upper'} half of U${bottomU}`
  }
  return `U${uNumber(y)}–U${uNumber(y + height)}`
}

/** Height label, e.g. "2U", "½U". */
export function formatHeight(height: Sixths): string {
  if (height * 2 === SIXTHS_PER_U) return '½U'
  return `${height / SIXTHS_PER_U}U`
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Index of the snap step (U or half-U) that contains a fractional position. */
export function stepUnder(positionSixths: number, stepSixths: Sixths): number {
  return Math.floor(positionSixths / stepSixths)
}

/**
 * Snapped start for a drag. The step the user grabbed (0 = the item's bottom U or half-U) stays
 * under the pointer, so a palette drop puts the item's bottom U on the U under the pointer, and a
 * moved item never jumps relative to the finger.
 */
export function snapStart(pointerSixths: number, stepSixths: Sixths, grabbedStep = 0): Sixths {
  return (stepUnder(pointerSixths, stepSixths) - grabbedStep) * stepSixths
}

/** Which step of a placed item sits under the pointer when a move starts. */
export function grabbedStepOf(pointerSixths: number, placement: Placement): number {
  const { heightSixths, stepSixths } = CATALOG[placement.kind]
  const steps = Math.max(1, Math.round(heightSixths / stepSixths))
  return clamp(stepUnder(pointerSixths - placement.y, stepSixths), 0, steps - 1)
}

export type Verdict =
  | { ok: true; message: string }
  | {
      ok: false
      code: 'out-of-rack' | 'overlap' | 'off-grid'
      message: string
      conflictId?: string
    }

export interface Candidate {
  kind: ItemKind
  y: Sixths
  /** The placement being moved; it never blocks itself. */
  ignoreId?: string
}

export function overlaps(
  aStart: Sixths,
  aHeight: Sixths,
  bStart: Sixths,
  bHeight: Sixths,
): boolean {
  return aStart < bStart + bHeight && bStart < aStart + aHeight
}

export function checkPlacement(placements: readonly Placement[], candidate: Candidate): Verdict {
  const { heightSixths, stepSixths } = CATALOG[candidate.kind]
  if (!Number.isInteger(candidate.y) || candidate.y % stepSixths !== 0) {
    return { ok: false, code: 'off-grid', message: `Not on the ${formatHeight(stepSixths)} grid` }
  }
  if (candidate.y < 0) {
    return { ok: false, code: 'out-of-rack', message: 'Below U1, the bottom of the rack' }
  }
  if (candidate.y + heightSixths > RACK_SIXTHS) {
    return { ok: false, code: 'out-of-rack', message: `Past U${RACK_UNITS}, the top of the rack` }
  }
  const conflict = placements.find(
    (other) =>
      other.id !== candidate.ignoreId &&
      overlaps(other.y, heightOf(other), candidate.y, heightSixths),
  )
  if (conflict) {
    return {
      ok: false,
      code: 'overlap',
      message: `Overlaps ${CATALOG[conflict.kind].name} at ${formatSpan(conflict.y, heightOf(conflict))}`,
      conflictId: conflict.id,
    }
  }
  return { ok: true, message: `Fits at ${formatSpan(candidate.y, heightSixths)}` }
}

/** ArrowUp/ArrowDown move 1U, or 5U with Shift. Other keys are not moves. */
export function keyboardDelta(key: string, shiftKey: boolean): Sixths | null {
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return null
  const units = shiftKey ? 5 : 1
  return (key === 'ArrowUp' ? 1 : -1) * units * SIXTHS_PER_U
}

/* SVG drawing space: millimetres, y grows downwards, y = 0 is the top of the top U. */

export const DRAWING = {
  minX: -32,
  minY: -14,
  width: RACK_WIDTH_MM + 32 + 14,
  height: RACK_HEIGHT_MM + 28,
} as const

export function svgYOfSixths(sixths: number): number {
  return RACK_HEIGHT_MM - sixthsToMm(sixths)
}

export function sixthsOfSvgY(svgY: number): number {
  return mmToSixths(RACK_HEIGHT_MM - svgY)
}

/** Centre of the rack drawing, used as the initial camera target. */
export const RACK_CENTER = { x: RACK_WIDTH_MM / 2, y: RACK_HEIGHT_MM / 2 } as const
