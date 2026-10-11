import { describe, expect, it } from 'vitest'
import { normalizePartName, PartIndex, parseRelationships } from './opc'
import type { ZipEntry } from './zip'

function entries(...names: string[]): ZipEntry[] {
  return names.map((name, index) => ({
    index,
    name,
    method: 8,
    flags: 0,
    crc32: 0,
    compressedSize: 0,
    size: 0,
    localHeaderOffset: 0,
    isDirectory: name.endsWith('/'),
    encrypted: false,
  }))
}

describe('normalizePartName', () => {
  it.each([
    ['/3D/3dmodel.model', '', '3D/3dmodel.model'],
    ['3dmodel.model', '3D/', '3D/3dmodel.model'],
    ['Objects/./a.model', '3D/', '3D/Objects/a.model'],
    ['../Metadata/x.config', '3D/', 'Metadata/x.config'],
    ['\\3D\\Objects\\b.model', '', '3D/Objects/b.model'],
  ])('%s from %j -> %s', (target, base, expected) => {
    expect(normalizePartName(target, base)).toBe(expected)
  })

  it('rejects paths that leave the package', () => {
    expect(normalizePartName('../../etc/passwd', '3D/')).toBeUndefined()
    expect(normalizePartName('/', '')).toBeUndefined()
  })
})

describe('PartIndex', () => {
  const index = new PartIndex(
    entries(
      '3D/',
      '3D/3dmodel.model',
      '3D/Objects/Leg 6U_2.model',
      '3D/Objects/Ecke_7.model',
      '3D/Objects/Ecke-alt_7.model',
      '3D/Objects/Füße_9.model',
    ),
  )

  it('resolves exact, URI-encoded and differently cased names', () => {
    expect(index.resolve('/3D/3dmodel.model')).toMatchObject({ match: 'exact' })
    expect(index.resolve('/3D/Objects/Leg%206U_2.model')).toMatchObject({
      match: 'uri-decoded',
      entry: { name: '3D/Objects/Leg 6U_2.model' },
    })
    expect(index.resolve('/3D/OBJECTS/füße_9.model')).toMatchObject({ match: 'case-insensitive' })
  })

  it('falls back to a unique _<id>.model suffix in the same folder', () => {
    expect(index.resolve('/3D/Objects/Fuesse_9.model')).toMatchObject({
      match: 'id-suffix',
      entry: { name: '3D/Objects/Füße_9.model' },
    })
    // Two candidates end in _7.model: ambiguous, so no guess.
    expect(index.resolve('/3D/Objects/Corner_7.model')).toBeUndefined()
    // Another folder never matches.
    expect(index.resolve('/Other/Leg_2.model')).toBeUndefined()
  })

  it('lists model parts', () => {
    expect(index.modelEntries().map((entry) => entry.name)).toHaveLength(5)
  })
})

describe('parseRelationships', () => {
  it('returns targets and types', () => {
    const xml =
      '<Relationships xmlns="x"><Relationship Target="/3D/3dmodel.model" Id="r1" Type="t/3dmodel"/><Relationship Id="r2"/></Relationships>'
    expect(parseRelationships(xml)).toEqual([{ target: '/3D/3dmodel.model', type: 't/3dmodel' }])
  })
})
