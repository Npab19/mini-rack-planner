import { describe, expect, it } from 'vitest'
import { crc32 } from './crc32'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('continues across chunks of any size', () => {
    const data = new Uint8Array(1000).map((_, i) => (i * 31 + 7) & 0xff)
    const whole = crc32(data)
    for (const split of [1, 7, 8, 9, 500, 999]) {
      expect(crc32(data.subarray(split), crc32(data.subarray(0, split)))).toBe(whole)
    }
  })
})
