/**
 * Drawing space of the rack view. Pure: no React, no DOM.
 *
 * SVG user units are millimetres. The rack's Y axis points up (0 = bottom of U1) and SVG's points
 * down, so `svgY = topMm - yMm`, where `topMm` is the rack height at the top edge of the drawing.
 * X is the rack's X as seen from the viewer: 0 is the left edge of the 254 mm panel area, the U
 * labels sit left of it (negative x) and the section bands right of it.
 *
 * ```
 *  leftX                0                 panelWidth   bandX      rightX
 *    | U labels | rail |  opening  | rail |  gap  | band |   |
 * ```
 */
import {
  EIA_EAR_SPACING_MM,
  EIA_HOLE_OFFSETS_PER_U_MM,
  NOMINAL_OPENING_MM,
  PANEL_HEIGHT_REDUCTION_MM,
  PANEL_WIDTH_MM,
  panelFaceHeightMm,
  SIXTH_MM,
  sixthsToMm,
} from '@/domain/geometry'
import type { Face } from '@/domain/schema/common'
import type { PlacementBay } from '@/domain/schema/plan'

/** 100 % zoom draws 1 mm as 1.5 CSS px (1U = 66.7 px), as in spike S2. */
export const BASE_PX_PER_MM = 1.5
/** A narrow container draws smaller at 100 % (down to this) so the rack fits a 360 px phone. */
export const MIN_BASE_PX_PER_MM = 0.6
/** Room for the U numbers left of the panel. */
export const U_LABEL_COLUMN_MM = 20
export const BAND_GAP_MM = 12
export const BAND_WIDTH_MM = 60
/** Room above the top and below the bottom of the stack (the + handles sit on the edges). */
export const EDGE_MARGIN_MM = 24
export const SIDE_MARGIN_MM = 4
/** Smallest drawn height, for placeholders with no known height. */
export const MIN_DRAWN_HEIGHT_MM = 3

export interface RackLayout {
  panelWidthMm: number
  /** Opening between the rails (after the frame's option effects). */
  innerWidthMm: number
  /** Width of each rail: (panel - opening) / 2. */
  railWidthMm: number
  earSpacingMm: number
  holeOffsetsPerUMm: readonly number[]
  /** Top of the stack in sixths (0 for an empty stack). */
  topSixths: number
  /** Rack Y (mm) at the top and the bottom edge of the drawing. */
  topMm: number
  bottomMm: number
  /** SVG x of the drawing's left and right edges. */
  leftX: number
  rightX: number
  /** Left edge and width of the section-band column. */
  bandX: number
  bandWidth: number
  /** Drawing size in mm (the viewBox size). */
  width: number
  height: number
}

export interface RackLayoutInput {
  panelWidthMm?: number
  innerWidthMm?: number
  earSpacingMm?: number
  holeOffsetsPerUMm?: readonly number[]
  topSixths: number
  /** Lowest and highest sixth something is drawn at (placements outside the stack). */
  contentLowSixths?: number
  contentHighSixths?: number
}

export function rackLayout(input: RackLayoutInput): RackLayout {
  const panelWidthMm = input.panelWidthMm ?? PANEL_WIDTH_MM
  const innerWidthMm = Math.min(input.innerWidthMm ?? NOMINAL_OPENING_MM, panelWidthMm)
  const low = Math.min(0, input.contentLowSixths ?? 0)
  const high = Math.max(input.topSixths, input.contentHighSixths ?? 0)
  const bottomMm = sixthsToMm(low) - EDGE_MARGIN_MM
  const topMm = sixthsToMm(high) + EDGE_MARGIN_MM
  const leftX = -(U_LABEL_COLUMN_MM + SIDE_MARGIN_MM)
  const bandX = panelWidthMm + BAND_GAP_MM
  const rightX = bandX + BAND_WIDTH_MM + SIDE_MARGIN_MM
  return {
    panelWidthMm,
    innerWidthMm,
    railWidthMm: (panelWidthMm - innerWidthMm) / 2,
    earSpacingMm: input.earSpacingMm ?? EIA_EAR_SPACING_MM,
    holeOffsetsPerUMm: input.holeOffsetsPerUMm ?? EIA_HOLE_OFFSETS_PER_U_MM,
    topSixths: input.topSixths,
    topMm,
    bottomMm,
    leftX,
    rightX,
    bandX,
    bandWidth: BAND_WIDTH_MM,
    width: rightX - leftX,
    height: topMm - bottomMm,
  }
}

/** The `viewBox` attribute: the whole drawing, in mm. */
export function viewBoxOf(layout: RackLayout): string {
  return `${layout.leftX} 0 ${layout.width} ${layout.height}`
}

