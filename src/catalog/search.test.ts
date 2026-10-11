import { describe, expect, it } from 'vitest'
import { testEntries } from './__fixtures__/entries'
import { createLookup } from './resolver'
import {
  createCatalogSearch,
  entryName,
  fitsFrame,
  normalizeText,
  searchCatalog,
  tokenize,
  type SearchFilters,
} from './search'

const lookup = createLookup(testEntries())
const search = createCatalogSearch(testEntries())

function ids(query: string, filters?: SearchFilters): string[] {
  return search(query, filters).map((hit) => hit.entry.id)
}

describe('tokenize', () => {
  it('splits on anything but letters and digits, lower case, without accents', () => {
    expect(tokenize('M5×10 SHCS')).toEqual(['m5x10', 'shcs'])
    expect(tokenize('Écrou M6 (nyloc), 10-pack')).toEqual(['ecrou', 'm6', 'nyloc', '10', 'pack'])
    expect(tokenize('  ')).toEqual([])
    expect(normalizeText('M5×10')).toBe('m5x10')
  })
})

describe('entryName', () => {
  it('uses brand and model for devices', () => {
    const device = lookup.device('lenovo-m720q')
    expect(device && entryName(device)).toBe('Lenovo ThinkCentre M720q Tiny')
  })
})

describe('createCatalogSearch', () => {
  it('finds a screw however the size is written', () => {
    for (const query of ['m5x10', 'M5 x 10', 'M5×10', 'm5 10 shcs']) {
      expect(ids(query)[0]).toBe('screw-m5x10-shcs')
    }
  })

  it('needs every query word to match', () => {
    // Equal scores sort by name: "Lenovo ThinkCentre…" before "Lenovo Tiny…".
    expect(ids('lenovo tiny')).toEqual(['lenovo-m720q', 'lenovo-tiny-mount'])
    expect(ids('tiny mount')).toEqual(['lenovo-tiny-mount'])
    expect(ids('tiny banana')).toEqual([])
  })

  it('matches word starts, and ranks exact words above prefixes', () => {
    expect(ids('think')).toEqual(['lenovo-m720q'])
    const hits = search('mount')
    expect(hits[0]?.entry.id).toBe('lenovo-tiny-mount')
    expect(search('moun')[0]?.score).toBeLessThan(hits[0]?.score ?? 0)
  })

  it('ranks exact words above prefixes, and aliases above ids', () => {
    // "m6" is a whole word in "M6 hex nut" but only the start of "m6x8" in the screw's name.
    expect(ids('m6')).toEqual(['nut-m6-hex', 'screw-m6x8-shcs'])
    // "shcs" is an alias of the M5 screw; the M6 screw only has it in its id.
    expect(ids('shcs')).toEqual(['screw-m5x10-shcs', 'screw-m6x8-shcs'])
    expect(ids('din 912')).toEqual(['screw-m5x10-shcs'])
    expect(ids('insert')).toEqual(['insert-m5x8x7'])
  })

  it('filters by kind and category', () => {
    expect(ids('', { kind: 'device' })).toEqual(['lenovo-m720q'])
    expect(ids('', { kind: ['frame', 'device'] })).toEqual(['lenovo-m720q', 'test-frame'])
    expect(ids('', { category: 'screw' })).toEqual(['screw-m5x10-shcs', 'screw-m6x8-shcs'])
    expect(ids('test', { category: ['mount', 'shelf'] })).toEqual([])
    expect(ids('frame', { category: 'mount' })).toEqual([])
  })

  it('hides items made for other frames', () => {
    expect(ids('', { kind: 'item', fitsFrameId: 'test-frame' })).toEqual([
      'lenovo-tiny-mount',
      'shelf-1u',
    ])
    expect(ids('', { kind: 'item', fitsFrameId: 'other-frame' })).toEqual(['shelf-1u'])
    const mount = lookup.item('lenovo-tiny-mount')
    const device = lookup.device('lenovo-m720q')
    expect(mount && fitsFrame(mount, 'other-frame')).toBe(false)
    expect(device && fitsFrame(device, 'other-frame')).toBe(true)
  })

  it('lists everything by name for an empty query', () => {
    const hits = search('')
    expect(hits).toHaveLength(8)
    expect(hits.every((hit) => hit.score === 0)).toBe(true)
    expect(hits[0]?.entry.id).toBe('lenovo-m720q')
    expect(hits.at(-1)?.entry.id).toBe('test-frame')
  })
})

describe('searchCatalog', () => {
  it('searches a lookup directly', () => {
    expect(searchCatalog(lookup, 'nut').map((hit) => hit.entry.id)).toEqual(['nut-m6-hex'])
  })
})
