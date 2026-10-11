/**
 * Byte-level number parsing for the streaming 3MF scanner and the ASCII STL reader: no per-number
 * strings, which matters at millions of coordinates. Also the rounding used by reports.
 */

const ZERO = 48
const PLUS = 43
const MINUS = 45
const DOT = 46
const LOWER_E = 101
const UPPER_E = 69
/** Doubles hold 15-17 significant decimal digits; later digits cannot change a float32 result. */
const MAX_DIGITS = 17
/** 10^0..10^22 are exact in binary64, so mantissa × or ÷ these is correctly rounded. */
const EXACT_POWERS_OF_TEN = Array.from({ length: 23 }, (_, i) => 10 ** i)

export function isXmlWhitespace(byte: number): boolean {
  return byte === 32 || byte === 10 || byte === 13 || byte === 9
}

/**
 * Parses a decimal number (optional sign, digits, fraction, exponent) from `bytes[start, end)`,
 * ignoring surrounding whitespace. Returns NaN unless the whole range is one valid number.
 */
export function parseDecimal(bytes: Uint8Array, start: number, end: number): number {
  let i = start
  let stop = end
  while (i < stop && isXmlWhitespace(bytes[i]!)) i++
  while (stop > i && isXmlWhitespace(bytes[stop - 1]!)) stop--
  if (i >= stop) return Number.NaN

  let negative = false
  const sign = bytes[i]!
  if (sign === MINUS || sign === PLUS) {
    negative = sign === MINUS
    i++
  }

  let mantissa = 0
  let digits = 0
  let exponent = 0
  let sawDigit = false

  for (; i < stop; i++) {
    const digit = bytes[i]! - ZERO
    if (digit < 0 || digit > 9) break
    sawDigit = true
    if (digits < MAX_DIGITS) {
      // Leading zeros are not significant, so they must not use up the digit budget.
      if (mantissa !== 0 || digit !== 0) {
        mantissa = mantissa * 10 + digit
        digits++
      }
    } else {
      exponent++
    }
  }

  if (i < stop && bytes[i] === DOT) {
    for (i++; i < stop; i++) {
      const digit = bytes[i]! - ZERO
      if (digit < 0 || digit > 9) break
      sawDigit = true
      if (digits < MAX_DIGITS) {
        if (mantissa !== 0 || digit !== 0) {
          mantissa = mantissa * 10 + digit
          digits++
        }
        exponent--
      }
    }
  }
  if (!sawDigit) return Number.NaN

  if (i < stop && (bytes[i] === LOWER_E || bytes[i] === UPPER_E)) {
    i++
    let negativeExponent = false
    if (i < stop && (bytes[i] === MINUS || bytes[i] === PLUS)) {
      negativeExponent = bytes[i] === MINUS
      i++
    }
    let value = 0
    let exponentDigits = 0
    for (; i < stop; i++) {
      const digit = bytes[i]! - ZERO
      if (digit < 0 || digit > 9) break
      // Clamp silly exponents; anything this large is already 0 or Infinity.
      if (value < 100_000) value = value * 10 + digit
      exponentDigits++
    }
    if (exponentDigits === 0) return Number.NaN
    exponent += negativeExponent ? -value : value
  }
  if (i !== stop) return Number.NaN

  let result: number
  if (mantissa === 0) result = 0
  else if (exponent === 0) result = mantissa
  else if (exponent > 0 && exponent <= 22) result = mantissa * EXACT_POWERS_OF_TEN[exponent]!
  else if (exponent < 0 && exponent >= -22) result = mantissa / EXACT_POWERS_OF_TEN[-exponent]!
  else result = mantissa * 10 ** exponent
  return negative ? -result : result
}

/**
 * Parses a non-negative 32-bit integer from `bytes[start, end)`, ignoring surrounding whitespace.
 * Returns -1 unless the whole range is decimal digits that fit in uint32.
 */
export function parseUint32(bytes: Uint8Array, start: number, end: number): number {
  let i = start
  let stop = end
  while (i < stop && isXmlWhitespace(bytes[i]!)) i++
  while (stop > i && isXmlWhitespace(bytes[stop - 1]!)) stop--
  if (i >= stop) return -1
  let value = 0
  for (; i < stop; i++) {
    const digit = bytes[i]! - ZERO
    if (digit < 0 || digit > 9) return -1
    value = value * 10 + digit
    if (value > 0xffffffff) return -1
  }
  return value
}

const ST_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/** Strict string form of parseDecimal for attribute values (transforms, config numbers). */
export function parseDecimalString(text: string): number {
  const trimmed = text.trim()
  return ST_NUMBER.test(trimmed) ? Number(trimmed) : Number.NaN
}

/** Splits a whitespace-separated list of numbers; undefined if any token is not a number. */
export function parseNumberList(text: string): number[] | undefined {
  const tokens = text.trim().split(/\s+/)
  if (tokens.length === 1 && tokens[0] === '') return []
  const values: number[] = []
  for (const token of tokens) {
    const value = parseDecimalString(token)
    if (!Number.isFinite(value)) return undefined
    values.push(value)
  }
  return values
}

/** Strict non-negative integer (3MF resource ids, vertex indices in configs). */
export function parseIntegerString(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const trimmed = text.trim()
  if (!/^\d{1,15}$/.test(trimmed)) return undefined
  return Number(trimmed)
}

/** Rounds to `decimals` places for reports and fingerprints; `+ 0` turns -0 into 0. */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor + 0
}
