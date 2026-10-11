import { describe, expect, it } from 'vitest'
import {
  SAMPLE_CATALOG_ENTRIES,
  SAMPLE_TIME,
  sampleCatalog,
  samplePlan,
} from './__fixtures__/samplePlan'
import type { PartInstance } from './api'
import { assemble, PROXY_PART_KEYS } from './assembly'
import { panelFaceHeightMm, sixthsToMm } from './geometry'
import { DEVICE_GAP_MM, orientedDims } from './placement'
import {
  catalogBundle,
  createCatalogLookup,
  DeviceSchema,
  type CatalogLookup,
  type Frame,
  type Slot,
} from './schema/catalog'
import type { Orientation } from './schema/common'
import { checkEntryIntegrity } from './schema/integrity'
import { PlanSchema, type Plan } from './schema/plan'

type Vec = [number, number, number]

interface Box {
  min: Vec
  max: Vec
}

// Fixture frame: ears 236.525 mm apart, a 222 mm opening, 230 mm deep.
const HALF_EARS = 236.525 / 2
const OPENING_LEFT = -111
const DEPTH = 230

/** The fixture catalog with the frame changed (e.g. without 3D data, for generic proxies). */
function catalogWithFrame(changes: Partial<Frame>): CatalogLookup {
  const entries = SAMPLE_CATALOG_ENTRIES.map((entry) =>
    entry.kind === 'frame' ? { ...entry, ...changes } : entry,
  )
  return createCatalogLookup(catalogBundle(entries))
}

const RULES = sampleCatalog()
const GENERIC = catalogWithFrame({ parts3d: undefined, assembly3d: undefined })

function planWith(input: Record<string, unknown>): Plan {
  return PlanSchema.parse({
    schema: 1,
    id: 'plan-test',
    rackId: 'rack-test',
    name: 'Test',
    createdAt: SAMPLE_TIME,
    updatedAt: SAMPLE_TIME,
    frame: { frameId: 'kws-v2' },
    ...input,
  })
}

/** A KWS stack of 3U/6U sections, bottom -> top, with nothing placed. */
function stack(heights: readonly number[], frame: Record<string, unknown> = {}): Plan {
  const sections = heights.map((heightU, index) => ({
    id: `sec-${index + 1}`,
    typeId: `s${heightU}`,
  }))
  return planWith({ frame: { frameId: 'kws-v2', sections, ...frame } })
}

/** Rounds to 1e-6 mm (and -0 to 0) so float noise does not matter in comparisons. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6 || 0
}

function rounded([x, y, z]: Vec): Vec {
  return [round(x), round(y), round(z)]
}

function apply(matrix: readonly number[], [x, y, z]: Vec): Vec {
  const m = (index: number): number => matrix[index] ?? Number.NaN
  return [
    m(0) * x + m(4) * y + m(8) * z + m(12),
    m(1) * x + m(5) * y + m(9) * z + m(13),
    m(2) * x + m(6) * y + m(10) * z + m(14),
  ]
}

function centre(part: PartInstance): Vec {
  return rounded(apply(part.matrix, [0, 0, 0]))
}

/** Centre of the bottom face of a part's envelope: the point assembly rules place. */
function bottomCentre(part: PartInstance): Vec {
  return rounded(apply(part.matrix, [0, -part.proxyDims.h / 2, 0]))
}

function determinant(matrix: readonly number[]): number {
  const m = (index: number): number => matrix[index] ?? Number.NaN
  return (
    m(0) * (m(5) * m(10) - m(9) * m(6)) -
    m(4) * (m(1) * m(10) - m(9) * m(2)) +
    m(8) * (m(1) * m(6) - m(5) * m(2))
  )
}

/** World-space bounding box of an instance's proxy box. */
function worldBox(part: PartInstance): Box {
  const { w, h, d } = part.proxyDims
  const corners: Vec[] = []
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corners.push(apply(part.matrix, [(sx * w) / 2, (sy * h) / 2, (sz * d) / 2]))
      }
    }
  }
  const axis = (index: 0 | 1 | 2): number[] => corners.map((corner) => corner[index])
  return {
    min: rounded([Math.min(...axis(0)), Math.min(...axis(1)), Math.min(...axis(2))]),
    max: rounded([Math.max(...axis(0)), Math.max(...axis(1)), Math.max(...axis(2))]),
  }
}

