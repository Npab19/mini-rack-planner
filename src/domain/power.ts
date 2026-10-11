/**
 * Power budget of the planned rack: AC outlets, PoE ports and budget, USB-C PD ports and watts.
 *
 * Every device the plan uses counts (in mount slots, rack-mounted directly or still in the
 * equipment tray). A device draws from:
 * - its power brick when it has one: one AC outlet, two for a wall-plug brick (it blocks the
 *   neighbouring outlet); USB-C chargers are bricks of USB-C PD devices;
 * - else an AC outlet for an internal PSU (`input.kind: 'ac'`), except for gear that hands out
 *   AC itself (PDUs, UPSs, strips): it plugs into the wall, not into its own outlets;
 * - else a PoE port (`poe`) or a USB-C PD port (`usb-c-pd`).
 * Available outlets and ports are the `outputs` of the devices in the plan.
 */
import type { PowerSummary } from './api'
import { resolvePlacedEntry } from './bom'
import { withCustomEntries, type CatalogLookup, type Device } from './schema/catalog'
import type { Plan } from './schema/plan'

/** One device instance of the plan. */
export interface PlannedDevice {
  /** Placed device id, placement id (ear-mounted gear placed directly) or equipment id. */
  instanceId: string
  device: Device
  /** The placement it sits in or is, if any. */
  placementId?: string
}

/** Known devices the plan uses, in plan order; unknown ids are left to the checks. */
export function plannedDevices(plan: Plan, catalog: CatalogLookup): PlannedDevice[] {
  const lookup = withCustomEntries(catalog, plan.custom)
  const devices: PlannedDevice[] = []
  for (const placement of plan.placements) {
    const entry = resolvePlacedEntry(lookup, placement.itemId)
    if (entry.kind === 'device') {
      devices.push({ instanceId: placement.id, device: entry.device, placementId: placement.id })
    }
    for (const placed of placement.devices) {
      const device = lookup.device(placed.deviceId)
      if (device) devices.push({ instanceId: placed.id, device, placementId: placement.id })
    }
  }
  for (const entry of plan.equipment) {
    const device = lookup.device(entry.deviceId)
    if (device) devices.push({ instanceId: entry.id, device })
  }
  return devices
}

export interface PowerReport extends PowerSummary {
  /** AC outlets that stay powered on battery (UPS outputs marked `batteryBacked`). */
  acOutletsBatteryBacked: number
}

function emptyReport(): PowerReport {
  return {
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
  }
}

function addSupply(report: PowerReport, device: Device): void {
  for (const output of device.power?.outputs ?? []) {
    switch (output.kind) {
      case 'ac':
        report.acOutletsAvailable += output.count
        if (output.batteryBacked === true) report.acOutletsBatteryBacked += output.count
        break
      case 'poe':
        report.poePortsAvailable += output.count
        report.poeBudgetW += output.budgetW ?? (output.maxWEach ?? 0) * output.count
        break
      case 'usb-c':
        report.usbcPortsAvailable += output.count
        break
      case 'dc':
        break
    }
  }
}

function addDemand(report: PowerReport, planned: PlannedDevice): void {
  const power = planned.device.power
  if (power === undefined) return
  const { input } = power
  if (input.brick !== undefined) {
    report.acOutletsNeeded += input.brick.plug === 'wall' ? 2 : 1
    report.bricks.push({
      deviceId: planned.device.id,
      ...(planned.placementId === undefined ? {} : { placementId: planned.placementId }),
    })
    return
  }
  switch (input.kind) {
    case 'ac': {
      const handsOutAc = (power.outputs ?? []).some((output) => output.kind === 'ac')
      if (!handsOutAc) report.acOutletsNeeded += 1
      return
    }
    case 'usb-c-pd':
      report.usbcPortsNeeded += 1
      return
    case 'poe':
      report.poePortsNeeded += 1
      report.poeDemandW += power.maxW ?? power.typW ?? 0
      return
    case 'dc':
    case 'none':
      return
  }
}

/** Outlets, ports and watts the plan needs against what its own power gear provides. */
export function powerSummary(plan: Plan, catalog: CatalogLookup): PowerReport {
  const report = emptyReport()
  for (const planned of plannedDevices(plan, catalog)) {
    const power = planned.device.power
    if (power === undefined) continue
    report.totalTypW += power.typW ?? 0
    report.totalMaxW += power.maxW ?? power.typW ?? 0
    addSupply(report, planned.device)
    addDemand(report, planned)
  }
  return report
}
