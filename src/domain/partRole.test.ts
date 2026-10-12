import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import {
  catalogEntryRole,
  deviceRole,
  itemRole,
  PART_ROLE_LABEL,
  PART_ROLES,
  placementRole,
  type PartRole,
} from './partRole'
import {
  catalogBundle,
  createCatalogLookup,
  DeviceCategorySchema,
  DeviceSchema,
  ItemSchema,
  type Device,
  type DeviceCategory,
  type Item,
} from './schema/catalog'
import type { PlacedDevice } from './schema/plan'

const VERIFIED = { by: 'test', date: '2026-10-12', method: 'unverified' } as const

function item(input: Record<string, unknown>): Item {
  return ItemSchema.parse({
    kind: 'item',
    category: 'mount',
    verified: VERIFIED,
    name: String(input.id),
    heightSixths: 6,
    depthMm: 100,
    mount: { front: 4 },
    ...input,
  })
}

function slot(id: string, categories?: DeviceCategory[]) {
  return {
    id,
    kind: 'area',
    maxW: 210,
    maxD: 150,
    layout: { xMm: 0, yMm: 0, zMm: 0 },
    ...(categories === undefined ? {} : { accepts: { categories } }),
  }
}

function device(id: string, category: DeviceCategory, rackmount = false): Device {
  return DeviceSchema.parse({
    kind: 'device',
    id,
    brand: 'Test',
    model: id,
    category,
    dims: { w: 90, d: 60, h: 25 },
    verified: VERIFIED,
    ...(rackmount ? { rackmount: { heightSixths: 6, face: 'front', depthMm: 100 } } : {}),
  })
}

const SHELF = item({ id: 'shelf', slots: [slot('left'), slot('right')] })
const PC_MOUNT = item({ id: 'pc-mount', slots: [slot('bay', ['mini-pc'])] })
const BLANK = item({ id: 'blank', render: { style: 'blank' } })
const FEET = item({ kind: 'extra', id: 'feet', category: 'accessory', heightSixths: 0 })

/** One loose device per category, plus ear-mounted gear. */
const DEVICES = DeviceCategorySchema.options.map((category) => device(`dev-${category}`, category))
const RACK_SWITCH = device('rack-switch', 'switch', true)
const RACK_UPS = device('rack-ups', 'ups', true)

const CATALOG = createCatalogLookup(
  catalogBundle([SHELF, PC_MOUNT, BLANK, FEET, ...DEVICES, RACK_SWITCH, RACK_UPS]),
)

function placed(slotId: string, category: DeviceCategory, index = 0): PlacedDevice {
  return { id: `dv-${slotId}-${index}`, deviceId: `dev-${category}`, slotId, have: false }
}

describe('deviceRole', () => {
  const expected: Record<DeviceCategory, PartRole> = {
    'mini-pc': 'compute',
    sbc: 'compute',
    nas: 'storage',
    drive: 'storage',
    switch: 'network',
    router: 'network',
    gateway: 'network',
    'patch-panel': 'network',
    kvm: 'network',
    pdu: 'power',
    ups: 'power',
    'power-brick': 'power',
    other: 'neutral',
  }

  it.each(DeviceCategorySchema.options)('maps %s', (category) => {
    expect(deviceRole(category)).toBe(expected[category])
  })
})

describe('itemRole', () => {
  it('takes the role its slots accept', () => {
    expect(itemRole(PC_MOUNT)).toBe('compute')
  })

  it('takes the most common accepted role across slots', () => {
    const mixed = item({
      id: 'mixed',
      slots: [slot('a', ['nas']), slot('b', ['mini-pc', 'sbc']), slot('c', ['drive', 'drive'])],
    })
    // storage 3 (nas, drive, drive) beats compute 2.
    expect(itemRole(mixed)).toBe('storage')
  })

  it('breaks a tie with the first role in slot order', () => {
    const tie = item({ id: 'tie', slots: [slot('a', ['switch']), slot('b', ['nas'])] })
    expect(itemRole(tie)).toBe('network')
    const flipped = item({ id: 'flip', slots: [slot('a', ['nas']), slot('b', ['switch'])] })
    expect(itemRole(flipped)).toBe('storage')
  })

  it('ignores neutral categories in the vote', () => {
    const shelf = item({ id: 'other', slots: [slot('a', ['other', 'other', 'ups'])] })
    expect(itemRole(shelf)).toBe('power')
  })

  it('falls back to the render style: power strips and keystone panels', () => {
    expect(itemRole(item({ id: 'strip', render: { style: 'power' } }))).toBe('power')
    expect(itemRole(item({ id: 'keys', render: { style: 'keystone' } }))).toBe('network')
    // Accepted categories win over the style.
    expect(
      itemRole(item({ id: 'pc', render: { style: 'power' }, slots: [slot('a', ['sbc'])] })),
    ).toBe('compute')
  })

  it("falls back to the item category 'power'", () => {
    expect(itemRole(item({ id: 'shelf', category: 'power' }))).toBe('power')
  })

  it('is neutral for blanks, vents, fans and empty shelves', () => {
    expect(itemRole(BLANK)).toBe('neutral')
    expect(itemRole(SHELF)).toBe('neutral')
    expect(itemRole(item({ id: 'vent', render: { style: 'vent' } }))).toBe('neutral')
    expect(itemRole(item({ id: 'fan', render: { style: 'fan' } }))).toBe('neutral')
  })
})