function sizeOf(box: Box): Vec {
  return rounded([box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]])
}

function expectInside(inner: Box, outer: Box): void {
  for (const axis of [0, 1, 2] as const) {
    expect(inner.min[axis]).toBeGreaterThanOrEqual(round(outer.min[axis]))
    expect(inner.max[axis]).toBeLessThanOrEqual(round(outer.max[axis]))
  }
}

function countBy(parts: readonly PartInstance[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const part of parts) counts[part.partKey] = (counts[part.partKey] ?? 0) + 1
  return counts
}

function byKey(parts: readonly PartInstance[], key: string): PartInstance {
  const part = parts.find((candidate) => candidate.key === key)
  if (part === undefined) throw new Error(`no instance "${key}"`)
  return part
}

function slotOf(itemId: string, slotId: string): Slot {
  const slot = RULES.item(itemId)?.slots.find((candidate) => candidate.id === slotId)
  if (slot === undefined) throw new Error(`no slot ${itemId}/${slotId}`)
  return slot
}

/** World box of a slot of a front-mounted, full-bay item placed at `ySixths`. */
function frontSlotBox(ySixths: number, slot: Slot): Box {
  const x = OPENING_LEFT + slot.layout.xMm
  const y = sixthsToMm(ySixths) + slot.layout.yMm
  return {
    min: [x, y, slot.layout.zMm - slot.maxD],
    max: [x + slot.maxW, y + (slot.maxH ?? Number.POSITIVE_INFINITY), slot.layout.zMm],
  }
}

// ---------------------------------------------------------------------------------------------

