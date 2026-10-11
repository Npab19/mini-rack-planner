import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deviceKey,
  hardwareKey,
  newId,
  parseLineKey,
  partKey,
  printKey,
  randomToken,
  roundCutLengthMm,
} from './ids'
import { IdSchema } from './schema/common'

describe('newId', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('makes kebab-case ids that pass IdSchema', () => {
    const id = newId('sec')
    expect(id).toMatch(/^sec-[0-9a-z]{12}$/)
    expect(IdSchema.safeParse(id).success).toBe(true)
    expect(IdSchema.safeParse(newId()).success).toBe(true)
  })

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId('p')))
    expect(ids.size).toBe(2000)
  })

  it('rejects prefixes that would make an invalid id', () => {
    expect(() => newId('Section')).toThrow(/kebab-case/)
    expect(() => newId('a_b')).toThrow(/kebab-case/)
  })

  it('works without crypto.randomUUID (insecure origins)', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    expect(randomToken(20)).toMatch(/^[0-9a-z]{20}$/)
  })
})

describe('line keys', () => {
  it('formats keys', () => {
    expect(printKey('kws-v2', 'leg-6u')).toBe('print:kws-v2/leg-6u')
    expect(printKey('custom:my-frame', 'leg')).toBe('print:custom:my-frame/leg')
    expect(hardwareKey('m6x8-shcs')).toBe('hw:m6x8-shcs')
    expect(hardwareKey('extrusion-2020', 3 * 44.45)).toBe('hw:extrusion-2020@133.35')
    expect(hardwareKey('extrusion-2020', 250)).toBe('hw:extrusion-2020@250')
    expect(deviceKey('mac-mini-m4')).toBe('device:mac-mini-m4')
    expect(partKey('kws-v2', 'leg-6u')).toBe('kws-v2/leg-6u')
  })

  it('rounds cut lengths to 0.01 mm', () => {
    expect(roundCutLengthMm(133.35000000000002)).toBe(133.35)
    expect(roundCutLengthMm(99.996)).toBe(100)
  })

  it('parses keys back', () => {
    expect(parseLineKey(printKey('custom:my-frame', 'leg'))).toEqual({
      kind: 'print',
      ownerId: 'custom:my-frame',
      printId: 'leg',
    })
    expect(parseLineKey(hardwareKey('m6-nyloc'))).toEqual({
      kind: 'hardware',
      hardwareId: 'm6-nyloc',
    })
    expect(parseLineKey(hardwareKey('extrusion-2020', 264.7))).toEqual({
      kind: 'hardware',
      hardwareId: 'extrusion-2020',
      cutLengthMm: 264.7,
    })
    expect(parseLineKey(deviceKey('ms-01'))).toEqual({ kind: 'device', deviceId: 'ms-01' })
  })

  it('rejects malformed keys', () => {
    for (const key of [
      '',
      'print:',
      'print:leg',
      'print:/leg',
      'print:frame/',
      'hw:',
      'hw:x@',
      'hw:x@abc',
      'hw:x@1@2',
      'device:',
      'other:x',
    ]) {
      expect(parseLineKey(key)).toBeUndefined()
    }
  })
})