describe('placementRole', () => {
  it('takes the role of the devices on it', () => {
    const role = placementRole({ itemId: 'shelf', devices: [placed('left', 'nas')] }, CATALOG)
    expect(role).toBe('storage')
  })

  it('takes the most common device role', () => {
    const devices = [placed('left', 'sbc'), placed('left', 'nas', 1), placed('right', 'nas', 2)]
    expect(placementRole({ itemId: 'shelf', devices }, CATALOG)).toBe('storage')
  })

  it('breaks a tie with the first device in slot order, not stored order', () => {
    // Stored right first, but the left slot comes first on the item.
    const devices = [placed('right', 'switch'), placed('left', 'mini-pc')]
    expect(placementRole({ itemId: 'shelf', devices }, CATALOG)).toBe('compute')
    const sameSlot = [placed('left', 'switch'), placed('left', 'mini-pc', 1)]
    expect(placementRole({ itemId: 'shelf', devices: sameSlot }, CATALOG)).toBe('network')
    // 2 vs 2: the role seen first wins, not the one that reached 2 first.
    const twoEach = ['ups', 'nas', 'nas', 'ups'] as const
    const tied = twoEach.map((category, index) => placed('left', category, index))
    expect(placementRole({ itemId: 'shelf', devices: tied }, CATALOG)).toBe('power')
  })

  it("falls back to the item's role when it holds nothing (or only unknown or neutral gear)", () => {
    expect(placementRole({ itemId: 'pc-mount', devices: [] }, CATALOG)).toBe('compute')
    expect(placementRole({ itemId: 'shelf', devices: [] }, CATALOG)).toBe('neutral')
    const unknown = [{ id: 'dv-x', deviceId: 'gone', slotId: 'bay', have: false }]
    expect(placementRole({ itemId: 'pc-mount', devices: unknown }, CATALOG)).toBe('compute')
    const other = [placed('left', 'other')]
    expect(placementRole({ itemId: 'shelf', devices: other }, CATALOG)).toBe('neutral')
  })

  it('lets the devices win over what the mount accepts', () => {
    const devices = [placed('bay', 'nas')]
    expect(placementRole({ itemId: 'pc-mount', devices }, CATALOG)).toBe('storage')
  })

  it("gives ear-mounted gear its device's role", () => {
    expect(placementRole({ itemId: 'rack-switch', devices: [] }, CATALOG)).toBe('network')
    expect(placementRole({ itemId: 'rack-ups', devices: [] }, CATALOG)).toBe('power')
  })

  it('is neutral for unknown ids, extras and devices without ears', () => {
    expect(placementRole({ itemId: 'gone-mount', devices: [] }, CATALOG)).toBe('neutral')
    expect(placementRole({ itemId: 'feet', devices: [] }, CATALOG)).toBe('neutral')
    expect(placementRole({ itemId: 'dev-nas', devices: [] }, CATALOG)).toBe('neutral')
  })

  const nonNeutral = fc.constantFrom(
    ...DeviceCategorySchema.options.filter((category) => category !== 'other'),
  )

  test.prop([fc.array(nonNeutral, { minLength: 1, maxLength: 8 })])(
    "matches the most common role, ties -> first, on a shelf's left slot",
    (categories) => {
      const devices = categories.map((category, index) => placed('left', category, index))
      const roles = categories.map(deviceRole)
      const counts = PART_ROLES.map((role) => roles.filter((each) => each === role).length)
      const top = Math.max(...counts)
      const expected = roles.find((role) => counts[PART_ROLES.indexOf(role)] === top)
      expect(placementRole({ itemId: 'shelf', devices }, CATALOG)).toBe(expected)
    },
  )
})

describe('catalogEntryRole', () => {
  it('resolves items, devices and unknown ids', () => {
    expect(catalogEntryRole(CATALOG, 'pc-mount')).toBe('compute')
    expect(catalogEntryRole(CATALOG, 'dev-gateway')).toBe('network')
    expect(catalogEntryRole(CATALOG, 'feet')).toBe('neutral')
    expect(catalogEntryRole(CATALOG, 'gone')).toBe('neutral')
  })
})

describe('PART_ROLE_LABEL', () => {
  it('names every role', () => {
    expect(PART_ROLES.map((role) => PART_ROLE_LABEL[role])).toEqual([
      'Compute',
      'Storage',
      'Network',
      'Power',
      'Panels and shelves',
    ])
  })
})
