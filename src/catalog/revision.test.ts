import { describe, expect, it } from 'vitest'
import { canonicalJson, catalogRevision, hash53 } from './revision'

describe('canonicalJson', () => {
  it('sorts object keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    )
  })

  it('drops undefined fields like JSON.stringify', () => {
    expect(canonicalJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}')
    expect(canonicalJson(undefined)).toBe('null')
  })
})

describe('hash53', () => {
  it('is deterministic and spreads small changes', () => {
    expect(hash53('kws-rack-v2')).toBe(hash53('kws-rack-v2'))
    expect(hash53('kws-rack-v2')).not.toBe(hash53('kws-rack-v3'))
    expect(hash53('')).toBeLessThan(2 ** 53)
  })
})

describe('catalogRevision', () => {
  const a = { id: 'a', raw: { kind: 'hardware', id: 'a' } }
  const b = { id: 'b', raw: { kind: 'hardware', id: 'b' } }

  it('does not depend on the input order', () => {
    expect(catalogRevision([a, b])).toBe(catalogRevision([b, a]))
  })

  it('changes when an entry is added or edited', () => {
    const base = catalogRevision([a, b])
    expect(catalogRevision([a])).not.toBe(base)
    expect(catalogRevision([a, { ...b, raw: { ...b.raw, name: 'B' } }])).not.toBe(base)
  })

  it('is a fixed-width hex string', () => {
    expect(catalogRevision([])).toMatch(/^[0-9a-f]{14}$/)
  })
})
