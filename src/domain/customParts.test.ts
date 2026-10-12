import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import {
  customAdvancedDetails,
  customDeviceInputOf,
  customFrameFastener,
  customFrameInputOf,
  customId,
  customIdsUsed,
  customItemInputOf,
  customMountForDevice,
  CustomPartError,
  customRefsOf,
  duplicateCustomEntry,
  editCustomDevice,
  editCustomFrame,
  editCustomItem,
  embedCustomEntries,
  embedUsedCustomEntries,
  newCustomDevice,
  newCustomFrame,
  newCustomItem,
  parseSourceLink,
  slugify,
  UNVERIFIED_NOTE,
  type CustomDeviceInput,
  type CustomFrameInput,
  type CustomItemInput,
} from './customParts'
import { canPlace, fitDeviceInSlot, occupiedBox } from './placement'
import {
  DeviceSchema,
  FrameSchema,
  HardwareSchema,
  ItemSchema,
  type CatalogEntry,
  type Hardware,
  type Item,
} from './schema/catalog'
import { IdSchema } from './schema/common'
import { checkEntryIntegrity } from './schema/integrity'
import { PlanSchema, type Plan } from './schema/plan'
import { KWS_FRAME, kwsCatalog, kwsPlan } from './__fixtures__/kws'

const TODAY = '2026-10-11'
const NONE: ReadonlySet<string> = new Set()

const TINY: CustomDeviceInput = {
  brand: 'Lenovo',
  model: 'ThinkCentre M720q Tiny',
  category: 'mini-pc',
  widthMm: 179,
  depthMm: 183,
  heightMm: 34.5,
  weightG: 1320,
  power: 'brick',
  today: TODAY,
}

const MOUNT: CustomItemInput = {
  name: 'Tiny mount 1U',
  category: 'mount',
  heightSixths: 6,
  depthMm: 190,
  holds: { kind: 'device', maxW: 180, maxD: 184, maxH: 36, categories: ['mini-pc'] },
  prints: [
    { plate: 'Mount', count: 1, gramsPerPrint: 85, minutesPerPrint: 150, material: 'PETG' },
    { plate: 'Mount', count: 2 },
  ],
  hardware: [
    { hardwareId: 'screw-m3x8-shcs', count: 4 },
    { hardwareId: 'insert-m3x5x4', count: 4 },
    { hardwareId: 'screw-m3x8-shcs', count: 2 },
  ],
  sourceUrl: 'https://makerworld.com/en/models/1945283-tiny-mount#profileId-2087424',
  designer: 'Tim',
  license: 'BY-SA',
  today: TODAY,
}

const RACK: CustomFrameInput = {
  name: 'DeskPi RackMate T1',
  heightU: 8,
  innerWidthMm: 220,
  depthMm: 300,
  rearOpen: true,
  thread: 'M6',
  perHole: 'screw+cage-nut',
  today: TODAY,
}

function expectValidEntry(entry: CatalogEntry): void {
  expect(checkEntryIntegrity(entry)).toEqual([])
  expect(IdSchema.safeParse(entry.id).success).toBe(true)
  expect(entry.id.startsWith('custom:')).toBe(true)
}

function thrown(run: () => unknown): CustomPartError {
  try {
    run()
  } catch (error) {
    if (error instanceof CustomPartError) return error
    throw error
  }
  throw new Error('Expected a CustomPartError')
}