describe('assemble: generic frame proxies', () => {
  it('emits 4 posts per section, a connector per joint and 2 plates for [3, 6, 3]', () => {
    expect(countBy(assemble(stack([3, 6, 3]), GENERIC))).toEqual({
      [PROXY_PART_KEYS.post]: 12,
      [PROXY_PART_KEYS.connector]: 2,
      [PROXY_PART_KEYS.topPlate]: 1,
      [PROXY_PART_KEYS.bottomPlate]: 1,
    })
  })

  it('emits the same per-unit counts for [6, 6]', () => {
    expect(countBy(assemble(stack([6, 6]), GENERIC))).toEqual({
      [PROXY_PART_KEYS.post]: 8,
      [PROXY_PART_KEYS.connector]: 1,
      [PROXY_PART_KEYS.topPlate]: 1,
      [PROXY_PART_KEYS.bottomPlate]: 1,
    })
  })

  it('puts connectors on the joints: 3U = 133.35 mm and 9U = 400.05 mm', () => {
    const connectors = assemble(stack([3, 6, 3]), GENERIC).filter(
      (part) => part.partKey === PROXY_PART_KEYS.connector,
    )
    expect(connectors.map((part) => centre(part)[1])).toEqual([133.35, 400.05])
    expect(connectors.map((part) => part.sourceId)).toEqual(['sec-1/sec-2', 'sec-2/sec-3'])
    expect(connectors[0]?.label).toBe('Joint 1 connector')
    expect(connectors[0]?.proxyDims.w).toBeCloseTo(236.525 + 20, 9)
    expect(connectors[0]?.proxyDims.h).toBe(4)
    const sixSix = assemble(stack([6, 6]), GENERIC).filter(
      (part) => part.partKey === PROXY_PART_KEYS.connector,
    )
    expect(sixSix.map((part) => centre(part)[1])).toEqual([266.7])
  })

  it('sizes posts to their section and stands them on the corners', () => {
    const parts = assemble(stack([3, 6, 3]), GENERIC)
    const posts = ['fl', 'fr', 'rl', 'rr'].map((corner) =>
      byKey(parts, `section:sec-2:post-${corner}`),
    )
    expect(posts.map(centre)).toEqual([
      [round(-HALF_EARS), 266.7, -10],
      [round(HALF_EARS), 266.7, -10],
      [round(-HALF_EARS), 266.7, -DEPTH + 10],
      [round(HALF_EARS), 266.7, -DEPTH + 10],
    ])
    for (const post of posts) {
      expect(post.proxyDims).toEqual({ w: 20, h: 266.7, d: 20 })
      expect(post.label).toBe('Section 2 (6U) post')
      expect(post.sourceId).toBe('sec-2')
      expectInside(worldBox(post), { min: [-130, 133.35, -DEPTH], max: [130, 400.05, 0] })
    }
  })

  it('caps the stack with plates of inner width × depth × 6 mm', () => {
    const parts = assemble(stack([3, 6, 3]), GENERIC)
    const top = byKey(parts, 'cap:top:plate')
    const bottom = byKey(parts, 'cap:bottom:plate')
    expect(top.proxyDims).toEqual({ w: 222, h: 6, d: DEPTH })
    expect(centre(top)).toEqual([0, 536.4, -DEPTH / 2])
    expect(centre(bottom)).toEqual([0, -3, -DEPTH / 2])
    expect([top.sourceId, bottom.sourceId]).toEqual(['top', 'bottom'])
  })

  it('follows rack options that change the depth', () => {
    const parts = assemble(stack([6], { options: { deep: true } }), GENERIC)
    expect(byKey(parts, 'cap:top:plate').proxyDims.d).toBe(320)
    expect(centre(byKey(parts, 'section:sec-1:post-rr'))[2]).toBe(-310)
  })

  it('draws nothing for an empty stack', () => {
    expect(assemble(stack([]), GENERIC)).toEqual([])
  })

  it('falls back to EIA sizes and Have heights for an unknown frame', () => {
    const plan = planWith({
      frame: {
        frameId: 'mystery-frame',
        sections: [
          { id: 'sec-a', typeId: 'big', have: { at: SAMPLE_TIME, typeId: 'big', heightU: 4 } },
          { id: 'sec-b', typeId: 'small' },
        ],
      },
    })
    const parts = assemble(plan, RULES)
    expect(countBy(parts)).toEqual({
      [PROXY_PART_KEYS.post]: 4,
      [PROXY_PART_KEYS.connector]: 1,
      [PROXY_PART_KEYS.topPlate]: 1,
      [PROXY_PART_KEYS.bottomPlate]: 1,
    })
    const post = byKey(parts, 'section:sec-a:post-rr')
    expect(post.proxyDims.h).toBeCloseTo(177.8, 9)
    expect(post.state).toBe('have')
    expect(centre(post)).toEqual([round(HALF_EARS), 88.9, -250 + 10])
    expect(byKey(parts, 'cap:top:plate').proxyDims).toEqual({ w: 222.25, h: 6, d: 250 })
  })
})

