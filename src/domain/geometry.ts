/**
 * 10" rack geometry.
 *
 * Millimetres everywhere. Rack positions and heights are integer sixths of a U, so ½U and ⅓U
 * steps stay exact. Frame axes: X right, Y up (0 = bottom of U1), Z toward the viewer
 * (0 = rail front face).
 */

/** One rack unit (EIA-310). */
export const U_MM = 44.45
export const SIXTHS_PER_U = 6
export const SIXTH_MM = U_MM / SIXTHS_PER_U
/** Nominal 10" panel width. */
export const PANEL_WIDTH_MM = 254
/** Nominal ear-hole spacing across the rails. Real racks vary (235–238 mm), so frames override it. */
export const EIA_EAR_SPACING_MM = 236.525
/** Panels are 1/32" shorter than their nominal height so stacked panels never bind. */
export const PANEL_HEIGHT_REDUCTION_MM = 0.794
/** Rail hole centres within each U, measured up from the bottom of that U. */
export const EIA_HOLE_OFFSETS_PER_U_MM: readonly number[] = [6.35, 22.225, 38.1]
/** Nominal opening between the rails. Real frames measure 212–222 mm, so frames override it. */
export const NOMINAL_OPENING_MM = 222.25
/** Gear wider than this may not fit every real 10" frame. */
export const GEAR_WIDTH_GUIDE_MM = 210

// Absorbs float noise such as 44.45 / (44.45 / 6) = 6.000000000000001.
const EPSILON = 1e-9
const FRACTIONS = ['', '⅙', '⅓', '½', '⅔', '⅚'] as const

/** Rounds to the nearest sixth: positions and heights are always whole sixths. */
export function uToSixths(u: number): number {
  return Math.round(u * SIXTHS_PER_U)
}

export function sixthsToU(sixths: number): number {
  return sixths / SIXTHS_PER_U
}

export function sixthsToMm(sixths: number): number {
  // Dividing first keeps whole-U values exact (6 sixths -> exactly 44.45 mm).
  return (sixths / SIXTHS_PER_U) * U_MM
}

/** Smallest whole number of sixths that is at least `mm` tall. */
export function mmToSixthsCeil(mm: number): number {
  // `|| 0` turns Math.ceil's -0 (for mm = 0) into 0.
  return Math.ceil(mm / SIXTH_MM - EPSILON) || 0
}

/** Largest whole number of sixths that fits in `mm`. */
export function mmToSixthsFloor(mm: number): number {
  return Math.floor(mm / SIXTH_MM + EPSILON) || 0
}

/** Height of a panel face of the given nominal height: 44.45 mm × U − 0.794 mm. */
export function panelFaceHeightMm(heightSixths: number): number {
  return Math.max(0, sixthsToMm(heightSixths) - PANEL_HEIGHT_REDUCTION_MM)
}

export function isWholeU(sixths: number): boolean {
  return sixths % SIXTHS_PER_U === 0
}

/** Human label for a height in sixths: "1U", "½U", "1½U", "⅓U", "2⅔U", "0U". */
export function formatU(sixths: number): string {
  const total = Math.round(sixths)
  if (total < 0) return `-${formatU(-total)}`
  const whole = Math.floor(total / SIXTHS_PER_U)
  const fraction = FRACTIONS[total % SIXTHS_PER_U] ?? ''
  if (whole === 0 && fraction === '') return '0U'
  return `${whole === 0 ? '' : whole}${fraction}U`
}

/** 1-based label of the U that contains `ySixths` (y = 0..5 is U1, 6..11 is U2, ...). */
export function uNumberAt(ySixths: number): number {
  return Math.floor(ySixths / SIXTHS_PER_U) + 1
}

/** Sixths into its U (0..5, also below U1): the start phase that rail hole patterns repeat on. */
export function phaseOf(ySixths: number): number {
  return ((ySixths % SIXTHS_PER_U) + SIXTHS_PER_U) % SIXTHS_PER_U
}

/** Y of every rail hole centre on a rail `heightU` tall, bottom to top. */
export function railHoleYsMm(
  heightU: number,
  holeOffsetsPerUMm: readonly number[] = EIA_HOLE_OFFSETS_PER_U_MM,
): number[] {
  const ys: number[] = []
  for (let u = 0; u < heightU; u++) {
    for (const offset of holeOffsetsPerUMm) ys.push(u * U_MM + offset)
  }
  return ys
}