describe('slugify and customId', () => {
  it('turns names into kebab-case custom ids', () => {
    expect(customId('Lenovo ThinkCentre M720q Tiny', NONE)).toBe(
      'custom:lenovo-thinkcentre-m720q-tiny',
    )
    expect(customId('Shelf 1½U – Café', NONE)).toBe('custom:shelf-1-half-u-cafe')
    expect(customId('2×2 vent (rear)', NONE)).toBe('custom:2x2-vent-rear')
    expect(slugify('  Größe  ')).toBe('grosse')
  })

  it('adds -2, -3 when the id is taken', () => {
    const taken = new Set(['custom:blank', 'custom:blank-2'])
    expect(customId('Blank', taken)).toBe('custom:blank-3')
    expect(customId('Blank', new Set(['custom:blank']))).toBe('custom:blank-2')
  })

  it('falls back to "part" for names without letters or digits it can use', () => {
    expect(customId('   ', NONE)).toBe('custom:part')
    expect(customId('日本語', NONE)).toBe('custom:part')
    expect(customId('', new Set(['custom:part']))).toBe('custom:part-2')
  })

  it('stays within 100 characters, also with a suffix', () => {
    const first = customId('a'.repeat(300), NONE)
    expect(first).toHaveLength(100)
    const second = customId('a'.repeat(300), new Set([first]))
    expect(second).toHaveLength(100)
    expect(second.endsWith('-2')).toBe(true)
    // A cut never leaves a hyphen before the suffix.
    const words = customId(`${'ab '.repeat(40)}`, NONE)
    expect(words).toMatch(/^custom:[a-z0-9]+(?:-[a-z0-9]+)*$/)
  })

  test.prop([fc.string({ maxLength: 160 }), fc.nat({ max: 4 })])(
    'is always a valid, unused custom id',
    (name, already) => {
      const taken = new Set<string>()
      for (let index = 0; index < already; index++) taken.add(customId(name, taken))
      const id = customId(name, taken)
      expect(IdSchema.safeParse(id).success).toBe(true)
      expect(id.startsWith('custom:')).toBe(true)
      expect(taken.has(id)).toBe(false)
    },
  )
})

describe('parseSourceLink', () => {
  it('reads MakerWorld model and profile ids and a name from the slug', () => {
    expect(
      parseSourceLink(
        ' https://makerworld.com/en/models/1945283-lenovo-tiny-mini-pc-mount-1u#profileId-2087424 ',
      ),
    ).toEqual({
      url: 'https://makerworld.com/en/models/1945283-lenovo-tiny-mini-pc-mount-1u#profileId-2087424',
      platform: 'makerworld',
      modelId: '1945283',
      profileId: '2087424',
      name: 'Lenovo tiny mini pc mount 1u',
    })
  })

  it('takes MakerWorld links without a language, a slug or a scheme', () => {
    expect(parseSourceLink('makerworld.com/models/2139130')).toEqual({
      url: 'https://makerworld.com/models/2139130',
      platform: 'makerworld',
      modelId: '2139130',
    })
    expect(parseSourceLink('https://makerworld.com/de/models/42-rack?profileId=77')).toMatchObject({
      modelId: '42',
      profileId: '77',
      name: 'Rack',
    })
    // A MakerWorld page that is not a model keeps its link only.
    expect(parseSourceLink('https://makerworld.com/en/@designer')).toEqual({
      url: 'https://makerworld.com/en/@designer',
      platform: 'makerworld',
    })
  })

  it('keeps Printables, Thingiverse and any other link as it is', () => {
    expect(parseSourceLink('https://www.printables.com/model/123456-mini-rack')).toEqual({
      url: 'https://www.printables.com/model/123456-mini-rack',
      platform: 'printables',
    })
    expect(parseSourceLink('https://www.thingiverse.com/thing:4815')).toEqual({
      url: 'https://www.thingiverse.com/thing:4815',
      platform: 'thingiverse',
    })
    expect(parseSourceLink('https://github.com/someone/rack')?.platform).toBe('github')
    expect(parseSourceLink('http://example.com/my rack')).toEqual({
      url: 'http://example.com/my%20rack',
      platform: 'other',
    })
  })

  it('refuses text that is not an http(s) web address', () => {
    for (const text of [
      '',
      '   ',
      'lenovo',
      'Lenovo tiny mount',
      'javascript:alert(1)',
      'ftp://example.com/file',
      'data:text/html,hello',
      `https://example.com/${'a'.repeat(2100)}`,
    ]) {
      expect(parseSourceLink(text)).toBeUndefined()
    }
  })
})

