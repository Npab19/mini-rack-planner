/**
 * Words for positions and the fitting of labels into the drawing. Pure.
 */
import { formatU, phaseOf, SIXTHS_PER_U, uNumberAt } from '@/domain/geometry'
import type { Ghost } from '../editorState'

/** First and last U a span [y, y + height) touches (a zero-height span touches the U at y). */
export function uSpan(y: number, heightSixths: number): { start: number; end: number } {
  return { start: uNumberAt(y), end: uNumberAt(y + Math.max(heightSixths, 1) - 1) }
}

/** "U3", or "U3 + ½U" for a start inside a U (the domain's wording in placement messages). */
export function startText(y: number): string {
  const phase = phaseOf(y)
  return `U${uNumberAt(y)}${phase === 0 ? '' : ` + ${formatU(phase)}`}`
}

/** "U4" or "U4–U9". */
export function rangeText(uStart: number, uEnd: number): string {
  return uStart === uEnd ? `U${uStart}` : `U${uStart}–U${uEnd}`
}

/**
 * Where something sits: "U4" or "U4–U5" for whole U's, else its start ("U3 + ½U"); the name of
 * the thing usually carries its height ("Blank panel ½U").
 */
export function positionText(y: number, heightSixths: number): string {
  if (phaseOf(y) !== 0 || heightSixths % SIXTHS_PER_U !== 0) return startText(y)
  const { start, end } = uSpan(y, heightSixths)
  return rangeText(start, end)
}

/** The words a ghost shows: "Fits at U4–U5", or the first reason it cannot go there. */
export function ghostText(ghost: Pick<Ghost, 'ok' | 'reasons' | 'y' | 'heightSixths'>): string {
  if (ghost.ok) return `Fits at ${positionText(ghost.y, ghost.heightSixths)}`
  return ghost.reasons[0] ?? 'It cannot go here.'
}

// ---------------------------------------------------------------------------------------------
// Fitting text into boxes

/** Average advance of a character, in em (Geist at UI sizes). Deliberately generous. */
export const CHAR_WIDTH_EM = 0.58

export function textWidthMm(text: string, fontSizeMm: number): number {
  return [...text].length * CHAR_WIDTH_EM * fontSizeMm
}

/** `text` cut to fit `widthMm` with an ellipsis; null when not even one character and "…" fit. */
export function truncateToWidth(text: string, widthMm: number, fontSizeMm: number): string | null {
  if (textWidthMm(text, fontSizeMm) <= widthMm) return text
  const chars = [...text]
  const room = Math.floor(widthMm / (CHAR_WIDTH_EM * fontSizeMm)) - 1
  if (room < 1) return null
  return `${chars.slice(0, room).join('').trimEnd()}…`
}

export interface LabelInput {
  name: string
  /** U range shown at the right ("U4–U5"); dropped first when space is short. */
  range?: string
  /** Show the "To get" tag (kept before the range when space is short). */
  tag?: boolean
  width: number
  height: number
  maxFontSize?: number
  minFontSize?: number
  /** Horizontal padding inside the box. */
  padding?: number
}

export interface LabelFit {
  fontSize: number
  name: string | null
  range: string | null
  tag: boolean
  /** Width the tag takes (0 without a tag). */
  tagWidth: number
}

export const TAG_TEXT = 'To get'
/** The tag is drawn at this fraction of the label size. */
export const TAG_FONT_SCALE = 0.8
const GAP_EM = 0.8
const MIN_NAME_CHARS = 4

export function tagWidthMm(fontSize: number): number {
  const tagFont = fontSize * TAG_FONT_SCALE
  return textWidthMm(TAG_TEXT, tagFont) + tagFont * 1.2
}

/**
 * What of a placement's label fits a box: the name on the left, the range and the "To get" tag
 * on the right. The font follows the box height (between `minFontSize` and `maxFontSize`). When
 * space is short the range goes first, then the name is shortened (keeping the tag: it says To
 * get in words), then the tag goes. Null when the box is too small for any text (the "Rack
 * contents" list names it anyway).
 */
export function fitLabel(input: LabelInput): LabelFit | null {
  const maxFont = input.maxFontSize ?? 8
  const minFont = input.minFontSize ?? 3.5
  const padding = input.padding ?? 3
  const fontSize = Math.min(maxFont, input.height * 0.55)
  if (fontSize < minFont) return null
  const available = input.width - 2 * padding
  if (available <= 0) return null
  const gap = GAP_EM * fontSize
  const nameWidth = textWidthMm(input.name, fontSize)
  const rangeWidth = input.range === undefined ? 0 : textWidthMm(input.range, fontSize)
  const tagWidth = input.tag === true ? tagWidthMm(fontSize) : 0
  const minName = Math.min(nameWidth, textWidthMm('x'.repeat(MIN_NAME_CHARS), fontSize))

  // Best first: everything in full; without the range; the name shortened but the tag kept
  // (it says To get in words); the name shortened alone.
  const attempts: Array<{ range: boolean; tag: boolean; shorten: boolean }> = [
    { range: true, tag: true, shorten: false },
    { range: false, tag: true, shorten: false },
    { range: false, tag: true, shorten: true },
    { range: false, tag: false, shorten: true },
  ]
  for (const attempt of attempts) {
    const withRange = attempt.range && input.range !== undefined
    const withTag = attempt.tag && input.tag === true
    const right = (withRange ? rangeWidth + gap : 0) + (withTag ? tagWidth + gap : 0)
    const nameRoom = available - right
    const name = attempt.shorten
      ? nameRoom >= minName
        ? truncateToWidth(input.name, nameRoom, fontSize)
        : null
      : nameWidth <= nameRoom
        ? input.name
        : null
    if (name === null) continue
    return {
      fontSize,
      name,
      range: withRange ? (input.range ?? null) : null,
      tag: withTag,
      tagWidth: withTag ? tagWidth : 0,
    }
  }
  return null
}
