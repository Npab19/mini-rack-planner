import { describe, expect, it } from 'vitest'
import { EDITOR_IDS, editorCatalog } from '@/domain/__fixtures__/editorFixtures'
import { KWS_FRAME, parseEntries } from '@/domain/__fixtures__/kws'
import {
  CHOOSER_SUGGESTIONS,
  chooserOptions,
  customMountPrefill,
  GENERIC_SHELF_IDS,
  type ChooserOption,
} from './chooserModel'
import {
  builtRack as rack,
  fixtureDevice as device,
  GENERIC_SHELVES,
  mountCatalog,
} from './__fixtures__/mountFixtures'

const VERIFIED = { by: 'fixture', date: '2026-10-11', method: 'unverified' }
const CATALOG = mountCatalog()

function summary(options: readonly ChooserOption[]) {
  return options.map((option) => [
    option.kind,
    option.itemId,
    option.spot?.y ?? null,
    option.atDrop,
  ])
}

describe('chooserOptions', () => {
  const m720q = device(CATALOG, EDITOR_IDS.m720q)

  it('lists the mounts that take the device, each fitting where it was dropped', () => {
    const options = chooserOptions(rack(), CATALOG, KWS_FRAME, m720q, 'front', 42)
    expect(summary(options)).toEqual([
      ['mount', EDITOR_IDS.tinyMount, 42, true],
      ['generic-shelf', 'generic-shelf-1u', 42, true],
      ['mount', EDITOR_IDS.shelf2u, 42, true],
      ['generic-shelf', 'generic-shelf-2u', 42, true],
    ])
    expect(options[0]).toMatchObject({
      name: 'Lenovo Tiny mount',
      heightSixths: 6,
      frameSpecific: false,
      spot: { y: 42, face: 'front', bay: 'full' },
    })
    expect(options[0]?.dropReason).toBeUndefined()
  })

  it('offers the nearest free spot, with the reason, when the dropped one is taken', () => {
    const options = chooserOptions(rack(), CATALOG, KWS_FRAME, m720q, 'front', 13)
    // 13 snaps to U3 (12), where a blank is.
    expect(options[0]).toMatchObject({
      itemId: EDITOR_IDS.tinyMount,
      atDrop: false,
      dropReason: 'It overlaps 1U blank (U3).',
      spot: { y: 42, face: 'front', bay: 'full' },
    })
    // The 2U shelf at U8–U9 is the only room for it too.
    expect(options[2]).toMatchObject({ itemId: EDITOR_IDS.shelf2u, atDrop: false, spot: { y: 42 } })
  })

  it('says when a mount has no free spot at all', () => {
    const ds224 = device(CATALOG, EDITOR_IDS.ds224)
    const options = chooserOptions(rack(), CATALOG, KWS_FRAME, ds224, 'front', 42)
    // The 4U KWS module first (made for this frame), then the 3U NAS shelf: neither fits in 2U.
    expect(summary(options)).toEqual([
      ['mount', EDITOR_IDS.ds224Module, null, false],
      ['mount', EDITOR_IDS.nasShelf, null, false],
    ])
    expect(options[0]?.frameSpecific).toBe(true)
    expect(options[0]?.dropReason).toBe('It would reach above U9, the top of the rack.')
  })

  it('puts ear-mounted gear’s own ears first, on its own face', () => {
    const pdu = device(CATALOG, EDITOR_IDS.pdu)
    const front = chooserOptions(rack(), CATALOG, KWS_FRAME, pdu, 'front', 48)
    expect(summary(front)).toEqual([
      ['own-ears', EDITOR_IDS.pdu, 48, true],
      ['mount', EDITOR_IDS.shelf2u, 42, false],
    ])
    expect(front[0]?.name).toBe('Fixture 4-outlet 10" PDU')
    // Dropped on the rear: it mounts on the front only, so the nearest front spot is offered.
    const rear = chooserOptions(rack(), CATALOG, KWS_FRAME, pdu, 'rear', 48)
    expect(rear[0]).toMatchObject({
      kind: 'own-ears',
      atDrop: false,
      dropReason: 'Fixture 4-outlet 10" PDU mounts on the front only.',
      spot: { y: 48, face: 'front' },
    })
  })

  it('adds the smallest generic shelf when the listed mounts leave it out', () => {
    const sbcMounts = parseEntries(
      Array.from({ length: CHOOSER_SUGGESTIONS }, (_, index) => ({
        kind: 'item',
        id: `kws-sbc-mount-${index + 1}`,
        name: `KWS SBC mount ${index + 1}`,
        category: 'sbc-mount',
        source: { platform: 'other', url: 'https://example.com/mini-rack-fixtures/kws-sbc' },
        verified: VERIFIED,
        heightSixths: 6,
        depthMm: 100,
        mount: { front: 4, holeOffsetsMm: [6.35, 38.1] },
        compat: { frames: ['kws-rack-v2'] },
        slots: [
          {
            id: 'board',
            kind: 'fixed',
            maxW: 100,
            maxD: 100,
            maxH: 30,
            accepts: { categories: ['sbc'] },
            layout: { xMm: 5, yMm: 3, zMm: 0 },
          },
        ],
      })),
    )
    const catalog = editorCatalog([...GENERIC_SHELVES, ...sbcMounts])
    const pi = device(catalog, EDITOR_IDS.rpi5)
    const options = chooserOptions(rack(), catalog, KWS_FRAME, pi, 'front', 42)
    expect(options).toHaveLength(CHOOSER_SUGGESTIONS + 1)
    expect(options.slice(0, -1).every((option) => option.frameSpecific)).toBe(true)
    expect(options.at(-1)).toMatchObject({
      kind: 'generic-shelf',
      itemId: GENERIC_SHELF_IDS[0],
      heightSixths: 6,
    })
  })

  it('is empty when nothing takes the device', () => {
    const tower = device(CATALOG, EDITOR_IDS.towerUps)
    expect(chooserOptions(rack(), CATALOG, KWS_FRAME, tower, 'front', 42)).toEqual([])
  })
})

describe('customMountPrefill', () => {
  it('sizes a mount for the device: its height in half-U steps, 2 mm of room each way', () => {
    const m720q = device(CATALOG, EDITOR_IDS.m720q)
    expect(customMountPrefill(m720q, KWS_FRAME)).toEqual({
      name: 'Lenovo ThinkCentre M720q Tiny mount',
      category: 'mini-pc-mount',
      heightSixths: 6,
      depthMm: 185,
      faces: ['front'],
      holds: { kind: 'device', maxW: 181, maxD: 185, maxH: 36.5, categories: ['mini-pc'] },
    })
    const big = device(CATALOG, EDITOR_IDS.bigMiniPc)
    expect(customMountPrefill(big, KWS_FRAME).heightSixths).toBe(9)
  })
})
