import { describe, expect, it } from 'vitest'
import { allEntries, createCatalogSearch } from '@/catalog/search'
import {
  BLANK_1U,
  CATALOG,
  FEET,
  FRAME,
  MINI_PC,
  SWITCH,
} from '@/domain/__fixtures__/frameFixtures'
import {
  catalogBundle,
  createCatalogLookup,
  ItemSchema,
  withCustomEntries,
} from '@/domain/schema/catalog'
import {
  categoryLabel,
  dimsText,
  dragSubjectOf,
  paletteRows,
  tabCategories,
  toPaletteRow,
  type PaletteQuery,
} from './paletteModel'

const VERIFIED = { by: 'test', date: '2026-10-11', method: 'page' } as const

const MY_SHELF = ItemSchema.parse({
  kind: 'item',
  id: 'custom:my-shelf',
  name: 'My shelf',
  category: 'shelf',
  verified: VERIFIED,
  heightSixths: 6,
  depthMm: 100,
  mount: { front: 4 },
  source: {
    platform: 'printables',
    url: 'https://www.printables.com/model/1',
    designer: 'Me',
    license: 'CC BY 4.0',
  },
})
const FOR_OTHER_FRAME = ItemSchema.parse({
  kind: 'item',
  id: 'lab-rax-mount',
  name: 'Lab Rax mount',
  category: 'mount',
  verified: VERIFIED,
  heightSixths: 6,
  depthMm: 100,
  mount: { front: 4 },
  compat: { frames: ['lab-rax'] },
})
const FOR_THIS_FRAME = ItemSchema.parse({
  kind: 'item',
  id: 'test-frame-mount',
  name: 'Test frame mount',
  category: 'mount',
  verified: VERIFIED,
  heightSixths: 12,
  depthMm: 100,
  mount: { front: 4 },
  compat: { frames: [FRAME.id] },
})

const lookup = withCustomEntries(
  createCatalogLookup(catalogBundle([...allEntries(CATALOG), FOR_OTHER_FRAME, FOR_THIS_FRAME])),
  { frames: [], items: [MY_SHELF], devices: [], hardware: [] },
)
const entries = allEntries(lookup)
const search = createCatalogSearch(entries)

function ids(query: Partial<PaletteQuery>): string[] {
  return paletteRows(search, { query: '', tab: 'mounts', categories: [], ...query }, FRAME.id).map(
    (row) => row.id,
  )
}

describe('paletteRows', () => {
  it('splits mounts & panels, devices and my own parts into tabs', () => {
    const mounts = ids({})
    expect(mounts).toContain(BLANK_1U.id)
    expect(mounts).toContain(FEET.id)
    expect(mounts).toContain(MY_SHELF.id)
    expect(mounts).not.toContain(MINI_PC.id)
    expect(ids({ tab: 'devices' }).toSorted()).toEqual(
      ['test-mini-pc', 'test-nas', 'test-sbc', 'test-switch'].toSorted(),
    )
    expect(ids({ tab: 'mine' })).toEqual([MY_SHELF.id])
  })

  it('hides parts made for other frames only while "fits this frame" is on', () => {
    expect(ids({ fitsFrameId: FRAME.id })).not.toContain(FOR_OTHER_FRAME.id)
    expect(ids({ fitsFrameId: FRAME.id })).toContain(FOR_THIS_FRAME.id)
    expect(ids({})).toContain(FOR_OTHER_FRAME.id)
  })

  it('filters by query and category', () => {
    expect(ids({ query: 'blank' })).toEqual(['blank-1u', 'blank-2u'])
    expect(ids({ categories: ['shelf'] })).toEqual([MY_SHELF.id])
    expect(ids({ categories: ['accessory', 'shelf'] }).toSorted()).toEqual(
      [FEET.id, MY_SHELF.id].toSorted(),
    )
  })

  it('describes each row: height, size, source, verification and what it can do', () => {
    const rows = paletteRows(search, { query: '', tab: 'mounts', categories: [] }, FRAME.id)
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get(BLANK_1U.id)).toMatchObject({
      kind: 'item',
      heightText: '1U',
      placeable: true,
      unverified: true,
      custom: false,
    })
    expect(byId.get(FEET.id)).toMatchObject({ kind: 'extra', placeable: false })
    expect(byId.get(FEET.id)?.heightText).toBeUndefined()
    expect(byId.get(FOR_THIS_FRAME.id)).toMatchObject({ frameSpecific: true, heightText: '2U' })
    expect(byId.get(MY_SHELF.id)).toMatchObject({
      custom: true,
      designer: 'Me',
      license: 'CC BY 4.0',
      url: 'https://www.printables.com/model/1',
      unverified: false,
    })

    const devices = paletteRows(search, { query: '', tab: 'devices', categories: [] }, FRAME.id)
    const pc = devices.find((row) => row.id === MINI_PC.id)
    const ears = devices.find((row) => row.id === SWITCH.id)
    expect(pc).toMatchObject({ name: 'Test Mini PC', sizeText: '179 × 183 × 35 mm' })
    expect(pc?.placeable).toBe(false)
    expect(ears).toMatchObject({ placeable: true, heightText: '1U' })
  })
})