/** SVG y of a rack height in mm. */
export function svgYOfMm(layout: RackLayout, yMm: number): number {
  return layout.topMm - yMm
}

/** SVG y of a rack position in sixths. */
export function svgYOfSixths(layout: RackLayout, sixths: number): number {
  return svgYOfMm(layout, sixthsToMm(sixths))
}

/** Rack position (fractional sixths) at an SVG y. */
export function sixthsAtSvgY(layout: RackLayout, svgY: number): number {
  return (layout.topMm - svgY) / SIXTH_MM
}

/**
 * CSS px per mm at 100 % zoom: `BASE_PX_PER_MM`, or less when the container is too narrow for the
 * drawing (never below `MIN_BASE_PX_PER_MM`). An unmeasured container (0) gets the base.
 */
export function basePxPerMm(availableWidthPx: number, layout: RackLayout): number {
  if (!(availableWidthPx > 0) || !(layout.width > 0)) return BASE_PX_PER_MM
  const fit = availableWidthPx / layout.width
  return Math.max(MIN_BASE_PX_PER_MM, Math.min(BASE_PX_PER_MM, fit))
}

/** The zoom at which the whole drawing height fits `availableHeightPx` (not clamped). */
export function fitZoom(availableHeightPx: number, layout: RackLayout, basePx: number): number {
  if (!(availableHeightPx > 0) || !(layout.height > 0) || !(basePx > 0)) return 1
  return availableHeightPx / (layout.height * basePx)
}

// ---------------------------------------------------------------------------------------------
// Bays and boxes

/** Which half of the drawing a bay occupies. Seen from the rear, left and right swap. */
export type VisualSide = 'full' | 'left' | 'right'

export function visualSide(bay: PlacementBay, face: Face): VisualSide {
  if (bay === 'full' || face === 'front') return bay
  return bay === 'left' ? 'right' : 'left'
}

/** The bay a pointer at `xMm` picks for a half-width item (the inverse of `visualSide`). */
export function bayAtX(xMm: number, layout: RackLayout, face: Face): 'left' | 'right' {
  const leftHalf = xMm < layout.panelWidthMm / 2
  if (face === 'front') return leftHalf ? 'left' : 'right'
  return leftHalf ? 'right' : 'left'
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The panel of something mounted at `y` (sixths), `heightSixths` tall, in SVG coordinates: across
 * the whole panel width (or one half), 0.794 mm shorter than its nominal height and centred on it,
 * like a real panel.
 */
export function panelBox(
  layout: RackLayout,
  y: number,
  heightSixths: number,
  bay: PlacementBay,
  face: Face,
): Box {
  const side = visualSide(bay, face)
  const half = layout.panelWidthMm / 2
  const x = side === 'right' ? half : 0
  const width = side === 'full' ? layout.panelWidthMm : half
  const nominal = sixthsToMm(heightSixths)
  const height = heightSixths > 0 ? panelFaceHeightMm(heightSixths) : MIN_DRAWN_HEIGHT_MM
  const inset = heightSixths > 0 ? PANEL_HEIGHT_REDUCTION_MM / 2 : 0
  const top = svgYOfSixths(layout, y) - (heightSixths > 0 ? nominal : height) + inset
  return { x, y: top, width, height }
}

/** The opening between the rails (or the open side of a half-width item), inset a little. */
export function innerBox(box: Box, layout: RackLayout, side: VisualSide): Box {
  const left = side === 'right' ? box.x + 2 : box.x + layout.railWidthMm
  const right = side === 'left' ? box.x + box.width - 2 : box.x + box.width - layout.railWidthMm
  return {
    x: left,
    y: box.y + 1.5,
    width: Math.max(0, right - left),
    height: Math.max(0, box.height - 3),
  }
}

/**
 * X of a placement's slot origin ("left edge of the opening") in SVG coordinates: the rail's inner
 * edge for full-width items and items in the left half, the middle for the right half.
 */
export function openingOriginX(layout: RackLayout, bay: PlacementBay, face: Face): number {
  return visualSide(bay, face) === 'right' ? layout.panelWidthMm / 2 : layout.railWidthMm
}

/** X of the two ear-hole columns, centred on the panel. */
export function holeColumnsX(layout: RackLayout): [number, number] {
  const middle = layout.panelWidthMm / 2
  return [middle - layout.earSpacingMm / 2, middle + layout.earSpacingMm / 2]
}

/** Rail hole centres (rack mm, bottom to top) for the U's of a stack `topSixths` tall. */
export function railHoleYsMm(layout: RackLayout): number[] {
  const units = Math.floor(layout.topSixths / 6)
  const ys: number[] = []
  for (let u = 0; u < units; u++) {
    for (const offset of layout.holeOffsetsPerUMm) ys.push(sixthsToMm(u * 6) + offset)
  }
  return ys
}
