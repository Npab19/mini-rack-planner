import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '@/domain/schema/settings'
import type { DiagnosticEntry } from '@/lib/diagnostics'
import { getDb, resetDbForTests } from './db'
import {
  appendDiagnostic,
  clearDiagnostics,
  createDiagnosticsSink,
  listDiagnostics,
  MAX_DIAGNOSTICS,
} from './diagnosticsRepo'
import { LibraryEntryError } from './errors'
import { adjust, getInventory, replaceAll, setQty } from './inventoryRepo'
import { deleteLibraryEntry, getLibraryEntry, listLibrary, putLibraryEntry } from './libraryRepo'
import { getSettings, parseSettings, SETTINGS_KEY, updateSettings } from './settingsRepo'

beforeEach(async () => {
  await resetDbForTests()
})

const PART = {
  kind: 'device',
  id: 'custom:my-switch',
  brand: 'DIY',
  model: 'Switch',
  category: 'switch',
  dims: { w: 200, d: 100, h: 30 },
  verified: { by: 'me', date: '2026-10-01', method: 'calipers' },
}

describe('libraryRepo', () => {
  it('stores, lists, reads and deletes custom parts', async () => {
    const stored = await putLibraryEntry(PART)
    expect(stored).toMatchObject({ id: 'custom:my-switch', kind: 'device' })
    expect((await listLibrary()).entries).toEqual([stored])
    expect(await getLibraryEntry(PART.id)).toEqual(stored)
    expect((await getDb().library.get(PART.id))?.kind).toBe('device')
    await deleteLibraryEntry(PART.id)
    expect((await listLibrary()).entries).toEqual([])
    expect(await getLibraryEntry(PART.id)).toBeUndefined()
  })

  it('only takes valid entries with custom: ids', async () => {
    await expect(putLibraryEntry({ ...PART, id: 'my-switch' })).rejects.toThrow(/custom:/)
    const invalid = await putLibraryEntry({ ...PART, dims: { w: -1 } }).catch((error) => error)
    expect(invalid).toBeInstanceOf(LibraryEntryError)
    expect((invalid as LibraryEntryError).problems.length).toBeGreaterThan(0)
    expect(await getDb().library.count()).toBe(0)
  })

  it('reports stored rows it cannot read instead of failing', async () => {
    await putLibraryEntry(PART)
    // Written untyped, as a newer app version could have.
    await getDb()
      .table('library')
      .put({
        id: 'custom:from-the-future',
        kind: 'device',
        updatedAt: '2030-01-01T00:00:00.000Z',
        entry: { ...PART, id: 'custom:from-the-future', category: 'quantum-computer' },
      })
    const list = await listLibrary()
    expect(list.entries.map((entry) => entry.id)).toEqual(['custom:my-switch'])
    expect(list.problems).toEqual([
      { id: 'custom:from-the-future', message: expect.stringMatching(/not valid/) },
    ])
  })
})

describe('settingsRepo', () => {
  it('returns defaults until something is stored, then merges updates', async () => {
    expect(await getSettings()).toEqual(defaultSettings())
    const updated = await updateSettings({
      currency: 'EUR',
      printerBedMm: { x: 256, y: 256, z: 256 },
    })
    expect(updated).toMatchObject({ currency: 'EUR', printerBedMm: { x: 256, y: 256, z: 256 } })
    expect(updated.sparePct).toEqual(defaultSettings().sparePct)
    expect(await getSettings()).toEqual(updated)
  })

  it('rejects an invalid update without writing', async () => {
    await updateSettings({ currency: 'EUR' })
    await expect(updateSettings({ currency: 'euro' })).rejects.toThrow()
    expect((await getSettings()).currency).toBe('EUR')
  })

  it('keeps both of two quick function updates of one record', async () => {
    // Both start before either is written; plain patches from one snapshot would lose one.
    await Promise.all([
      updateSettings((current) => ({ sparePct: { ...current.sparePct, screw: 0.2 } })),
      updateSettings((current) => ({ sparePct: { ...current.sparePct, nut: 0.3 } })),
    ])
    expect((await getSettings()).sparePct).toMatchObject({ screw: 0.2, nut: 0.3, insert: 0.1 })
  })

  it('lets later function updates run after a failed one', async () => {
    const failed = updateSettings(() => ({ currency: 'not a currency' }))
    const next = updateSettings(() => ({ currency: 'EUR' }))
    await expect(failed).rejects.toThrow()
    await expect(next).resolves.toMatchObject({ currency: 'EUR' })
    expect((await getSettings()).currency).toBe('EUR')
  })

  it('keeps the valid fields of damaged stored settings', async () => {
    await getDb().settings.put({
      key: SETTINGS_KEY,
      value: { currency: 'GBP', sparePct: { screw: 7 }, filamentCostPerKg: { PLA: 18 } },
    })
    const settings = await getSettings()
    expect(settings.currency).toBe('GBP')
    expect(settings.filamentCostPerKg).toEqual({ PLA: 18 })
    expect(settings.sparePct).toEqual(defaultSettings().sparePct)
    expect(parseSettings('garbage')).toEqual(defaultSettings())
  })
})

describe('inventoryRepo', () => {
  it('sets, adjusts (never below zero) and replaces quantities', async () => {
    expect(await getInventory()).toEqual({})
    await setQty('hw:m6-nyloc', 10)
    expect(await adjust('hw:m6-nyloc', 5)).toBe(15)
    expect(await adjust('print:kws/leg', 2)).toBe(2)
    expect(await getInventory()).toEqual({ 'hw:m6-nyloc': 15, 'print:kws/leg': 2 })

    expect(await adjust('hw:m6-nyloc', -20)).toBe(0)
    await setQty('print:kws/leg', 0)
    expect(await getInventory()).toEqual({})
    expect(await getDb().inventory.count()).toBe(0)

    await replaceAll({ 'device:mac-mini-m4': 1, 'hw:m5x10-shcs': 0 })
    expect(await getInventory()).toEqual({ 'device:mac-mini-m4': 1 })
    await expect(setQty('', 1)).rejects.toThrow(RangeError)
    await expect(adjust('hw:x', Number.NaN)).rejects.toThrow(RangeError)
  })
})

describe('diagnosticsRepo', () => {
  const entry = (index: number): DiagnosticEntry => ({
    at: new Date(Date.UTC(2026, 9, 11, 9, 0, index)).toISOString(),
    kind: 'error',
    message: `error ${index}`,
  })

  it('keeps the newest entries, oldest first', async () => {
    for (let index = 0; index < MAX_DIAGNOSTICS + 5; index++) {
      await appendDiagnostic(entry(index))
    }
    const entries = await listDiagnostics()
    expect(entries).toHaveLength(MAX_DIAGNOSTICS)
    expect(entries[0]).toEqual(entry(5))
    expect(entries.at(-1)?.message).toBe(`error ${MAX_DIAGNOSTICS + 4}`)
    await clearDiagnostics()
    expect(await listDiagnostics()).toEqual([])
  })

  it('is a sink for the diagnostics store', async () => {
    const sink = createDiagnosticsSink(2)
    const full: DiagnosticEntry = { ...entry(1), stack: 'at x', source: 'boundary:bom', repeats: 2 }
    await sink.append(entry(0))
    await sink.append(full)
    await sink.append(entry(2))
    expect(await sink.load()).toEqual([full, entry(2)])
    await sink.clear()
    expect(await sink.load()).toEqual([])
  })
})