describe('assemble: assembly3d rules', () => {
  const keys = {
    leg3: 'kws-v2/leg-3u',
    leg6: 'kws-v2/leg-6u',
    connector: 'kws-v2/connector',
    handle: 'kws-v2/top-handle',
    flat: 'kws-v2/top-flat',
    base: 'kws-v2/base-leg',
  }
  const inward = round(HALF_EARS - 12)

  it('places parts per section, joint and cap for [3, 6, 3]', () => {
    expect(countBy(assemble(stack([3, 6, 3]), RULES))).toEqual({
      [keys.leg3]: 8,
      [keys.leg6]: 4,
      [keys.connector]: 8,
      [keys.handle]: 2,
      [keys.base]: 4,
    })
  })

  it('places parts for [6, 6]', () => {
    expect(countBy(assemble(stack([6, 6]), RULES))).toEqual({
      [keys.leg6]: 8,
      [keys.connector]: 4,
      [keys.handle]: 2,
      [keys.base]: 4,
    })
  })

  it('evaluates rule conditions with the cap options', () => {
    const parts = assemble(stack([3, 6], { caps: { top: { options: { top: 'flat' } } } }), RULES)
    expect(countBy(parts)[keys.handle]).toBeUndefined()
    const top = byKey(parts, 'cap:top:rule-4-centre')
    expect(top.partKey).toBe(keys.flat)
    expect(bottomCentre(top)).toEqual([0, 400.05, -115])
  })

  it('mirrors the front-left instance to the other corners', () => {
    const parts = assemble(stack([3, 6, 3]), RULES)
    const legs = ['fl', 'fr', 'rl', 'rr'].map((corner) =>
      byKey(parts, `section:sec-2:rule-1-${corner}`),
    )
    expect(legs.map(bottomCentre)).toEqual([
      [-inward, 133.35, -12],
      [inward, 133.35, -12],
      [-inward, 133.35, -DEPTH + 12],
      [inward, 133.35, -DEPTH + 12],
    ])
    // mirrorX: the right-hand legs use the mirrored part.
    expect(legs.map((leg) => Math.sign(determinant(leg.matrix)))).toEqual([1, -1, 1, -1])
    expect(legs[0]?.proxyDims).toEqual({ w: 24, h: 266.7, d: 24 })
    expect(legs[0]?.label).toBe('6U leg')
    expect(legs[0]?.sourceId).toBe('sec-2')
  })

  it('keeps parts rigid where the rule does not ask for mirroring', () => {
    const parts = assemble(stack([3, 6, 3]), RULES)
    const connectors = parts.filter((part) => part.partKey === keys.connector)
    expect(connectors.every((part) => determinant(part.matrix) > 0)).toBe(true)
    const rr = byKey(parts, 'joint:sec-2/sec-3:rule-2-rr')
    expect(bottomCentre(rr)).toEqual([inward, 394.05, -DEPTH + 12])
    expect(rr.sourceId).toBe('sec-2/sec-3')
  })

  it('places cap parts on top of and under the stack', () => {
    const parts = assemble(stack([3, 6, 3]), RULES)
    const handle = byKey(parts, 'cap:top:rule-3-fr')
    expect(bottomCentre(handle)).toEqual([inward, 533.4, -115])
    expect(determinant(handle.matrix)).toBeLessThan(0)
    const foot = worldBox(byKey(parts, 'cap:bottom:rule-5-fl'))
    expect([foot.min[1], foot.max[1]]).toEqual([-20, 0])
  })

  it('takes Have/Need from sections, joints and caps', () => {
    const parts = assemble(samplePlan(), RULES)
    const states = (prefix: string): Set<string> =>
      new Set(parts.filter((part) => part.key.startsWith(prefix)).map((part) => part.state))
    expect(states('section:sec-bottom-3u:')).toEqual(new Set(['have']))
    expect(states('section:sec-middle-6u:')).toEqual(new Set(['have']))
    expect(states('section:sec-top-3u:')).toEqual(new Set(['need']))
    expect(states('joint:sec-bottom-3u/sec-middle-6u:')).toEqual(new Set(['have']))
    // The new 3U's joint is new too, even though the 6U below it is built.
    expect(states('joint:sec-middle-6u/sec-top-3u:')).toEqual(new Set(['need']))
    expect(states('cap:')).toEqual(new Set(['have']))
  })
})