describe('newCustomDevice', () => {
  it('builds a valid device with an included power brick, unverified by you today', () => {
    const device = newCustomDevice(TINY, NONE)
    expectValidEntry(device)
    expect(DeviceSchema.parse(device)).toEqual(device)
    expect(device).toEqual({
      kind: 'device',
      id: 'custom:lenovo-thinkcentre-m720q-tiny',
      brand: 'Lenovo',
      model: 'ThinkCentre M720q Tiny',
      category: 'mini-pc',
      dims: { w: 179, d: 183, h: 34.5 },
      weightG: 1320,
      power: { input: { kind: 'dc', brick: { included: true } } },
      verified: { by: 'you', date: TODAY, method: 'unverified', note: UNVERIFIED_NOTE },
    })
  })

  it('maps every power choice onto device.power', () => {
    const power = (input: Partial<CustomDeviceInput>) =>
      newCustomDevice({ ...TINY, ...input }, NONE).power
    expect(power({ power: 'ac', typicalW: 4, maxW: 65 })).toEqual({
      typW: 4,
      maxW: 65,
      input: { kind: 'ac' },
    })
    expect(power({ power: 'usb-c' })).toEqual({ input: { kind: 'usb-c-pd' } })
    expect(power({ power: 'poe', maxW: 12 })).toEqual({ maxW: 12, input: { kind: 'poe' } })
    expect(power({ power: 'dc' })).toEqual({ input: { kind: 'dc' } })
    expect(power({ power: 'none', typicalW: 3 })).toEqual({ input: { kind: 'none' } })
    expect(power({ power: 'brick', brickPlugsIntoWall: true, typicalW: 10 })).toEqual({
      typW: 10,
      input: { kind: 'dc', brick: { included: true, plug: 'wall' } },
    })
    expect(power({ power: undefined, typicalW: 10 })).toBeUndefined()
  })

  it('places ear-mounted gear by its own height and keeps the link', () => {
    const pdu = newCustomDevice(
      {
        brand: 'DeskPi',
        model: 'PDU',
        category: 'pdu',
        widthMm: 250,
        depthMm: 64,
        heightMm: 21,
        power: 'dc',
        rackmountSixths: 3,
        sourceUrl: 'deskpi.com/products/pdu',
        verifiedMethod: 'vendor-spec',
        today: TODAY,
      },
      NONE,
    )
    expectValidEntry(pdu)
    expect(pdu.rackmount).toEqual({ heightSixths: 3, face: 'front', depthMm: 64 })
    expect(pdu.source).toEqual({ platform: 'vendor', url: 'https://deskpi.com/products/pdu' })
    // Checked facts need no "not checked" note.
    expect(pdu.verified).toEqual({ by: 'you', date: TODAY, method: 'vendor-spec' })
  })

  it('reports what is wrong instead of returning an invalid device', () => {
    const error = thrown(() => newCustomDevice({ ...TINY, widthMm: 0 }, NONE))
    expect(error.problems.some((problem) => problem.startsWith('dims.w:'))).toBe(true)
    const link = thrown(() => newCustomDevice({ ...TINY, sourceUrl: 'not a link' }, NONE))
    expect(link.problems).toEqual(['source.url: "not a link" is not an http(s) link'])
    expect(() => newCustomDevice({ ...TINY, rackmountSixths: 0 }, NONE)).toThrow(CustomPartError)
  })
})

