import { describe, expect, it } from 'vitest'
import { RAW_DEVICE, RAW_FRAME, RAW_MOUNT, testModules } from './__fixtures__/entries'
import { loadCatalogFromModules } from './loader'

function messagesFor(modules: Record<string, unknown>, path: string): string[] {
  return loadCatalogFromModules(modules)
    .errors.filter((error) => error.path === path)
    .map((error) => error.message)
}

describe('loadCatalogFromModules', () => {
  it('loads every valid entry into the lookup', () => {
    const catalog = loadCatalogFromModules(testModules())
    expect(catalog.errors).toEqual([])
    expect(catalog.entries).toHaveLength(8)
    expect(catalog.lookup.frame('test-frame')?.name).toBe('Test frame')
    expect(catalog.lookup.item('lenovo-tiny-mount')?.slots[0]?.orientations).toEqual([
      'flat',
      'flat-rotated',
    ])
    expect(catalog.lookup.device('lenovo-m720q')?.brand).toBe('Lenovo')
    expect(catalog.lookup.hardware('screw-m5x10-shcs')?.unit).toBe('pcs')
    expect(catalog.lookup.allHardware()).toHaveLength(4)
  })

  it('skips a document that fails the schema and says why', () => {
    const modules = testModules()
    modules['/catalog/devices/lenovo-m720q.json'] = { ...RAW_DEVICE, dims: { w: 179, d: 183 } }
    const catalog = loadCatalogFromModules(modules)
    expect(catalog.lookup.device('lenovo-m720q')).toBeUndefined()
    expect(catalog.errors).toEqual([
      { path: 'devices/lenovo-m720q.json', message: expect.stringMatching(/^dims\.h: /) },
    ])
  })

  it('checks the folder and the file name', () => {
    const modules = testModules()
    modules['/catalog/items/lenovo-m720q.json'] = RAW_DEVICE
    modules['/catalog/frames/other-name.json'] = { ...RAW_FRAME, id: 'renamed-frame' }
    modules['/catalog/items/custom-thing.json'] = { ...RAW_MOUNT, id: 'custom:thing' }
    expect(messagesFor(modules, 'items/lenovo-m720q.json')).toEqual([
      'kind "device" does not belong in items/ (move it to devices/)',
    ])
    expect(messagesFor(modules, 'frames/other-name.json')).toEqual([
      'id "renamed-frame" must match the file name (other-name.json)',
    ])
    expect(messagesFor(modules, 'items/custom-thing.json')[0]).toContain('"custom:" ids')
  })

  it('reports entry integrity problems', () => {
    const modules = testModules()
    modules['/catalog/frames/test-frame.json'] = {
      ...RAW_FRAME,
      recipe: [{ id: 'legs', unit: 'section', ref: { print: 'missing' }, count: 4 }],
    }
    expect(messagesFor(modules, 'frames/test-frame.json')).toEqual([
      'recipe line "legs": unknown print "missing"',
    ])
  })

  it('keeps the first of two entries with the same id', () => {
    const modules = testModules()
    modules['/catalog/hardware/lenovo-m720q.json'] = {
      kind: 'hardware',
      id: 'lenovo-m720q',
      name: 'Clash',
      category: 'other',
    }
    const catalog = loadCatalogFromModules(modules)
    expect(catalog.lookup.device('lenovo-m720q')).toBeDefined()
    expect(catalog.lookup.hardware('lenovo-m720q')).toBeUndefined()
    expect(catalog.errors).toEqual([
      {
        path: 'hardware/lenovo-m720q.json',
        message: 'id "lenovo-m720q" is already used by devices/lenovo-m720q.json',
      },
    ])
  })

  it('rejects files outside the entry folders', () => {
    const modules = { ...testModules(), '/catalog/schema/frame.schema.json': { type: 'object' } }
    expect(messagesFor(modules, 'schema/frame.schema.json')[0]).toMatch(/^not an entry file/)
  })

  it('computes a revision that ignores order but follows content', () => {
    const modules = testModules()
    const revision = loadCatalogFromModules(modules).revision
    expect(revision).toMatch(/^[0-9a-f]{14}$/)

    const reversed = Object.fromEntries(Object.entries(modules).toReversed())
    expect(loadCatalogFromModules(reversed).revision).toBe(revision)

    const reorderedKeys = Object.fromEntries(Object.entries(RAW_DEVICE).toReversed())
    const sameContent = { ...modules, '/catalog/devices/lenovo-m720q.json': reorderedKeys }
    expect(loadCatalogFromModules(sameContent).revision).toBe(revision)

    const heavier = { ...RAW_DEVICE, weightG: 1320 }
    const changed = { ...modules, '/catalog/devices/lenovo-m720q.json': heavier }
    expect(loadCatalogFromModules(changed).revision).not.toBe(revision)
  })

  it('returns an empty, healthy catalog for no modules', () => {
    const catalog = loadCatalogFromModules({})
    expect(catalog.entries).toEqual([])
    expect(catalog.errors).toEqual([])
    expect(catalog.lookup.allFrames()).toEqual([])
  })
})
