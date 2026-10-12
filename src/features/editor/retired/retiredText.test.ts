import { describe, expect, it } from 'vitest'
import { removedOnText, retiredKindText, retiredTitle, spareText } from './retiredText'

describe('retiredText', () => {
  it('titles accessories with how many', () => {
    expect(retiredTitle({ kind: 'extra', name: 'Rubber feet', qty: 3 })).toBe('Rubber feet × 3')
    expect(retiredTitle({ kind: 'placement', name: 'Lenovo Tiny mount' })).toBe('Lenovo Tiny mount')
    expect(retiredKindText('cap')).toBe('Top or bottom')
  })

  it('words a spare part by its unit', () => {
    expect(spareText({ kind: 'print', label: 'Tiny mount', qty: 1, unit: 'plates' })).toBe(
      '1 × Tiny mount (printed)',
    )
    expect(spareText({ kind: 'hardware', label: 'M5×10 screw', qty: 4, unit: 'pcs' })).toBe(
      '4 × M5×10 screw',
    )
    expect(spareText({ kind: 'hardware', label: '2020 rail', qty: 120, unit: 'mm' })).toBe(
      '120 mm of 2020 rail',
    )
  })

  it('dates in the given locale, and copes with a broken date', () => {
    expect(removedOnText('2026-10-11T12:00:00.000Z', 'en-GB')).toBe('11 Oct 2026')
    expect(removedOnText('not a date')).toBe('an unknown day')
  })
})