describe('newCustomItem', () => {
  it('builds a mount with a fixed slot sized as typed, centred in the opening', () => {
    const item = newCustomItem(MOUNT, new Set(['custom:tiny-mount-1u']))
    expectValidEntry(item)
    expect(ItemSchema.parse(item)).toEqual(item)
    expect(item.id).toBe('custom:tiny-mount-1u-2')
    expect(item).toMatchObject({
      kind: 'item',
      category: 'mount',
      heightSixths: 6,
      faces: ['front'],
      bay: 'full',
      depthMm: 190,
      mount: { front: 4, rear: 0 },
      render: { style: 'tray' },
      source: {
        platform: 'makerworld',
        url: 'https://makerworld.com/en/models/1945283-tiny-mount#profileId-2087424',
        modelId: '1945283',
        profileId: '2087424',
        designer: 'Tim',
        license: 'BY-SA',
      },
    })
    // (222.25 − 180) / 2 = 21.125 mm from the left; the floor 3 mm up (1U leaves 3.45 mm).
    expect(item.slots).toEqual([
      {
        id: 'device',
        label: 'Device',
        kind: 'fixed',
        maxW: 180,
        maxD: 184,
        maxH: 36,
        orientations: ['flat', 'flat-rotated'],
        accepts: { categories: ['mini-pc'] },
        layout: { xMm: 21.13, yMm: 3, zMm: 0 },
      },
    ])
    const device = newCustomDevice(TINY, NONE)
    const [slot] = item.slots
    if (slot === undefined) throw new Error('No slot')
    expect(fitDeviceInSlot(device, slot)).toEqual({ ok: true, orientation: 'flat' })
  })

  it('turns print and hardware rows into print groups and per-item recipe lines', () => {
    const item = newCustomItem(MOUNT, NONE)
    expect(item.prints).toEqual([
      {
        id: 'mount',
        plate: 'Mount',
        label: 'Mount',
        material: 'PETG',
        gramsPerPrint: 85,
        minutesPerPrint: 150,
      },
      { id: 'mount-2', plate: 'Mount', label: 'Mount' },
    ])
    expect(item.recipe).toEqual([
      { id: 'mount', unit: 'item', ref: { print: 'mount' }, count: 1, role: 'assembly' },
      { id: 'mount-2', unit: 'item', ref: { print: 'mount-2' }, count: 2, role: 'assembly' },
      // The same screw twice becomes one line of 6.
      {
        id: 'screw-m3x8-shcs',
        unit: 'item',
        ref: { hardware: 'screw-m3x8-shcs' },
        count: 6,
        role: 'assembly',
      },
      {
        id: 'insert-m3x5x4',
        unit: 'item',
        ref: { hardware: 'insert-m3x5x4' },
        count: 4,
        role: 'assembly',
      },
    ])
  })

  it('builds panels that hold nothing and shelves with an area', () => {
    const panel = newCustomItem(
      {
        name: 'Half-U blank',
        category: 'panel',
        heightSixths: 3,
        depthMm: 8,
        faces: ['rear', 'front', 'rear'],
        holds: { kind: 'nothing' },
        today: TODAY,
      },
      NONE,
    )
    expectValidEntry(panel)
    expect(panel).toMatchObject({
      heightSixths: 3,
      faces: ['front', 'rear'],
      mount: { front: 2, rear: 0 },
      slots: [],
      prints: [],
      recipe: [],
      render: { style: 'blank' },
    })
    expect(panel.source).toBeUndefined()

    const shelf = newCustomItem(
      {
        name: 'Shelf 2U',
        category: 'shelf',
        heightSixths: 12,
        depthMm: 200,
        holds: { kind: 'shelf', maxW: 210, maxD: 195 },
        today: TODAY,
      },
      NONE,
    )
    expectValidEntry(shelf)
    expect(shelf.render).toEqual({ style: 'shelf' })
    expect(shelf.slots).toEqual([
      {
        id: 'shelf',
        label: 'Shelf',
        kind: 'area',
        maxW: 210,
        maxD: 195,
        orientations: ['flat', 'flat-rotated'],
        layout: { xMm: 6.13, yMm: 3, zMm: 0 },
      },
    ])
  })

  it('places on the rack like any catalog mount', () => {
    const item = newCustomItem(MOUNT, NONE)
    const plan = embedCustomEntries(kwsPlan({ sections: [3] }), [item])
    const at = { itemId: item.id, y: 6, face: 'front' as const, bay: 'full' as const }
    expect(canPlace(plan, kwsCatalog(), KWS_FRAME, at)).toEqual({ ok: true, reasons: [] })
  })

  it('reports an unknown device category or a missing height', () => {
    const category = thrown(() =>
      newCustomItem(
        { ...MOUNT, holds: { kind: 'device', maxW: 100, maxD: 100, maxH: 30, categories: ['pc'] } },
        NONE,
      ),
    )
    expect(category.problems).toEqual(['slots.0.accepts.categories: "pc" is not a device category'])
    const height = thrown(() => newCustomItem({ ...MOUNT, heightSixths: 0 }, NONE))
    expect(height.problems).toContain('an item needs a height (use kind "extra" for accessories)')
  })
})

