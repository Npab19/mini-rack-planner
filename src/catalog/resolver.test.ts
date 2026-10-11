import { describe, expect, it } from 'vitest'
import {
  DeviceSchema,
  HardwareSchema,
  ItemSchema,
  type CustomEntries,
} from '../domain/schema/catalog'
import { RAW_DEVICE, RAW_MOUNT, testEntries } from './__fixtures__/entries'
import { createLookup, groupCustomEntries, isCustomId, mergeLookups } from './resolver'

const base = createLookup(testEntries())

const custom = (overrides: Partial<CustomEntries>): CustomEntries => ({
  frames: [],
  items: [],
  devices: [],
  hardware: [],
  ...overrides,
})
const customDevice = (id: string, model: string) => DeviceSchema.parse({ ...RAW_DEVICE, id, model })

describe('createLookup', () => {
  it('finds entries by kind and returns undefined for unknown ids', () => {
    expect(base.frame('test-frame')?.id).toBe('test-frame')
    expect(base.item('lenovo-tiny-mount')?.name).toBe('Lenovo Tiny mount 1U')
    expect(base.device('lenovo-m720q')?.model).toBe('ThinkCentre M720q Tiny')
    expect(base.hardware('nut-m6-hex')?.category).toBe('nut')
    expect(base.item('lenovo-m720q')).toBeUndefined()
    expect(base.frame('nope')).toBeUndefined()
  })
})

describe('isCustomId', () => {
  it('recognises private ids', () => {
    expect(isCustomId('custom:my-shelf')).toBe(true)
    expect(isCustomId('generic-shelf-1u')).toBe(false)
  })
})

describe('mergeLookups', () => {
  it('returns the base lookup unchanged when there is nothing to add', () => {
    expect(mergeLookups(base)).toBe(base)
    expect(mergeLookups(base, custom({}), custom({}))).toBe(base)
  })

  it('adds the library and the plan entries; the plan wins on equal ids', () => {
    const library = custom({
      devices: [customDevice('custom:nas', 'Library NAS'), customDevice('custom:pc', 'Library PC')],
    })
    const plan = custom({ devices: [customDevice('custom:nas', 'Plan NAS')] })
    const lookup = mergeLookups(base, plan, library)
    expect(lookup.device('custom:nas')?.model).toBe('Plan NAS')
    expect(lookup.device('custom:pc')?.model).toBe('Library PC')
    expect(lookup.device('lenovo-m720q')).toBe(base.device('lenovo-m720q'))
    expect(lookup.allDevices().map((device) => device.id)).toEqual([
      'custom:nas',
      'custom:pc',
      'lenovo-m720q',
    ])
  })

  it('never lets private entries shadow curated ones', () => {
    const shadow = ItemSchema.parse({ ...RAW_MOUNT, name: 'Hijacked mount' })
    const lookup = mergeLookups(base, custom({ items: [shadow] }), custom({ items: [shadow] }))
    expect(lookup.item('lenovo-tiny-mount')?.name).toBe('Lenovo Tiny mount 1U')
    expect(lookup.allItems()).toHaveLength(base.allItems().length)
  })

  it('accepts partial custom sets, as older documents may have them', () => {
    const screw = HardwareSchema.parse({
      kind: 'hardware',
      id: 'custom:odd-screw',
      name: 'Odd screw',
      category: 'screw',
    })
    expect(mergeLookups(base, { hardware: [screw] }).hardware('custom:odd-screw')).toBe(screw)
  })
})

describe('groupCustomEntries', () => {
  it('groups a flat list by kind, items and extras together', () => {
    const extra = ItemSchema.parse({
      ...RAW_MOUNT,
      kind: 'extra',
      id: 'custom:feet',
      heightSixths: 0,
      mount: undefined,
    })
    const grouped = groupCustomEntries([customDevice('custom:pc', 'PC'), extra])
    expect(grouped.devices.map((device) => device.id)).toEqual(['custom:pc'])
    expect(grouped.items.map((item) => item.id)).toEqual(['custom:feet'])
    expect(grouped.frames).toEqual([])
    expect(grouped.hardware).toEqual([])
  })
})
