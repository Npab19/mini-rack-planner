import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDbForTests } from '@/db/db'
import { deleteLibraryEntry, putLibraryEntry } from '@/db/libraryRepo'
import { samplePlan } from '@/domain/__fixtures__/samplePlan'
import { getCatalog, lookupForPlan, startLibrarySync, stopLibrarySync } from './catalogStore'

const PART = {
  kind: 'device',
  id: 'custom:lab-switch',
  brand: 'DIY',
  model: 'Lab switch',
  category: 'switch',
  dims: { w: 200, d: 100, h: 30 },
  verified: { by: 'me', date: '2026-10-01', method: 'calipers' },
}

beforeEach(async () => {
  await resetDbForTests()
})

afterEach(() => {
  stopLibrarySync()
})

describe('catalogStore', () => {
  it('starts from the bundled catalog', () => {
    const catalog = getCatalog()
    expect(catalog.catalogRev).toMatch(/^[0-9a-f]{14}$/)
    expect(catalog.lookup.allFrames().length).toBeGreaterThan(0)
    expect(catalog.problems).toEqual([])
  })

  it('follows the library: added and removed parts change the lookup', async () => {
    startLibrarySync()
    await vi.waitFor(() => expect(getCatalog().libraryLoaded).toBe(true))
    const before = getCatalog().revision
    await putLibraryEntry(PART)
    await vi.waitFor(() => expect(getCatalog().lookup.device(PART.id)?.model).toBe('Lab switch'))
    expect(getCatalog().revision).toBeGreaterThan(before)
    expect(getCatalog().library.map((entry) => entry.id)).toEqual([PART.id])
    await deleteLibraryEntry(PART.id)
    await vi.waitFor(() => expect(getCatalog().lookup.device(PART.id)).toBeUndefined())
  })
})

describe('lookupForPlan', () => {
  it('adds the plan’s own entries and is memoized per lookup and custom entries', () => {
    const { lookup } = getCatalog()
    const plan = samplePlan()
    const forPlan = lookupForPlan(lookup, plan)
    expect(forPlan.device('custom:diy-n100-nas')?.model).toBe('N100 NAS')
    expect(lookup.device('custom:diy-n100-nas')).toBeUndefined()
    expect(lookupForPlan(lookup, plan)).toBe(forPlan)
    const renamed = { ...plan, name: 'renamed' }
    expect(lookupForPlan(lookup, renamed)).toBe(forPlan)
    expect(lookupForPlan(lookup, samplePlan())).not.toBe(forPlan)
  })
})
