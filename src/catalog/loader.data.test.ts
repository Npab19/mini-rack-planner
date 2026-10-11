/**
 * The bundled catalog (`import.meta.glob`) must load exactly what the Node reader loads. This
 * asserts no catalog values, only that the glob pattern finds every entry file: a broken pattern
 * would otherwise ship an empty catalog. Invalid files fail here too; `npm run validate-catalog`
 * says why.
 */
import { describe, expect, it } from 'vitest'
import { loadCatalogFromDisk } from '../../scripts/lib/catalogFs'
import { loadBundledCatalog } from './loader'

describe('loadBundledCatalog', () => {
  it('loads every entry file, like the Node reader, with the same revision', () => {
    const bundled = loadBundledCatalog()
    const disk = loadCatalogFromDisk()
    const ids = (entries: ReadonlyArray<{ id: string }>): string[] =>
      entries.map((entry) => entry.id).toSorted()
    expect(bundled.errors).toEqual([])
    expect(bundled.entries.length).toBeGreaterThan(0)
    expect(ids(bundled.entries)).toEqual(ids(disk.entries))
    expect(bundled.revision).toBe(disk.revision)
  })

  it('validates once and reuses the result', () => {
    expect(loadBundledCatalog()).toBe(loadBundledCatalog())
  })
})
