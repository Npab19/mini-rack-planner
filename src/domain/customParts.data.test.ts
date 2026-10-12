/**
 * Custom frames name rack screws and nuts by shared-catalog hardware id (customParts.ts). This
 * reads catalog/hardware so a renamed or missing screw fails here, and checks that the BOM picks
 * the expected stock screw for each way of fixing gear.
 */
import { describe, expect, it } from 'vitest'
import { loadCatalogFromDisk } from '../../scripts/lib/catalogFs'
import { crossReferenceProblems } from '../catalog/validate'
import { computeBom, pickEquipmentScrew } from './bom'
import { customFrameFastener, newCustomFrame, newCustomItem } from './customParts'
import { hardwareKey } from './ids'
import { PerHoleSchema, type PerHole } from './schema/catalog'
import { ThreadSchema, type Thread } from './schema/common'
import { PlanSchema } from './schema/plan'
import { defaultSettings } from './schema/settings'

const catalog = loadCatalogFromDisk({ include: (path) => path.startsWith('hardware/') })
const NONE: ReadonlySet<string> = new Set()
const TODAY = '2026-10-11'

function frameFor(thread: Thread, perHole: PerHole) {
  return newCustomFrame(
    {
      name: `Rack ${thread} ${perHole}`,
      heightU: 8,
      innerWidthMm: 220,
      depthMm: 300,
      rearOpen: true,
      thread,
      perHole,
      today: TODAY,
    },
    NONE,
  )
}

describe('custom frame fasteners on the shared hardware', () => {
  it('only name stock screws and nuts of the frame’s thread', () => {
    expect(catalog.errors).toEqual([])
    for (const thread of ThreadSchema.options) {
      for (const perHole of PerHoleSchema.options) {
        const frame = frameFor(thread, perHole)
        const problems = crossReferenceProblems(frame, catalog.lookup)
        // No 12-24 screws or 10-32 / M5 cage nuts in the catalog yet: the BOM says so instead.
        const expected = [
          ...(thread === '12-24' ? ['equipmentFastener.screwIds: list at least one screw'] : []),
          ...(perHole !== 'screw' && frame.equipmentFastener.nutId === undefined
            ? [`equipmentFastener.nutId: "${perHole}" needs the nut's hardware id`]
            : []),
        ]
        expect(problems, `${thread} ${perHole}`).toEqual(expected)
      }
    }
  })

  it('lets the BOM pick the usual rack screw', () => {
    const pick = (thread: Thread, perHole: PerHole) =>
      pickEquipmentScrew(frameFor(thread, perHole), catalog.lookup)?.hardwareId
    expect(pick('M6', 'screw+cage-nut')).toBe('screw-m6x12-shcs')
    expect(pick('M6', 'screw')).toBe('screw-m6x10-shcs')
    expect(pick('M6', 'screw+nut')).toBe('screw-m6x16-shcs')
    expect(pick('M5', 'screw')).toBe('screw-m5x10-shcs')
    expect(pick('10-32', 'screw')).toBe('screw-10-32x1-2in')
    expect(customFrameFastener('M3', 'screw+nut').nutId).toBe('nut-m3-hex')
  })

  it('counts rack screws and cage nuts for a custom mount on a custom frame', () => {
    const frame = frameFor('M6', 'screw+cage-nut')
    const mount = newCustomItem(
      {
        name: 'Switch shelf',
        category: 'shelf',
        heightSixths: 6,
        depthMm: 150,
        holds: { kind: 'shelf', maxW: 210, maxD: 140 },
        prints: [{ plate: 'Shelf', count: 1, gramsPerPrint: 120 }],
        hardware: [{ hardwareId: 'screw-m3x8-shcs', count: 4 }],
        today: TODAY,
      },
      NONE,
    )
    const plan = PlanSchema.parse({
      schema: 1,
      id: 'plan-custom',
      rackId: 'rack-custom',
      name: 'Custom rack',
      createdAt: '2026-10-11T09:30:00.000Z',
      updatedAt: '2026-10-11T09:30:00.000Z',
      frame: { frameId: frame.id, sections: [{ id: 'sec-1', typeId: 'rack' }] },
      placements: [{ id: 'pl-1', itemId: mount.id, y: 0 }],
      custom: { frames: [frame], items: [mount], devices: [], hardware: [] },
    })
    const settings = { ...defaultSettings(), sparePct: { default: 0 } }
    const bom = computeBom(plan, catalog.lookup, settings, {})
    const need = (key: string) => bom.lines.find((line) => line.key === key)?.need
    expect(need(hardwareKey('screw-m6x12-shcs'))).toBe(4)
    expect(need(hardwareKey('cage-nut-m6'))).toBe(4)
    expect(need(hardwareKey('screw-m3x8-shcs'))).toBe(4)
    expect(need(`print:${mount.id}/shelf`)).toBe(1)
    expect(bom.warnings).toEqual([])
  })
})
