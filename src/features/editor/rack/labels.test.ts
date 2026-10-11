import { describe, expect, it } from 'vitest'
import {
  CHAR_WIDTH_EM,
  fitLabel,
  ghostText,
  positionText,
  rangeText,
  startText,
  tagWidthMm,
  textWidthMm,
  truncateToWidth,
  uSpan,
} from './labels'

describe('positions in words', () => {
  it('spans whole U ranges, and a zero-height marker its own U', () => {
    expect(uSpan(0, 6)).toEqual({ start: 1, end: 1 })
    expect(uSpan(18, 12)).toEqual({ start: 4, end: 5 })
    expect(uSpan(15, 3)).toEqual({ start: 3, end: 3 })
    expect(uSpan(12, 0)).toEqual({ start: 3, end: 3 })
  })

  it('says where something starts, inside a U too', () => {
    expect(startText(12)).toBe('U3')
    expect(startText(15)).toBe('U3 + ½U')
    expect(startText(14)).toBe('U3 + ⅓U')
  })

  it('names whole-U spans by range and anything else by its start', () => {
    expect(positionText(18, 6)).toBe('U4')
    expect(positionText(18, 12)).toBe('U4–U5')
    expect(positionText(54, 18)).toBe('U10–U12')
    expect(positionText(15, 3)).toBe('U3 + ½U')
    expect(positionText(12, 9)).toBe('U3')
    expect(rangeText(4, 9)).toBe('U4–U9')
    expect(rangeText(7, 7)).toBe('U7')
  })

  it('words a ghost: where it fits, else the first reason', () => {
    expect(ghostText({ ok: true, reasons: [], y: 24, heightSixths: 12 })).toBe('Fits at U5–U6')
    expect(
      ghostText({
        ok: false,
        reasons: ['It overlaps Blank (U5).', 'Second'],
        y: 24,
        heightSixths: 6,
      }),
    ).toBe('It overlaps Blank (U5).')
    expect(ghostText({ ok: false, reasons: [], y: 0, heightSixths: 6 })).toBe('It cannot go here.')
  })
})

describe('fitting text', () => {
  it('estimates widths from the character count', () => {
    expect(textWidthMm('abcd', 10)).toBeCloseTo(4 * CHAR_WIDTH_EM * 10)
    expect(textWidthMm('½U', 5)).toBeCloseTo(2 * CHAR_WIDTH_EM * 5)
  })

  it('cuts long text with an ellipsis that fits, and gives up below one character', () => {
    expect(truncateToWidth('Blank', 100, 5)).toBe('Blank')
    const cut = truncateToWidth('Lenovo ThinkCentre M920q Tiny', 40, 5)
    expect(cut).toMatch(/…$/)
    expect(textWidthMm(cut ?? '', 5)).toBeLessThanOrEqual(40)
    expect(truncateToWidth('Lenovo', 2, 5)).toBeNull()
  })

  const base = { name: 'Lenovo Tiny mount 1U', range: 'U4–U5', tag: true }

  it('shows the name, the range and the To get tag when there is room', () => {
    const fit = fitLabel({ ...base, width: 230, height: 43.6 })
    expect(fit).toMatchObject({ name: 'Lenovo Tiny mount 1U', range: 'U4–U5', tag: true })
    expect(fit?.fontSize).toBe(8)
    expect(fit?.tagWidth).toBeCloseTo(tagWidthMm(8))
  })

  it('drops the range first, then shortens the name (keeping the tag), then drops the tag', () => {
    const name = textWidthMm(base.name, 8)
    const tag = tagWidthMm(8)
    const gap = 0.8 * 8
    const withoutRange = fitLabel({ ...base, width: name + tag + gap + 6 + 1, height: 43.6 })
    expect(withoutRange).toMatchObject({ range: null, tag: true, name: base.name })
    const shortened = fitLabel({ ...base, width: name + 6 + 1, height: 43.6 })
    expect(shortened).toMatchObject({ range: null, tag: true })
    expect(shortened?.name).toMatch(/…$/)
    const tagless = fitLabel({ ...base, width: 25 + 6, height: 43.6 })
    expect(tagless).toMatchObject({ range: null, tag: false })
    expect(tagless?.name).toMatch(/^Leno.*…$/)
  })

  it('keeps an owned item free of the tag', () => {
    const fit = fitLabel({ ...base, tag: false, width: 230, height: 43.6 })
    expect(fit).toMatchObject({ name: base.name, range: 'U4–U5', tag: false, tagWidth: 0 })
  })

  it('sizes the font to the box and leaves too-small boxes empty', () => {
    expect(fitLabel({ ...base, width: 230, height: 10 })?.fontSize).toBeCloseTo(5.5)
    expect(fitLabel({ ...base, width: 230, height: 4 })).toBeNull()
    expect(fitLabel({ ...base, width: 4, height: 43.6 })).toBeNull()
  })

  it('shows a short name in full rather than an ellipsis', () => {
    const fit = fitLabel({ name: 'Fan', tag: false, width: 20, height: 43.6 })
    expect(fit?.name).toBe('Fan')
  })
})