describe('newCustomFrame', () => {
  it('builds a one-piece frame with EIA rails and screws for its thread', () => {
    const frame = newCustomFrame(RACK, NONE)
    expectValidEntry(frame)
    expect(FrameSchema.parse(frame)).toEqual(frame)
    expect(frame).toEqual({
      kind: 'frame',
      id: 'custom:deskpi-rackmate-t1',
      name: 'DeskPi RackMate T1',
      verified: { by: 'you', date: TODAY, method: 'unverified', note: UNVERIFIED_NOTE },
      standard: { panelWidthMm: 254, innerWidthMm: 220, depthMm: 300, rearOpen: true },
      rail: { earSpacingMm: 236.525, holeOffsetsPerUMm: [6.35, 22.225, 38.1], holeTolMm: 1 },
      equipmentFastener: {
        thread: 'M6',
        perHole: 'screw+cage-nut',
        screwIds: [
          'screw-m6x8-shcs',
          'screw-m6x10-shcs',
          'screw-m6x12-shcs',
          'screw-m6x16-shcs',
          'screw-m6x20-shcs',
        ],
        engagementMm: 8,
        nutId: 'cage-nut-m6',
      },
      sectionTypes: [{ id: 'rack', label: 'Whole rack', heightU: 8 }],
      stack: { minU: 8, maxU: 8 },
      options: [],
      prints: [],
      recipe: [],
    })
  })

  it('picks nuts per hole and leaves out what the catalog does not have', () => {
    expect(customFrameFastener('10-32', 'screw')).toEqual({
      thread: '10-32',
      perHole: 'screw',
      screwIds: ['screw-10-32x5-16in', 'screw-10-32x1-2in'],
      engagementMm: 6,
    })
    expect(customFrameFastener('M5', 'screw+nut')).toMatchObject({
      nutId: 'nut-m5-hex',
      engagementMm: 10,
    })
    expect(customFrameFastener('M5', 'screw+cage-nut').nutId).toBeUndefined()
    expect(customFrameFastener('12-24', 'screw').screwIds).toEqual([])
    const frame = newCustomFrame({ ...RACK, thread: '12-24', perHole: 'screw' }, NONE)
    expectValidEntry(frame)
  })
})

describe('customMountForDevice', () => {
  const device = newCustomDevice(TINY, NONE)

  it('sizes one fixed slot 2 mm larger than the device and reaches 10 mm deeper', () => {
    const mount = customMountForDevice(device, { heightSixths: 6, today: TODAY }, NONE)
    expectValidEntry(mount)
    expect(mount).toMatchObject({
      id: 'custom:lenovo-thinkcentre-m720q-tiny-mount',
      name: 'Lenovo ThinkCentre M720q Tiny mount',
      category: 'mount',
      heightSixths: 6,
      depthMm: 193,
      mount: { front: 4, rear: 0 },
      render: { style: 'device' },
      verified: { by: 'you', date: TODAY, method: 'unverified' },
    })
    expect(mount.slots).toEqual([
      {
        id: 'device',
        label: 'Lenovo ThinkCentre M720q Tiny',
        kind: 'fixed',
        maxW: 181,
        maxD: 185,
        maxH: 36.5,
        orientations: ['flat'],
        accepts: { categories: ['mini-pc'] },
        layout: { xMm: 20.63, yMm: 2.95, zMm: 0 },
      },
    ])
  })

  it('holds its device within its own height', () => {
    const mount = customMountForDevice(device, { heightSixths: 6, name: ' Tiny cradle ' }, NONE)
    expect(mount.name).toBe('Tiny cradle')
    const plan = embedCustomEntries(kwsPlan({ sections: [3] }), [mount, device])
    const placement = {
      id: 'pl-1',
      itemId: mount.id,
      y: 0,
      face: 'front' as const,
      bay: 'full' as const,
      devices: [{ id: 'dv-1', deviceId: device.id, slotId: 'device', have: false }],
    }
    const box = occupiedBox(plan, kwsCatalog(), placement, KWS_FRAME)
    expect([box.y0, box.y1]).toEqual([0, 6])
  })
})

