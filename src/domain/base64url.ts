/**
 * base64url (RFC 4648 §5) without padding, for share links.
 *
 * Own implementation on Uint8Array: btoa/atob work on binary strings, and this keeps the codec
 * identical in browsers, workers and Node. Decoding is strict (alphabet, length and zero trailing
 * bits), so every byte sequence has exactly one accepted text.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Character code -> 6-bit value; -1 outside the alphabet. */
const SEXTET_OF = buildSextetTable()

function buildSextetTable(): Int8Array {
  const table = new Int8Array(128).fill(-1)
  for (let index = 0; index < ALPHABET.length; index++) table[ALPHABET.charCodeAt(index)] = index
  return table
}

export class Base64UrlError extends Error {
  override name = 'Base64UrlError'
}

/** Length of the unpadded base64url text for `byteLength` bytes. */
export function base64UrlLength(byteLength: number): number {
  return Math.ceil((byteLength * 4) / 3)
}

function byteAt(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? 0
}

function charOf(bits24: number, shift: number): string {
  return ALPHABET.charAt((bits24 >> shift) & 63)
}

export function encodeBase64Url(bytes: Uint8Array): string {
  const wholeGroups = bytes.length - (bytes.length % 3)
  let text = ''
  for (let index = 0; index < wholeGroups; index += 3) {
    const bits24 =
      (byteAt(bytes, index) << 16) | (byteAt(bytes, index + 1) << 8) | byteAt(bytes, index + 2)
    text += charOf(bits24, 18) + charOf(bits24, 12) + charOf(bits24, 6) + charOf(bits24, 0)
  }
  const rest = bytes.length - wholeGroups
  if (rest === 1) {
    const bits24 = byteAt(bytes, wholeGroups) << 16
    text += charOf(bits24, 18) + charOf(bits24, 12)
  } else if (rest === 2) {
    const bits24 = (byteAt(bytes, wholeGroups) << 16) | (byteAt(bytes, wholeGroups + 1) << 8)
    text += charOf(bits24, 18) + charOf(bits24, 12) + charOf(bits24, 6)
  }
  return text
}

function sextetAt(text: string, index: number): number {
  const code = text.charCodeAt(index)
  const value = code < 128 ? (SEXTET_OF[code] ?? -1) : -1
  if (value < 0) throw new Base64UrlError(`Invalid base64url character at position ${index}`)
  return value
}

/** @throws Base64UrlError on characters outside the alphabet, padding, or an impossible length. */
export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> {
  // 4 characters carry 3 bytes; a lone character in the last group cannot carry a whole byte.
  if (text.length % 4 === 1) throw new Base64UrlError('Invalid base64url length')
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4))
  let pending = 0
  let pendingBits = 0
  let byteIndex = 0
  for (let index = 0; index < text.length; index++) {
    pending = ((pending << 6) | sextetAt(text, index)) & 0xffffff
    pendingBits += 6
    if (pendingBits >= 8) {
      pendingBits -= 8
      bytes[byteIndex++] = (pending >> pendingBits) & 0xff
    }
  }
  if ((pending & ((1 << pendingBits) - 1)) !== 0) {
    throw new Base64UrlError('Invalid base64url ending (non-zero padding bits)')
  }
  return bytes
}