describe('categories', () => {
  it('lists the categories of a tab by label', () => {
    expect(tabCategories(entries, 'mounts')).toEqual(['accessory', 'mount', 'shelf'])
    expect(tabCategories(entries, 'devices')).toEqual(['mini-pc', 'nas', 'sbc', 'switch'])
    expect(tabCategories(entries, 'mine')).toEqual(['shelf'])
  })

  it('reads categories as plural labels', () => {
    expect(categoryLabel('mini-pc')).toBe('Mini PCs')
    expect(categoryLabel('mount')).toBe('Mounts')
    expect(categoryLabel('shelf')).toBe('Shelves')
    expect(categoryLabel('pdu')).toBe('PDUs')
    expect(categoryLabel('switch')).toBe('Switches')
    expect(categoryLabel('nas-mount')).toBe('NAS mounts')
  })

  it('formats sizes in millimetres', () => {
    expect(dimsText({ w: 179, d: 183, h: 34.5 })).toBe('179 × 183 × 34.5 mm')
    expect(dimsText({ w: 100.04, d: 50, h: 20 })).toBe('100 × 50 × 20 mm')
  })
})

describe('dragSubjectOf', () => {
  it('drags mounts and devices (the user’s own too), never accessories', () => {
    expect(dragSubjectOf(toPaletteRow(BLANK_1U, FRAME.id))).toEqual({
      kind: 'item',
      itemId: 'blank-1u',
    })
    expect(dragSubjectOf(toPaletteRow(MY_SHELF, FRAME.id))).toEqual({
      kind: 'item',
      itemId: 'custom:my-shelf',
    })
    // A device without ears too: onto a slot, or empty space asks for a mount.
    expect(dragSubjectOf(toPaletteRow(MINI_PC, FRAME.id))).toEqual({
      kind: 'device',
      deviceId: 'test-mini-pc',
    })
    expect(dragSubjectOf(toPaletteRow(SWITCH, FRAME.id))).toEqual({
      kind: 'device',
      deviceId: 'test-switch',
    })
    expect(dragSubjectOf(toPaletteRow(FEET, FRAME.id))).toBeNull()
  })
})

describe('row roles', () => {
  it('colours devices by category and items by what they hold', () => {
    expect(toPaletteRow(MINI_PC, FRAME.id).role).toBe('compute')
    expect(toPaletteRow(SWITCH, FRAME.id).role).toBe('network')
    expect(toPaletteRow(BLANK_1U, FRAME.id).role).toBe('neutral')
    expect(toPaletteRow(FEET, FRAME.id).role).toBe('neutral')
  })
})