describe('embedCustomEntries', () => {
  const device = newCustomDevice(TINY, NONE)
  const item = newCustomItem(MOUNT, NONE)
  const frame = newCustomFrame(RACK, NONE)

  it('adds entries to their lists and keeps the plan valid', () => {
    const plan = kwsPlan()
    const embedded = embedCustomEntries(plan, [device, item, frame])
    expect(embedded.custom.devices).toEqual([device])
    expect(embedded.custom.items).toEqual([item])
    expect(embedded.custom.frames).toEqual([frame])
    expect(PlanSchema.parse(embedded)).toEqual(embedded)
    expect(plan.custom.devices).toEqual([])
  })

  it('is idempotent and replaces an entry with the same id', () => {
    const once = embedCustomEntries(kwsPlan(), [device, item])
    const twice = embedCustomEntries(once, [device, item])
    expect(twice).toBe(once)
    const renamed = { ...device, model: 'M720q' }
    const replaced = embedCustomEntries(once, [renamed])
    expect(replaced.custom.devices).toEqual([renamed])
    expect(replaced.custom.items).toBe(once.custom.items)
  })

  it('skips shared catalog ids and keeps one entry per id across kinds', () => {
    const plan = kwsPlan()
    const shared = { ...device, id: 'lenovo-thinkcentre-m720q-tiny' }
    expect(embedCustomEntries(plan, [shared])).toBe(plan)
    const once = embedCustomEntries(plan, [device])
    const asItem: Item = { ...item, id: device.id }
    const moved = embedCustomEntries(once, [asItem])
    expect(moved.custom.devices).toEqual([])
    expect(moved.custom.items).toEqual([asItem])
  })
})

describe('customIdsUsed', () => {
  const screw: Hardware = HardwareSchema.parse({
    kind: 'hardware',
    id: 'custom:my-screw',
    name: 'My screw',
    category: 'screw',
    spec: { thread: 'M6', lengthMm: 12 },
  })
  const nut: Hardware = HardwareSchema.parse({
    kind: 'hardware',
    id: 'custom:my-nut',
    name: 'My nut',
    category: 'cage-nut',
  })
  const item = newCustomItem(
    { ...MOUNT, hardware: [{ hardwareId: 'custom:my-screw', count: 2 }] },
    NONE,
  )

  function planUsing(): Plan {
    return kwsPlan({
      sections: [6],
      placements: [
        {
          id: 'pl-1',
          itemId: item.id,
          y: 0,
          devices: [{ id: 'dv-1', deviceId: 'custom:pc', slotId: 'device', have: false }],
        },
        {
          id: 'pl-2',
          itemId: 'kws-blank-1u',
          y: 6,
          have: { at: '2026-10-11T09:30:00.000Z', itemId: 'custom:old-blank', options: {} },
        },
      ],
      equipment: [
        { id: 'eq-1', deviceId: 'custom:switch', have: false },
        { id: 'eq-2', deviceId: 'tp-link-tl-sg108e', have: true },
      ],
      extras: [{ id: 'ex-1', itemId: 'custom:feet', qty: 4, haveQty: 0 }],
      retired: [
        {
          id: 'rt-1',
          kind: 'placement',
          snapshot: { at: '2026-10-11T09:30:00.000Z', itemId: 'custom:retired-shelf' },
          devices: ['custom:nas'],
        },
      ],
      custom: { frames: [], items: [item], devices: [], hardware: [screw] },
    })
  }

  it('finds the custom ids of placements, devices, equipment, extras and retired parts', () => {
    expect([...customIdsUsed(planUsing())].toSorted()).toEqual([
      'custom:feet',
      'custom:my-screw',
      'custom:nas',
      'custom:old-blank',
      'custom:pc',
      'custom:retired-shelf',
      'custom:switch',
      'custom:tiny-mount-1u',
    ])
  })

  it('finds a custom frame and the custom hardware it needs', () => {
    const frame = {
      ...newCustomFrame(RACK, NONE),
      equipmentFastener: {
        ...customFrameFastener('M6', 'screw+cage-nut'),
        screwIds: ['custom:my-screw'],
        nutId: 'custom:my-nut',
      },
    }
    expect(customRefsOf(frame)).toEqual(['custom:my-screw', 'custom:my-nut'])
    const plan = {
      ...kwsPlan(),
      frame: { ...kwsPlan().frame, frameId: frame.id },
      custom: { frames: [frame], items: [], devices: [], hardware: [screw, nut] },
    }
    expect([...customIdsUsed(plan)].toSorted()).toEqual([
      'custom:deskpi-rackmate-t1',
      'custom:my-nut',
      'custom:my-screw',
    ])
  })

  it('embeds what the plan uses from the library, without replacing its own copies', () => {
    const device = { ...newCustomDevice(TINY, NONE), id: 'custom:pc' }
    const switch8 = {
      ...newCustomDevice({ ...TINY, model: 'Switch', category: 'switch' }, NONE),
      id: 'custom:switch',
    }
    const newer = { ...item, name: 'Renamed in the library' }
    const unused = { ...device, id: 'custom:unused' }
    const plan = planUsing()
    const embedded = embedUsedCustomEntries(plan, [newer, device, switch8, unused, nut])
    expect(embedded.custom.items).toEqual([item])
    expect(embedded.custom.devices).toEqual([device, switch8])
    expect(embedded.custom.hardware).toEqual([screw])
    expect(embedUsedCustomEntries(embedded, [device, switch8])).toBe(embedded)
  })
})

