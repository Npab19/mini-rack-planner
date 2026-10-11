import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { Base64UrlError, base64UrlLength, decodeBase64Url, encodeBase64Url } from './base64url'

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

// RFC 4648 §10 test vectors, without padding.
const VECTORS: ReadonlyArray<[string, string]> = [
  ['', ''],
  ['f', 'Zg'],
  ['fo', 'Zm8'],
  ['foo', 'Zm9v'],
  ['foob', 'Zm9vYg'],
  ['fooba', 'Zm9vYmE'],
  ['foobar', 'Zm9vYmFy'],
]

describe('encodeBase64Url', () => {
  it.each(VECTORS)('encodes "%s" as "%s"', (input, encoded) => {
    expect(encodeBase64Url(utf8(input))).toBe(encoded)
  })

  it('uses the URL-safe alphabet', () => {
    // Standard base64 would be "+/8=".
    expect(encodeBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8')
    expect(encodeBase64Url(new Uint8Array([0xff, 0xff, 0xff]))).toBe('____')
  })

  it('predicts the text length', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(base64UrlLength)).toEqual([0, 2, 3, 4, 6, 7, 8])
  })
})

describe('decodeBase64Url', () => {
  it.each(VECTORS)('decodes "%s" from "%s"', (input, encoded) => {
    expect(decodeBase64Url(encoded)).toEqual(utf8(input))
  })

  it('rejects padding, other alphabets, whitespace and non-ASCII', () => {
    for (const text of ['Zg==', 'Zm9v+A', 'Zm9v/A', 'Zm 9v', 'Zm9vé']) {
      expect(() => decodeBase64Url(text)).toThrow(Base64UrlError)
    }
  })

  it('rejects impossible lengths and non-zero padding bits', () => {
    expect(() => decodeBase64Url('Zm9vY')).toThrow(/length/)
    // "Zh" carries "f" plus a stray low bit; only "Zg" is canonical.
    expect(() => decodeBase64Url('Zh')).toThrow(/padding bits/)
    expect(() => decodeBase64Url('Zm9')).toThrow(/padding bits/)
  })

  test.prop([fc.uint8Array({ maxLength: 400 })])(
    'round-trips any bytes like Node does',
    (bytes) => {
      const text = encodeBase64Url(bytes)
      expect(text).toBe(Buffer.from(bytes).toString('base64url'))
      expect(text).toHaveLength(base64UrlLength(bytes.length))
      expect(decodeBase64Url(text)).toEqual(bytes)
    },
  )

  test.prop([fc.string({ maxLength: 40 })])(
    'accepts only canonical text: whatever decodes encodes back to itself',
    (text) => {
      let bytes: Uint8Array
      try {
        bytes = decodeBase64Url(text)
      } catch (error) {
        expect(error).toBeInstanceOf(Base64UrlError)
        return
      }
      expect(encodeBase64Url(bytes)).toBe(text)
    },
  )
})
