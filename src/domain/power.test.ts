import { describe, expect, it } from 'vitest'
import { plannedDevices, powerSummary } from './power'
import { DeviceSchema } from './schema/catalog'
import { kwsCatalog, kwsPlan, parseEntries } from './__fixtures__/kws'

const CATALOG = kwsCatalog()
const VERIFIED = { by: 'test', date: '2026-10-11', method: 'unverified' }

describe('powerSummary', () => {
  const plan = kwsPlan({
    sections: [6],
    placements: [
      { id: 'pl-pdu', itemId: 'pdu-4', y: 0 },
      {
        id: 'pl-pc',
        itemId: 'lenovo-tiny-mount',
        y: 6,
        devices: [{ id: 'dv-1', deviceId: 'lenovo-m720q', slotId: 'bay' }],
      },
      {
        id: 'pl-pc2',
        itemId: 'lenovo-tiny-mount',
        y: 12,
        devices: [{ id: 'dv-2', deviceId: 'lenovo-m720q', slotId: 'bay' }],
      },
    ],
    equipment: [
      { id: 'eq-nas', deviceId: 'nas-2bay' },
      { id: 'eq-pi', deviceId: 'rpi-5' },
      { id: 'eq-board', deviceId: 'pi-zero-usb' },
      { id: 'eq-charger', deviceId: 'usb-c-charger' },
      { id: 'eq-switch', deviceId: 'poe-switch-8' },
      { id: 'eq-cam-1', deviceId: 'poe-camera' },
      { id: 'eq-cam-2', deviceId: 'poe-camera' },
      { id: 'eq-unknown', deviceId: 'mystery-box' },
    ],
  })
  const summary = powerSummary(plan, CATALOG)

  it('counts AC outlets: bricks (wall plugs take 2), internal PSUs and chargers', () => {
    // 2 Tiny bricks (C5) + NAS wall brick (2) + Pi wall charger (2) + USB-C charger + PoE switch.
    expect(summary.acOutletsNeeded).toBe(2 + 2 + 2 + 1 + 1)
    // The PDU plugs into the wall, not into itself.
    expect(summary.acOutletsAvailable).toBe(4)
    expect(summary.acOutletsBatteryBacked).toBe(0)
  })

  it('counts PoE ports, budget and demand', () => {
    expect(summary).toMatchObject({
      poePortsNeeded: 2,
      poePortsAvailable: 4,
      poeBudgetW: 60,
      poeDemandW: 14,
    })
  })

  it('counts USB-C PD ports for devices without their own charger', () => {
    expect(summary).toMatchObject({ usbcPortsNeeded: 1, usbcPortsAvailable: 4 })
  })

  it('totals typical and maximum watts', () => {
    expect(summary.totalTypW).toBe(2 * 15 + 18 + 5 + 2 + 8 + 2 * 4)
    expect(summary.totalMaxW).toBe(2 * 65 + 40 + 27 + 5 + 75 + 2 * 7)
  })

  it('lists the power bricks the plan implies', () => {
    expect(summary.bricks).toEqual([
      { deviceId: 'lenovo-m720q', placementId: 'pl-pc' },
      { deviceId: 'lenovo-m720q', placementId: 'pl-pc2' },
      { deviceId: 'nas-2bay' },
      { deviceId: 'rpi-5' },
    ])
  })

  it('counts battery-backed UPS outlets', () => {
    const ups = parseEntries([
      {
        kind: 'device',
        id: 'custom:ups',
        brand: 'Fixture',
        model: 'UPS',
        category: 'ups',
        dims: { w: 200, d: 250, h: 90 },
        verified: VERIFIED,
        power: {
          typW: 5,
          input: { kind: 'ac' },
          outputs: [
            { kind: 'ac', count: 4, batteryBacked: true },
            { kind: 'ac', count: 2 },
          ],
        },
      },
    ])
    const withUps = kwsPlan({
      sections: [6],
      equipment: [{ id: 'eq-ups', deviceId: 'custom:ups' }],
    })
    expect(powerSummary(withUps, kwsCatalog(ups))).toMatchObject({
      acOutletsAvailable: 6,
      acOutletsBatteryBacked: 4,
      acOutletsNeeded: 0,
    })
  })

  it('resolves the plan’s own custom devices and ignores unknown ones', () => {
    const custom = DeviceSchema.parse({
      kind: 'device',
      id: 'custom:box',
      brand: 'Me',
      model: 'Box',
      category: 'other',
      dims: { w: 100, d: 100, h: 40 },
      verified: VERIFIED,
      power: { typW: 10, maxW: 20, input: { kind: 'ac' } },
    })
    const own = kwsPlan({
      sections: [6],
      equipment: [
        { id: 'eq-1', deviceId: 'custom:box' },
        { id: 'eq-2', deviceId: 'mystery-box' },
      ],
      custom: { devices: [custom] },
    })
    expect(plannedDevices(own, CATALOG).map((entry) => entry.device.id)).toEqual(['custom:box'])
    expect(powerSummary(own, CATALOG)).toMatchObject({ acOutletsNeeded: 1, totalMaxW: 20 })
  })

  it('is all zeros for an empty plan', () => {
    expect(powerSummary(kwsPlan(), CATALOG)).toEqual({
      acOutletsNeeded: 0,
      acOutletsAvailable: 0,
      acOutletsBatteryBacked: 0,
      poePortsNeeded: 0,
      poePortsAvailable: 0,
      poeBudgetW: 0,
      poeDemandW: 0,
      usbcPortsNeeded: 0,
      usbcPortsAvailable: 0,
      totalTypW: 0,
      totalMaxW: 0,
      bricks: [],
    })
  })
})