describe('editing', () => {
  it('round-trips the plain-language inputs without changes', () => {
    const device = newCustomDevice(
      {
        ...TINY,
        power: 'brick',
        brickPlugsIntoWall: true,
        typicalW: 9,
        rackmountSixths: 6,
        sourceUrl: 'https://psref.lenovo.com/Product/ThinkCentre_M720q',
      },
      NONE,
    )
    expect(editCustomDevice(device, { ...customDeviceInputOf(device), today: TODAY })).toEqual(
      device,
    )
    const item = newCustomItem(MOUNT, NONE)
    expect(customItemInputOf(item)).toMatchObject({
      prints: [
        { id: 'mount', plate: 'Mount', count: 1, gramsPerPrint: 85 },
        { id: 'mount-2', plate: 'Mount', count: 2 },
      ],
      hardware: [
        { hardwareId: 'screw-m3x8-shcs', count: 6 },
        { hardwareId: 'insert-m3x5x4', count: 4 },
      ],
      designer: 'Tim',
    })
    expect(editCustomItem(item, { ...customItemInputOf(item), today: TODAY })).toEqual(item)
    const frame = newCustomFrame(RACK, NONE)
    expect(editCustomFrame(frame, { ...customFrameInputOf(frame), today: TODAY })).toEqual(frame)
    for (const entry of [device, item, frame]) expect(customAdvancedDetails(entry)).toEqual([])
  })

  it('keeps the id and the device details the form does not show', () => {
    const device = DeviceSchema.parse({
      ...newCustomDevice({ ...TINY, power: 'ac', category: 'pdu' }, NONE),
      power: { input: { kind: 'ac', connector: 'C14' }, outputs: [{ kind: 'ac', count: 4 }] },
    })
    expect(customAdvancedDetails(device)).toEqual([
      'the outlets or ports it provides',
      'its power connector',
    ])
    const edited = editCustomDevice(device, {
      ...customDeviceInputOf(device),
      model: 'PDU 4',
      typicalW: 2,
      today: '2026-10-12',
    })
    expect(edited.id).toBe(device.id)
    expect(edited.model).toBe('PDU 4')
    expect(edited.power).toEqual({
      typW: 2,
      input: { kind: 'ac', connector: 'C14' },
      outputs: [{ kind: 'ac', count: 4 }],
    })
    expect(edited.verified.date).toBe('2026-10-12')
    // Another power choice: the outlets it provides stay.
    const dc = editCustomDevice(device, { ...customDeviceInputOf(device), power: 'dc' })
    expect(dc.power).toEqual({ input: { kind: 'dc' }, outputs: [{ kind: 'ac', count: 4 }] })
  })

  it('keeps options, hidden prints, conditional lines, slot and print ids of an item', () => {
    const base = newCustomItem(MOUNT, NONE)
    const item = ItemSchema.parse({
      ...base,
      options: [
        { id: 'magnets', label: 'Magnets', scope: 'item', kind: 'boolean', default: false },
      ],
      prints: [...base.prints, { id: 'lid', plate: 'Lid', label: 'Lid' }],
      recipe: [
        ...base.recipe,
        {
          id: 'lid',
          unit: 'item',
          ref: { print: 'lid' },
          count: 1,
          when: { option: { magnets: true } },
        },
        {
          id: 'magnet',
          unit: 'item',
          ref: { hardware: 'magnet-6x2' },
          count: 4,
          role: 'embedded',
        },
      ],
      mount: { ...base.mount, holeOffsetsMm: [6.35, 38.1] },
    })
    expect(checkEntryIntegrity(item)).toEqual([])
    expect(customAdvancedDetails(item)).toEqual([
      '1 option',
      'ear hole positions',
      '2 conditional print or hardware lines',
    ])
    const input = customItemInputOf(item)
    // The form shows the plain rows only.
    expect(input.prints?.map((row) => row.id)).toEqual(['mount', 'mount-2'])
    const edited = editCustomItem(item, {
      ...input,
      name: 'Tiny mount 1U v2',
      prints: [{ id: 'mount', plate: 'Mount v2', count: 1, gramsPerPrint: 90 }],
      holds: { kind: 'device', maxW: 182, maxD: 184, maxH: 36, categories: ['mini-pc'] },
    })
    expect(edited.id).toBe(item.id)
    expect(edited.options).toEqual(item.options)
    expect(edited.prints).toEqual([
      // The material and times not typed any more are gone; the old label follows the plate.
      { id: 'mount', plate: 'Mount v2', label: 'Mount v2', gramsPerPrint: 90 },
      { id: 'lid', plate: 'Lid', label: 'Lid' },
    ])
    expect(edited.recipe.map((line) => line.id)).toEqual([
      'mount',
      'screw-m3x8-shcs',
      'insert-m3x5x4',
      'lid',
      'magnet',
    ])
    expect(edited.slots[0]).toMatchObject({ id: 'device', maxW: 182, layout: { xMm: 20.13 } })
    // Same height: the ear hole positions stay.
    expect(edited.mount.holeOffsetsMm).toEqual([6.35, 38.1])
    const taller = editCustomItem(item, { ...input, heightSixths: 12 })
    expect(taller.mount).toEqual({ front: 4, rear: 0 })
  })

  it('keeps a multi-section frame’s sections, rails and recipe', () => {
    const kws = { ...KWS_FRAME, id: 'custom:my-kws' }
    expect(customAdvancedDetails(kws)).toContain('its section types and stack height')
    const input = customFrameInputOf(kws)
    expect(input.heightU).toBe(KWS_FRAME.stack.maxU)
    const edited = editCustomFrame(kws, { ...input, depthMm: 320, heightU: 9 })
    expect(edited.standard.depthMm).toBe(320)
    expect(edited.sectionTypes).toEqual(KWS_FRAME.sectionTypes)
    expect(edited.stack).toEqual(KWS_FRAME.stack)
    expect(edited.recipe).toEqual(KWS_FRAME.recipe)
    expect(edited.equipmentFastener).toEqual(KWS_FRAME.equipmentFastener)
    expect(edited.source).toEqual(KWS_FRAME.source)
  })
})

describe('duplicateCustomEntry', () => {
  it('copies under a new id with "(copy)" in the name', () => {
    const item = newCustomItem(MOUNT, NONE)
    const copy = duplicateCustomEntry(item, new Set([item.id]))
    expect(copy).toMatchObject({ id: 'custom:tiny-mount-1u-copy', name: 'Tiny mount 1U (copy)' })
    const device = newCustomDevice(TINY, NONE)
    expect(duplicateCustomEntry(device, new Set([device.id]))).toMatchObject({
      id: 'custom:lenovo-thinkcentre-m720q-tiny-copy',
      model: 'ThinkCentre M720q Tiny (copy)',
    })
  })
})
