import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import {
  parseDecimal,
  parseDecimalString,
  parseIntegerString,
  parseNumberList,
  parseUint32,
  roundTo,
} from './numbers'

const decimal = (text: string): number => {
  const bytes = new TextEncoder().encode(text)
  return parseDecimal(bytes, 0, bytes.length)
}

const uint = (text: string): number => {
  const bytes = new TextEncoder().encode(text)
  return parseUint32(bytes, 0, bytes.length)
}

describe('parseDecimal', () => {
  it.each([
    ['0', 0],
    ['-0.5', -0.5],
    ['+12.25', 12.25],
    ['.5', 0.5],
    ['5.', 5],
    ['1e3', 1000],
    ['1.5E-3', 0.0015],
    ['-2.5e+02', -250],
    ['0.000123', 0.000123],
    ['  42 ', 42],
    ['123456789012345678901', Number('123456789012345678901')],
  ])('parses %s', (text, expected) => {
    expect(decimal(text)).toBe(expected)
  })

  it.each(['', ' ', '-', '.', 'e5', '1e', '1e+', '--1', '1 2', 'nan', 'Infinity', '0x10', '1,5'])(
    'rejects %j',
    (text) => {
      expect(decimal(text)).toBeNaN()
    },
  )

  test.prop([fc.double({ noNaN: true, noDefaultInfinity: true })])(
    'round-trips doubles to float32',
    (value) => {
      // Coordinates end up in Float32Array, so agreement at float32 precision is what matters.
      expect(Math.fround(decimal(String(value)))).toBe(Math.fround(Number(String(value))))
    },
  )

  test.prop([fc.float({ noNaN: true, noDefaultInfinity: true }), fc.integer({ min: 1, max: 9 })])(
    'reads exponent notation like Number()',
    (value, digits) => {
      const text = value.toExponential(digits)
      expect(Math.fround(decimal(text))).toBe(Math.fround(Number(text)))
    },
  )
})

describe('integer parsing', () => {
  it('parses uint32 values and rejects everything else', () => {
    expect(uint('0')).toBe(0)
    expect(uint(' 4294967295 ')).toBe(4294967295)
    expect(uint('4294967296')).toBe(-1)
    expect(uint('-1')).toBe(-1)
    expect(uint('1.0')).toBe(-1)
    expect(uint('')).toBe(-1)
  })

  it('parses strict integer strings', () => {
    expect(parseIntegerString('12')).toBe(12)
    expect(parseIntegerString(' 7 ')).toBe(7)
    expect(parseIntegerString('1e3')).toBeUndefined()
    expect(parseIntegerString('-3')).toBeUndefined()
    expect(parseIntegerString(undefined)).toBeUndefined()
  })
})

describe('string number lists', () => {
  it('parses transform-like lists strictly', () => {
    expect(parseNumberList('1 0 0\n0 1 0\t0 0 1  10 20 30')).toEqual([
      1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 20, 30,
    ])
    expect(parseNumberList('')).toEqual([])
    expect(parseNumberList('1 two 3')).toBeUndefined()
    expect(parseDecimalString('0x10')).toBeNaN()
    expect(parseDecimalString('1.5e2')).toBe(150)
  })
})

describe('roundTo', () => {
  it('rounds to the given decimals and never returns -0', () => {
    expect(roundTo(133.35000000000002, 3)).toBe(133.35)
    expect(roundTo(1.005, 0)).toBe(1)
    expect(roundTo(2.675, 1)).toBe(2.7)
    expect(Object.is(roundTo(-0.0001, 2), 0)).toBe(true)
  })
})
