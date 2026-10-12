import { describe, expect, it } from 'vitest'
import { ItemSchema } from '@/domain/schema/catalog'
import { KWS_IDS, kwsCatalog } from '@/domain/__fixtures__/kws'
import { contentsText, haveStatus, isAre } from './extrasView'

const VERIFIED = { by: 'test', date: '2026-10-11', method: 'page' } as const

describe('contentsText', () => {
  it('names what one accessory is made of, prints and hardware, from plain counts', () => {
    const item = ItemSchema.parse({
      kind: 'extra',
      id: 'feet-kit',
      name: 'Feet kit',
      category: 'accessory',
      verified: VERIFIED,
      heightSixths: 0,
      depthMm: 0,
      prints: [{ id: 'pads', plate: 'Pads', label: 'Foot pads' }],
      recipe: [
        { id: 'pads', unit: 'item', ref: { print: 'pads' }, count: 1 },
        { id: 'feet', unit: 'item', ref: { hardware: KWS_IDS.rubberFoot }, count: 4 },
        { id: 'formula', unit: 'item', ref: { hardware: KWS_IDS.m5x10 }, count: { perU: 2 } },
        { id: 'unknown', unit: 'item', ref: { hardware: 'mystery-bolt' }, count: 2 },
        {
          id: 'screws',
          unit: 'item',
          ref: { hardware: KWS_IDS.m5x10 },
          count: 4,
          role: 'rack-mount',
        },
      ],
    })
    expect(contentsText(item, kwsCatalog())).toBe(
      '1 × Foot pads (printed), 4 × Adhesive rubber foot 10×3 mm, 2 × mystery-bolt',
    )
  })

  it('is undefined for an accessory without a recipe', () => {
    const item = ItemSchema.parse({
      kind: 'extra',
      id: 'label',
      name: 'Label',
      category: 'accessory',
      verified: VERIFIED,
      heightSixths: 0,
      depthMm: 0,
    })
    expect(contentsText(item, kwsCatalog())).toBeUndefined()
  })
})

describe('haveStatus', () => {
  it('says what is in my rack and what is to get, in words', () => {
    expect(haveStatus({ qty: 4, haveQty: 4 })).toEqual({ allHave: true, text: 'All 4 in my rack' })
    expect(haveStatus({ qty: 4, haveQty: 6 })).toEqual({ allHave: true, text: 'All 4 in my rack' })
    expect(haveStatus({ qty: 4, haveQty: 0 })).toEqual({ allHave: false, text: '4 to get' })
    expect(haveStatus({ qty: 4, haveQty: 1 })).toEqual({
      allHave: false,
      text: '1 in my rack · 3 to get',
    })
    expect([isAre(1), isAre(2)]).toEqual(['is', 'are'])
  })
})
