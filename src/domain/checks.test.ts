import { describe, expect, it } from 'vitest'
import type { Issue } from './api'
import { fitsPrinterBed, rectangleFits, runChecks, slotOrientation } from './checks'
import type { CatalogLookup } from './schema/catalog'
import type { Plan } from './schema/plan'
import { defaultSettings, type Settings } from './schema/settings'
import {
  KWS_FRAME_INPUT,
  KWS_IDS,
  kwsCatalog,
  kwsPlan,
  parseEntries,
  type KwsPlanSpec,
} from './__fixtures__/kws'

const SETTINGS = defaultSettings()
const CATALOG = kwsCatalog()
const VERIFIED = { by: 'test', date: '2026-10-11', method: 'unverified' }

function customItem(id: string, fields: Record<string, unknown>) {
  return {
    kind: 'item',
    id,
    name: id.replace('custom:', ''),
    category: 'test',
    verified: VERIFIED,
    heightSixths: 6,
    depthMm: 100,
    mount: { front: 4, holeOffsetsMm: [6.35, 38.1] },
    ...fields,
  }
}

function frameVariant(fields: Record<string, unknown>) {
  return { ...KWS_FRAME_INPUT, ...fields }
}

function check(
  spec: KwsPlanSpec,
  options: { catalog?: CatalogLookup; settings?: Settings } = {},
): Issue[] {
  return runChecks(kwsPlan(spec), options.catalog ?? CATALOG, options.settings ?? SETTINGS)
}

function codes(issues: readonly Issue[]): string[] {
  return issues.map((issue) => `${issue.severity}:${issue.code}`)
}

const tiny = (id: string, y: number, extra: Record<string, unknown> = {}) => ({
  id,
  itemId: 'lenovo-tiny-mount',
  y,
  ...extra,
})