describe('assemble: placements', () => {
  const parts = assemble(samplePlan(), RULES)

  it('draws a panel per placement, a tray for shelves and trays, and a box per device', () => {
    expect(countBy(parts.filter((part) => part.key.startsWith('placement:')))).toEqual({
      [PROXY_PART_KEYS.panel]: 6,
      [PROXY_PART_KEYS.tray]: 4,
      [PROXY_PART_KEYS.device]: 5,
    })
  })

  it('puts the front panel at y, in front of the rails', () => {
    const power = byKey(parts, 'placement:pl-power:panel')
    expect(centre(power)).toEqual([0, 22.225, 2])
    expect(power.proxyDims.w).toBe(254)
    expect(power.proxyDims.h).toBeCloseTo(panelFaceHeightMm(6), 9)
    expect(power.proxyDims.d).toBe(4)
    expect(worldBox(power).min[2]).toBe(0)
    const shelf = byKey(parts, 'placement:pl-shelf:panel')
    expect(centre(shelf)[1]).toBe(round(sixthsToMm(24) + 44.45))
    expect(byKey(parts, 'placement:pl-tiny-1:panel').label).toBe('Proxmox 1 (Lenovo Tiny mount 1U)')
  })

  it('puts a tray behind the panel for shelf and tray styles only', () => {
    const tray = byKey(parts, 'placement:pl-shelf:tray')
    expect(tray.proxyDims).toEqual({ w: 222 - 10, h: 3, d: 200 })
    expect(centre(tray)).toEqual([0, round(sixthsToMm(24) + 1.5), -100])
    expect(parts.some((part) => part.key === 'placement:pl-power:tray')).toBe(false)
    expect(parts.some((part) => part.key === 'placement:pl-patch:tray')).toBe(false)
  })

  it('keeps every device box inside its slot', () => {
    const plan = samplePlan()
    for (const placement of plan.placements) {
      for (const device of placement.devices) {
        const box = worldBox(byKey(parts, `placement:${placement.id}:device:${device.id}`))
        expectInside(box, frontSlotBox(placement.y, slotOf(placement.itemId, device.slotId)))
      }
    }
  })

  it('centres a device in a fixed slot and packs an area slot left to right', () => {
    const tiny = worldBox(byKey(parts, 'placement:pl-tiny-1:device:dev-tiny-1'))
    expect([tiny.min[0], tiny.max[0]]).toEqual([-89.5, 89.5])
    // The Pi is auto-packed at the left of the deck; the switch keeps its xMm of 100.
    const pi = worldBox(byKey(parts, 'placement:pl-shelf:device:dev-pi'))
    const flexMini = worldBox(byKey(parts, 'placement:pl-shelf:device:dev-switch'))
    expect(pi.min[0]).toBe(OPENING_LEFT + 6)
    expect(flexMini.min[0]).toBe(OPENING_LEFT + 6 + 100)
    expect(pi.min[1]).toBe(round(sixthsToMm(24) + 3))
    expect(pi.max[2]).toBe(-2)
  })

  it('takes Have/Need from the placement and from each device', () => {
    const state = (key: string): string => byKey(parts, key).state
    expect(state('placement:pl-shelf:panel')).toBe('have')
    expect(state('placement:pl-shelf:tray')).toBe('have')
    expect(state('placement:pl-shelf:device:dev-pi')).toBe('have')
    expect(state('placement:pl-shelf:device:dev-switch')).toBe('need')
    expect(state('placement:pl-nas:panel')).toBe('need')
    expect(state('placement:pl-nas:device:dev-nas')).toBe('need')
    expect(byKey(parts, 'placement:pl-nas:device:dev-nas').label).toBe('DIY N100 NAS')
    expect(byKey(parts, 'placement:pl-shelf:device:dev-pi').sourceId).toBe('pl-shelf')
  })

  it('resolves the custom devices a plan carries', () => {
    expect(byKey(parts, 'placement:pl-nas:device:dev-nas').proxyDims).toEqual({
      w: 180,
      h: 70,
      d: 200,
    })
  })

  it('mounts rear-facing items on the rear rails, facing back', () => {
    const plan = planWith({
      placements: [
        {
          id: 'pl-rear',
          itemId: 'kws-shelf-2u',
          y: 0,
          face: 'rear',
          devices: [{ id: 'dev-pi', deviceId: 'raspberry-pi-5', slotId: 'deck' }],
        },
      ],
    })
    const rear = assemble(plan, RULES)
    const panel = byKey(rear, 'placement:pl-rear:panel')
    expect(centre(panel)).toEqual([0, 44.45, -DEPTH - 2])
    expect(determinant(panel.matrix)).toBeCloseTo(1, 9)
    expect(centre(byKey(rear, 'placement:pl-rear:tray'))).toEqual([0, 1.5, -DEPTH + 100])
    // Seen from the rear, the deck's left edge is on the rack's right side.
    const slot = slotOf('kws-shelf-2u', 'deck')
    const right = -OPENING_LEFT - slot.layout.xMm
    const slotBox: Box = {
      min: [right - slot.maxW, slot.layout.yMm, -DEPTH - slot.layout.zMm],
      max: [right, slot.layout.yMm + (slot.maxH ?? 0), -DEPTH - slot.layout.zMm + slot.maxD],
    }
    const pi = worldBox(byKey(rear, 'placement:pl-rear:device:dev-pi'))
    expectInside(pi, slotBox)
    expect(pi.max[0]).toBe(right)
  })

  it('splits the panel and the opening for half-bay placements', () => {
    const plan = planWith({
      placements: [
        { id: 'pl-left', itemId: 'kws-blank-1u', y: 0, bay: 'left' },
        { id: 'pl-right', itemId: 'kws-tiny-mount-1u', y: 0, bay: 'right' },
      ],
    })
    const halves = assemble(plan, RULES)
    const left = byKey(halves, 'placement:pl-left:panel')
    expect(centre(left)[0]).toBe(-63.5)
    expect(left.proxyDims.w).toBe(127)
    const tray = byKey(halves, 'placement:pl-right:tray')
    expect(centre(tray)[0]).toBe(55.5)
    expect(tray.proxyDims.w).toBe(111 - 10)
  })

  it('draws unknown items and devices as labelled placeholders', () => {
    const plan = planWith({
      placements: [
        {
          id: 'pl-x',
          itemId: 'mystery-mount',
          name: 'Mystery mount',
          heightSixths: 12,
          y: 6,
          devices: [
            { id: 'dev-x', deviceId: 'mystery-device', slotId: 'nowhere' },
            { id: 'dev-pi', deviceId: 'raspberry-pi-5', slotId: 'nowhere' },
          ],
        },
      ],
    })
    const unknown = assemble(plan, RULES)
    expect(unknown.map((part) => part.key)).toEqual([
      'placement:pl-x:panel',
      'placement:pl-x:device:dev-x',
      'placement:pl-x:device:dev-pi',
    ])
    const panel = byKey(unknown, 'placement:pl-x:panel')
    expect(panel.label).toBe('Mystery mount')
    expect(panel.proxyDims.h).toBeCloseTo(panelFaceHeightMm(12), 9)
    const placeholder = byKey(unknown, 'placement:pl-x:device:dev-x')
    expect(placeholder.label).toBe('Unknown device "mystery-device"')
    expect(placeholder.proxyDims).toEqual({ w: 100, h: 30, d: 100 })
    // Unknown slots use the whole opening: the known device is packed, the unknown one lines up
    // after it.
    const opening: Box = { min: [OPENING_LEFT, 44.45, -DEPTH], max: [111, 44.45 + 88.9, 0] }
    const [mystery, pi] = ['dev-x', 'dev-pi'].map((id) =>
      worldBox(byKey(unknown, `placement:pl-x:device:${id}`)),
    )
    if (mystery === undefined || pi === undefined) throw new Error('two device boxes')
    expectInside(mystery, opening)
    expectInside(pi, opening)
    expect(pi.min[0]).toBe(OPENING_LEFT)
    expect(mystery.min[0]).toBe(round(pi.max[0] + DEVICE_GAP_MM))
  })

  it('draws ear-mounted gear placed directly as a panel and a body', () => {
    const switch10 = DeviceSchema.parse({
      kind: 'device',
      id: 'rack-switch-10in',
      brand: 'Generic',
      model: '10" switch',
      category: 'switch',
      dims: { w: 250, d: 120, h: 40 },
      rackmount: { heightSixths: 6, face: 'front', depthMm: 120 },
      verified: { by: 'test', date: '2026-10-11', method: 'unverified' },
    })
    const catalog = createCatalogLookup(catalogBundle([...SAMPLE_CATALOG_ENTRIES, switch10]))
    const plan = planWith({
      placements: [{ id: 'pl-sw', itemId: 'rack-switch-10in', y: 12, have: { at: SAMPLE_TIME } }],
    })
    const gear = assemble(plan, catalog)
    expect(gear.map((part) => part.key)).toEqual(['placement:pl-sw:panel', 'placement:pl-sw:body'])
    const body = byKey(gear, 'placement:pl-sw:body')
    expect(body.proxyDims).toEqual({ w: 222, h: 40, d: 120 })
    expect(body.label).toBe('Generic 10" switch')
    expect(body.state).toBe('have')
    expectInside(worldBox(body), { min: [OPENING_LEFT, 88.9, -120], max: [111, 133.35, 0] })
  })

  it('turns devices into their orientation without mirroring them', () => {
    const plan = planWith({
      placements: [
        {
          id: 'pl-nas',
          itemId: 'kws-nas-tray-2u',
          y: 0,
          devices: [
            {
              id: 'dev-rotated',
              deviceId: 'ubiquiti-usw-flex-mini',
              slotId: 'bay',
              orientation: 'flat-rotated',
            },
          ],
        },
        {
          id: 'pl-shelf',
          itemId: 'kws-shelf-2u',
          y: 12,
          devices: [
            {
              id: 'dev-side',
              deviceId: 'ubiquiti-usw-flex-mini',
              slotId: 'deck',
              orientation: 'on-side',
            },
            {
              id: 'dev-up',
              deviceId: 'ubiquiti-usw-flex-mini',
              slotId: 'deck',
              orientation: 'upright',
            },
          ],
        },
      ],
    })
    const turned = assemble(plan, RULES)
    const flexMini = { w: 107, h: 21, d: 70 }
    const cases: ReadonlyArray<[string, Orientation]> = [
      ['placement:pl-nas:device:dev-rotated', 'flat-rotated'],
      ['placement:pl-shelf:device:dev-side', 'on-side'],
      ['placement:pl-shelf:device:dev-up', 'upright'],
    ]
    for (const [key, orientation] of cases) {
      // The 3D box matches the size the placement engine checks for that orientation.
      const { w, h, d } = orientedDims(flexMini, orientation)
      expect(sizeOf(worldBox(byKey(turned, key)))).toEqual([w, h, d])
      expect(determinant(byKey(turned, key).matrix)).toBeCloseTo(1, 9)
    }
    expectInside(
      worldBox(byKey(turned, 'placement:pl-nas:device:dev-rotated')),
      frontSlotBox(0, slotOf('kws-nas-tray-2u', 'bay')),
    )
  })

  it('picks the first allowed orientation that fits when a device has none', () => {
    const plan = planWith({
      placements: [
        {
          id: 'pl-nas',
          itemId: 'kws-nas-tray-2u',
          y: 0,
          // 210 mm wide: too wide flat for the 200 mm bay, fits turned (flat-rotated).
          devices: [{ id: 'dev-wide', deviceId: 'custom:wide-box', slotId: 'bay' }],
        },
      ],
      custom: {
        devices: [
          {
            kind: 'device',
            id: 'custom:wide-box',
            brand: 'My',
            model: 'Wide box',
            category: 'other',
            dims: { w: 210, d: 150, h: 60 },
            verified: { by: 'me', date: '2026-10-11', method: 'calipers' },
          },
        ],
      },
    })
    const box = worldBox(byKey(assemble(plan, RULES), 'placement:pl-nas:device:dev-wide'))
    expect(sizeOf(box)).toEqual([150, 60, 210])
    expectInside(box, frontSlotBox(0, slotOf('kws-nas-tray-2u', 'bay')))
  })
})

describe('assemble: output contract', () => {
  it('returns affine column-major matrices and unique, stable keys', () => {
    const first = assemble(samplePlan(), RULES)
    for (const part of first) {
      expect(part.matrix).toHaveLength(16)
      const bottomRow = [part.matrix[3], part.matrix[7], part.matrix[11], part.matrix[15]]
      expect(bottomRow).toEqual([0, 0, 0, 1])
    }
    const keys = first.map((part) => part.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(assemble(samplePlan(), RULES).map((part) => part.key)).toEqual(keys)
  })

  it('runs on a fixture catalog that passes the catalog integrity checks', () => {
    for (const entry of SAMPLE_CATALOG_ENTRIES) {
      expect({ id: entry.id, problems: checkEntryIntegrity(entry) }).toEqual({
        id: entry.id,
        problems: [],
      })
    }
  })
})