describe('runChecks', () => {
  it('finds nothing wrong with a well-placed mini PC', () => {
    const issues = check({
      sections: [6, 3],
      placements: [
        tiny('pl-1', 0, { devices: [{ id: 'dv-1', deviceId: 'lenovo-m720q', slotId: 'bay' }] }),
      ],
    })
    expect(issues).toEqual([])
  })

  it('reports placements outside the stack', () => {
    const issues = check({ sections: [6, 3], placements: [tiny('pl-1', 54), tiny('pl-2', -6)] })
    expect(issues).toEqual([
      expect.objectContaining({ severity: 'error', code: 'out-of-rack', targetId: 'pl-1' }),
      expect.objectContaining({ severity: 'error', code: 'out-of-rack', targetId: 'pl-2' }),
    ])
    expect(issues[0]?.message).toContain('above the top of the rack (the stack is 9U)')
  })

  describe('overlap', () => {
    it('flags two front placements in the same U, once per placement', () => {
      const issues = check({ sections: [6], placements: [tiny('pl-1', 0), tiny('pl-2', 0)] })
      expect(issues.filter((issue) => issue.code === 'overlap')).toEqual([
        {
          severity: 'error',
          code: 'overlap',
          message: 'Lenovo Tiny mount @U1 overlaps Lenovo Tiny mount @U1.',
          targetId: 'pl-1',
        },
        expect.objectContaining({ targetId: 'pl-2' }),
      ])
    })

    it('lets shallow front and rear placements share a U, and half bays sit side by side', () => {
      const issues = check({
        sections: [6],
        placements: [
          tiny('pl-1', 0),
          { id: 'pl-2', itemId: 'blank-1u', y: 0, face: 'rear' },
          { id: 'pl-3', itemId: 'blank-1u', y: 6, bay: 'left' },
          { id: 'pl-4', itemId: 'blank-1u', y: 6, bay: 'right' },
        ],
      })
      expect(issues.filter((issue) => issue.code === 'overlap')).toEqual([])
    })

    it('flags front and rear placements whose depths meet, and rear-supported items', () => {
      const deepRear = parseEntries([customItem('custom:deep-rear', { depthMm: 70 })])
      const deep = check(
        {
          sections: [6],
          placements: [
            tiny('pl-1', 0),
            { id: 'pl-2', itemId: 'custom:deep-rear', y: 0, face: 'rear' },
          ],
        },
        { catalog: kwsCatalog(deepRear) },
      )
      expect(codes(deep)).toContain('error:overlap')
      const shelf = check({
        sections: [6],
        placements: [
          { id: 'pl-1', itemId: 'shelf-2u', y: 0 },
          { id: 'pl-2', itemId: 'blank-1u', y: 6, face: 'rear' },
        ],
      })
      expect(shelf.filter((issue) => issue.code === 'overlap')).toHaveLength(2)
    })

    it('flags a full-width placement over a half-bay one', () => {
      const issues = check({
        sections: [6],
        placements: [
          { id: 'pl-1', itemId: 'blank-1u', y: 0, bay: 'left' },
          { id: 'pl-2', itemId: 'blank-1u', y: 0 },
        ],
      })
      expect(issues.filter((issue) => issue.code === 'overlap')).toHaveLength(2)
    })
  })

  describe('hole phases', () => {
    it('rejects positions where the holes miss the rails', () => {
      const issues = check({ sections: [6], placements: [tiny('pl-1', 3)] })
      expect(codes(issues)).toEqual(['error:phase-invalid'])
    })

    it('accepts sub-U positions where the holes line up', () => {
      const halfU = parseEntries([
        customItem('custom:half-u', {
          heightSixths: 3,
          mount: { front: 2, holeOffsetsMm: [15.875] },
        }),
      ])
      const catalog = kwsCatalog(halfU)
      const at = (y: number) =>
        codes(
          check(
            { sections: [6], placements: [{ id: 'pl-1', itemId: 'custom:half-u', y }] },
            { catalog },
          ),
        )
      expect(at(3)).toEqual([])
      expect(at(0)).toEqual(['error:phase-invalid'])
    })

    it('marks items without hole data as unverified and warns off whole U', () => {
      const whole = check({ sections: [6], placements: [{ id: 'pl-1', itemId: 'blank-1u', y: 6 }] })
      expect(codes(whole)).toEqual(['info:unverified-holes'])
      const off = check({ sections: [6], placements: [{ id: 'pl-1', itemId: 'blank-1u', y: 8 }] })
      expect(codes(off)).toEqual(['warning:phase-invalid', 'info:unverified-holes'])
    })

    it('checks ear-mounted gear placed directly against the rail holes', () => {
      expect(check({ sections: [6], placements: [{ id: 'pl-1', itemId: 'pdu-4', y: 6 }] })).toEqual(
        [],
      )
      const off = check({ sections: [6], placements: [{ id: 'pl-1', itemId: 'pdu-4', y: 2 }] })
      expect(codes(off)).toEqual(['error:phase-invalid'])
    })
  })

  describe('depth', () => {
    const deepItem = parseEntries([customItem('custom:deep', { depthMm: 300 })])
    const catalog = kwsCatalog(deepItem)
    const deepAt = (face: 'front' | 'rear') => ({
      sections: [6] as Array<3 | 6>,
      placements: [{ id: 'pl-1', itemId: 'custom:deep', y: 0, face }],
    })

    it('warns about overhang behind an open rear, with the millimetres', () => {
      const issues = check(deepAt('front'), { catalog })
      expect(issues).toEqual([
        {
          severity: 'warning',
          code: 'depth-overhang',
          message: 'deep @U1 sticks out 50 mm at the back.',
          targetId: 'pl-1',
        },
      ])
      expect(check(deepAt('rear'), { catalog })[0]?.message).toContain('50 mm at the front')
    })

    it('reports gear too deep for a frame that is closed at the back', () => {
      const closed = parseEntries([
        frameVariant({ standard: { ...KWS_FRAME_INPUT.standard, rearOpen: false } }),
        ...deepItem,
      ])
      expect(codes(check(deepAt('front'), { catalog: kwsCatalog(closed) }))).toEqual([
        'warning:too-deep',
      ])
    })

    it('uses the depth of the 320 mm connectors option', () => {
      expect(check({ ...deepAt('front'), rackOptions: { 'deep-320': true } }, { catalog })).toEqual(
        [],
      )
    })

    it('counts the deepest device in a slot', () => {
      const tray = parseEntries([
        customItem('custom:shallow-tray', {
          depthMm: 100,
          heightSixths: 24,
          mount: { front: 4, holeOffsetsMm: [6.35, 171.45] },
          slots: [
            {
              id: 'tray',
              kind: 'fixed',
              maxW: 200,
              maxD: 300,
              maxH: 200,
              layout: { xMm: 0, yMm: 0, zMm: 0 },
            },
          ],
        }),
        {
          kind: 'device',
          id: 'custom:long-box',
          brand: 'Long',
          model: 'Box',
          category: 'other',
          dims: { w: 100, d: 280, h: 50 },
          verified: VERIFIED,
        },
      ])
      const holding = (deviceId: string) =>
        check(
          {
            sections: [6],
            placements: [
              {
                id: 'pl-1',
                itemId: 'custom:shallow-tray',
                y: 0,
                devices: [{ id: 'dv-1', deviceId, slotId: 'tray' }],
              },
            ],
          },
          { catalog: kwsCatalog(tray) },
        )
      expect(holding('nas-2bay')).toEqual([])
      expect(holding('custom:long-box')).toEqual([
        expect.objectContaining({
          code: 'depth-overhang',
          message: 'shallow-tray @U1 sticks out 30 mm at the back.',
        }),
      ])
    })

    it('warns when a rear-supported item cannot reach the rear rails', () => {
      const shelf = {
        sections: [6] as Array<3 | 6>,
        placements: [{ id: 'pl-1', itemId: 'shelf-2u', y: 0 }],
      }
      expect(check(shelf)).toEqual([])
      const issues = check({ ...shelf, rackOptions: { 'deep-320': true } })
      expect(codes(issues)).toEqual(['warning:rear-support-missing'])
      expect(issues[0]?.message).toContain(
        'at 245 mm deep it does not reach the rear rails (320 mm)',
      )
    })
  })

  describe('devices in slots', () => {
    const inTiny = (deviceId: string, extra: Record<string, unknown> = {}) => ({
      sections: [6] as Array<3 | 6>,
      placements: [
        tiny('pl-1', 0, { devices: [{ id: 'dv-1', deviceId, slotId: 'bay', ...extra }] }),
      ],
    })

    it('reports a device that fits no allowed orientation', () => {
      const issues = check(inTiny('nas-2bay'))
      expect(issues).toEqual([
        expect.objectContaining({ severity: 'error', code: 'slot-fit', targetId: 'dv-1' }),
        expect.objectContaining({ severity: 'warning', code: 'slot-fit' }),
      ])
      expect(issues[0]?.message).toBe(
        'Fixture 2-bay NAS (100 × 220 × 165 mm) does not fit Lenovo Tiny mount slot "bay" (182 × 186 × 37 mm) in any allowed orientation.',
      )
    })

    it('honours a stored orientation and the slot’s accepted categories', () => {
      expect(codes(check(inTiny('lenovo-m720q', { orientation: 'on-side' })))).toEqual([
        'error:slot-fit',
      ])
      expect(codes(check(inTiny('rpi-5')))).toEqual(['warning:slot-fit'])
    })

    it('reports unknown slots, a second device in a fixed slot and an overfull area', () => {
      const issues = check({
        sections: [6],
        placements: [
          tiny('pl-1', 0, {
            devices: [
              { id: 'dv-1', deviceId: 'lenovo-m720q', slotId: 'bay' },
              { id: 'dv-2', deviceId: 'lenovo-m720q', slotId: 'bay' },
              { id: 'dv-3', deviceId: 'lenovo-m720q', slotId: 'nope' },
            ],
          }),
          {
            id: 'pl-2',
            itemId: 'shelf-2u',
            y: 12,
            devices: [
              { id: 'dv-4', deviceId: 'lenovo-m720q', slotId: 'deck' },
              { id: 'dv-5', deviceId: 'lenovo-m720q', slotId: 'deck' },
            ],
          },
        ],
      })
      const messages = issues
        .filter((issue) => issue.code === 'slot-fit')
        .map((issue) => issue.message)
      expect(messages).toEqual([
        'Lenovo Tiny mount slot "bay" holds one device.',
        'Lenovo Tiny mount has no slot "nope".',
        'No room left in 2U shelf slot "deck" (215 mm wide) for this device.',
      ])
      expect(
        issues.filter((issue) => issue.code === 'slot-fit').map((issue) => issue.targetId),
      ).toEqual(['dv-2', 'dv-3', 'dv-5'])
    })

    it('warns about gear wider than the opening and, as info, wider than 210 mm', () => {
      const wide = parseEntries([
        customItem('custom:wide-tray', {
          slots: [
            { id: 'tray', kind: 'area', maxW: 240, maxD: 200, layout: { xMm: 0, yMm: 0, zMm: 0 } },
          ],
        }),
        {
          kind: 'device',
          id: 'custom:w230',
          brand: 'Wide',
          model: '230',
          category: 'other',
          dims: { w: 230, d: 100, h: 30 },
          verified: VERIFIED,
        },
        {
          kind: 'device',
          id: 'custom:w215',
          brand: 'Wide',
          model: '215',
          category: 'other',
          dims: { w: 215, d: 100, h: 30 },
          verified: VERIFIED,
        },
      ])
      const tray = (deviceId: string) => ({
        sections: [6] as Array<3 | 6>,
        placements: [
          {
            id: 'pl-1',
            itemId: 'custom:wide-tray',
            y: 0,
            devices: [{ id: 'dv-1', deviceId, slotId: 'tray', orientation: 'flat' as const }],
          },
        ],
      })
      const catalog = kwsCatalog(wide)
      expect(codes(check(tray('custom:w230'), { catalog }))).toEqual(['warning:too-wide'])
      expect(codes(check(tray('custom:w215'), { catalog }))).toEqual(['info:wide-guideline'])
    })

    it('keeps a stored orientation only when the slot allows it and it fits', () => {
      const bay = CATALOG.item('lenovo-tiny-mount')?.slots[0]
      const deck = CATALOG.item('shelf-2u')?.slots[0]
      const pc = CATALOG.device('lenovo-m720q')
      if (bay === undefined || deck === undefined || pc === undefined) {
        throw new Error('fixture changed')
      }
      expect(slotOrientation(bay, pc)).toBe('flat')
      // Turned 90° it is 183 mm wide: too wide for the 182 mm bay, fine on the 215 mm deck.
      expect(slotOrientation(bay, pc, 'flat-rotated')).toBeUndefined()
      expect(slotOrientation(deck, pc, 'flat-rotated')).toBe('flat-rotated')
      expect(slotOrientation(bay, pc, 'upright')).toBeUndefined()
    })
  })

  describe('frame fit', () => {
    it('warns about a clearance mismatch between ear holes and frame screws', () => {
      const m6Frame = parseEntries([
        frameVariant({
          equipmentFastener: {
            thread: 'M6',
            perHole: 'screw',
            screwIds: [KWS_IDS.m6x10],
            engagementMm: 4,
          },
        }),
      ])
      const issues = check(
        { sections: [6], placements: [tiny('pl-1', 0)] },
        { catalog: kwsCatalog(m6Frame) },
      )
      expect(issues).toEqual([
        expect.objectContaining({
          code: 'clearance-mismatch',
          message: "Lenovo Tiny mount @U1: its M5 holes are too small for the frame's M6 screws.",
        }),
      ])
      const loose = parseEntries([
        customItem('custom:loose', {
          mount: { front: 4, holeOffsetsMm: [6.35, 38.1], clearance: 'M6' },
        }),
      ])
      const looseIssues = check(
        { sections: [6], placements: [{ id: 'pl-1', itemId: 'custom:loose', y: 0 }] },
        { catalog: kwsCatalog(loose) },
      )
      expect(looseIssues[0]?.message).toContain('larger than the frame')
    })

    it('warns when an item is made for other frames', () => {
      const other = parseEntries([customItem('custom:other', { compat: { frames: ['lab-rax'] } })])
      const issues = check(
        { sections: [6], placements: [{ id: 'pl-1', itemId: 'custom:other', y: 0 }] },
        { catalog: kwsCatalog(other) },
      )
      expect(issues).toEqual([
        expect.objectContaining({ severity: 'warning', code: 'frame-mismatch', targetId: 'pl-1' }),
      ])
    })

    it('warns about placements in a joint dead zone', () => {
      const deadFrame = parseEntries([
        frameVariant({ stack: { minU: 3, maxU: 30, joint: { gapMm: 0, deadSixths: 2 } } }),
      ])
      const catalog = kwsCatalog(deadFrame)
      const at = (y: number) =>
        codes(check({ sections: [3, 3], placements: [tiny('pl-1', y)] }, { catalog }))
      expect(at(6)).toEqual([])
      expect(at(12)).toEqual(['warning:dead-zone'])
      expect(at(18)).toEqual(['warning:dead-zone'])
      expect(at(24)).toEqual([])
    })
  })

  describe('printer bed', () => {
    const bed = (size: number): Settings => ({
      ...SETTINGS,
      printerBedMm: { x: size, y: size, z: size },
    })

    it('warns about items deeper than the bed, once per item', () => {
      const issues = check(
        { sections: [6], placements: [tiny('pl-1', 0), tiny('pl-2', 6)] },
        { settings: bed(180) },
      )
      expect(issues.filter((issue) => issue.targetId !== undefined)).toEqual([
        expect.objectContaining({ severity: 'warning', code: 'printer-bed', targetId: 'pl-1' }),
      ])
    })

    it('checks the frame parts in use, laid diagonally if need be', () => {
      // A 266.7 mm 6U leg fits a 256 mm bed diagonally, but not a 200 mm one.
      expect(check({ sections: [3, 6] }, { settings: bed(256) })).toEqual([])
      const small = check({ sections: [3, 6] }, { settings: bed(200) })
      expect(small).toEqual([
        {
          severity: 'warning',
          code: 'printer-bed',
          message:
            'KWS Rack v2: 6U frame leg (20 × 20 × 266.7 mm) may not fit your 200 × 200 × 200 mm printer bed.',
        },
      ])
      expect(check({ sections: [3] }, { settings: bed(200) })).toEqual([])
    })

    it('fits rectangles at an angle (Carver)', () => {
      expect(rectangleFits(266.7, 20, 256, 256)).toBe(true)
      expect(rectangleFits(266.7, 20, 200, 200)).toBe(false)
      // The diagonal of a 256 mm square is 362 mm; a strip needs a little less than that.
      expect(rectangleFits(360, 1, 256, 256)).toBe(true)
      expect(rectangleFits(370, 1, 256, 256)).toBe(false)
      expect(rectangleFits(100, 300, 256, 256)).toBe(false)
      expect(fitsPrinterBed({ w: 20, d: 250, h: 30 }, { x: 180, y: 180, z: 180 })).toBe(false)
      expect(fitsPrinterBed({ w: 20, d: 20, h: 250 }, { x: 180, y: 180, z: 256 })).toBe(true)
    })
  })

  describe('unknown parts', () => {
    it('reports unknown items, devices, equipment and extras without throwing', () => {
      const issues = check({
        sections: [6],
        placements: [
          {
            id: 'pl-1',
            itemId: 'gone-mount',
            name: 'Old mount',
            heightSixths: 6,
            y: 0,
            devices: [{ id: 'dv-1', deviceId: 'gone-pc', slotId: 'bay' }],
          },
          tiny('pl-2', 6, { devices: [{ id: 'dv-2', deviceId: 'gone-pc-2', slotId: 'bay' }] }),
          { id: 'pl-3', itemId: 'rpi-5', y: 12 },
        ],
        equipment: [{ id: 'eq-1', deviceId: 'gone-switch' }],
        extras: [{ id: 'ex-1', itemId: 'gone-feet', qty: 1 }],
      })
      expect(
        issues.filter((issue) => issue.code === 'unknown-part').map((issue) => issue.targetId),
      ).toEqual(['pl-1', 'dv-1', 'dv-2', 'pl-3', 'eq-1', 'ex-1'])
      expect(issues.find((issue) => issue.targetId === 'pl-3')?.message).toContain(
        'has no rack ears',
      )
    })

    it('reports an unknown frame and skips position checks', () => {
      const plan: Plan = kwsPlan({ sections: [6], placements: [tiny('pl-1', 99)] })
      const issues = runChecks(
        { ...plan, frame: { ...plan.frame, frameId: 'mystery-frame' } },
        CATALOG,
        SETTINGS,
      )
      expect(codes(issues)).toEqual(['warning:unknown-part'])
    })
  })

  describe('power', () => {
    it('warns when the plan’s power strips have too few outlets', () => {
      const pcs = ['dv-1', 'dv-2', 'dv-3'].map((id, index) =>
        tiny(`pl-${index}`, (index + 1) * 6, {
          devices: [{ id, deviceId: 'lenovo-m720q', slotId: 'bay' }],
        }),
      )
      const plan = {
        sections: [6] as Array<3 | 6>,
        placements: [{ id: 'pl-pdu', itemId: 'pdu-4', y: 0 }, ...pcs],
      }
      expect(check(plan)).toEqual([])
      const issues = check({ ...plan, equipment: [{ id: 'eq-1', deviceId: 'nas-2bay' }] })
      expect(issues).toEqual([
        {
          severity: 'warning',
          code: 'power-ac',
          message:
            'The plan needs 5 AC outlets (wall-plug bricks take 2); its power strips have 4.',
        },
      ])
    })

    it('warns about PoE ports and budget', () => {
      const cameras = Array.from({ length: 5 }, (_, index) => ({
        id: `eq-${index}`,
        deviceId: 'poe-camera',
      }))
      const issues = check({
        sections: [6],
        equipment: [{ id: 'eq-sw', deviceId: 'poe-switch-8' }, ...cameras],
      })
      expect(codes(issues)).toEqual(['warning:power-poe'])
      expect(issues[0]?.message).toBe('5 devices need PoE; the switches have 4 PoE ports.')
    })
  })

  it('lists errors first, then warnings, then info', () => {
    const issues = check({
      sections: [6],
      placements: [{ id: 'pl-1', itemId: 'blank-1u', y: 20 }, tiny('pl-2', 3)],
    })
    expect(codes(issues)).toEqual([
      'error:phase-invalid',
      'warning:phase-invalid',
      'info:unverified-holes',
    ])
  })
})
