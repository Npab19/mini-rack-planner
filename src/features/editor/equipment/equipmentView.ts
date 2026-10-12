/**
 * What the "Equipment to fit" tray says, as plain functions: the rack-space summary ("Needs ~10U ·
 * rack 9U, 2U free → add 3U"), how much space each device needs and why, its size, how far the
 * rack can grow, and what "Fit it for me" did.
 */
import { HAVE_TEXT } from '@/components/common/HaveNeed'
import type { DeviceUEstimate, EquipmentUSummary } from '@/domain/devices'
import type { FitItForMeResult } from '@/domain/fit'
import type { StackEnd } from '@/domain/frame'
import { formatU, sixthsToU, uToSixths } from '@/domain/geometry'
import { deviceName, type CatalogLookup, type Device, type Frame } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'

/** "Needs ~10U · rack 9U, 2U free → add 3U"; "Rack 9U · 7U used, 2U free" with an empty tray. */
export function summaryText(summary: EquipmentUSummary, trayEmpty: boolean): string {
  const rack = formatU(summary.rackSixths)
  const free = formatU(summary.freeSixths)
  if (trayEmpty) return `Rack ${rack} · ${formatU(summary.usedSixths)} used, ${free} free`
  const needs = `Needs ~${formatU(summary.usedSixths + summary.neededSixths)}`
  const base = `${needs} · rack ${rack}, ${free} free`
  return summary.shortfallSixths > 0
    ? `${base} → add ${formatU(summary.shortfallSixths)}`
    : `${base} · it fits`
}

/** "The equipment waiting here needs ~3U." */
export function trayNeedText(summary: EquipmentUSummary): string | undefined {
  if (summary.neededSixths <= 0) return undefined
  return `The equipment waiting here needs ~${formatU(summary.neededSixths)}.`
}

/** "~1U on Lenovo Tiny mount", "1U, mounts directly with its own ears", "~4U, estimated from its height". */
export function estimateText(estimate: DeviceUEstimate, catalog: CatalogLookup): string {
  const size = formatU(estimate.sixths)
  switch (estimate.via) {
    case 'rackmount':
      return `${size}, mounts directly with its own ears`
    case 'mount': {
      const mount = estimate.itemId === undefined ? undefined : catalog.item(estimate.itemId)
      return `~${size} on ${mount?.name ?? estimate.itemId ?? 'a mount'}`
    }
    case 'estimate':
      return `~${size}, estimated from its height`
  }
}

function mm(value: number): string {
  return String(Math.round(value * 10) / 10)
}

/** "179 × 183 × 34.5 mm" (width × depth × height). */
export function dimsText(device: Pick<Device, 'dims'>): string {
  const { w, d, h } = device.dims
  return `${mm(w)} × ${mm(d)} × ${mm(h)} mm`
}

export interface GrowPlan {
  /** Stack height after growing, in whole U. */
  targetU: number
  /** "3U". */
  addText: string
  /** Undefined when the frame allows the height. */
  blocked?: string
}

/** How tall the rack becomes when it grows by the shortfall, and whether the frame allows it. */
export function growPlan(summary: EquipmentUSummary, frame: Frame): GrowPlan | undefined {
  if (summary.shortfallSixths <= 0) return undefined
  const addU = Math.ceil(sixthsToU(summary.shortfallSixths))
  const targetU = Math.ceil(sixthsToU(summary.rackSixths)) + addU
  const addText = formatU(uToSixths(addU))
  if (targetU > frame.stack.maxU) {
    return {
      targetU,
      addText,
      blocked: `Adding ${addText} would make the rack ${targetU}U; ${frame.name} stacks go up to ${frame.stack.maxU}U.`,
    }
  }
  return { targetU, addText }
}

// ---------------------------------------------------------------------------------------------
// Fit it for me

/** "1 device", "3 devices". */
function devices(count: number): string {
  return `${count} ${count === 1 ? 'device' : 'devices'}`
}

/** The tray entry's device name in `plan` (the plan before the fit), else its id. */
export function equipmentName(plan: Plan, catalog: CatalogLookup, equipmentId: string): string {
  const entry = plan.equipment.find((candidate) => candidate.id === equipmentId)
  if (entry === undefined) return equipmentId
  const device = catalog.device(entry.deviceId)
  return device === undefined ? entry.deviceId : deviceName(device)
}

export interface FitReport {
  /** How many tray devices got a place. */
  placed: number
  /** One line: what was placed and added ("Placed 4 devices and added 3U at the top."). */
  headline: string
  /** Each tray device left behind, with why. */
  leftOver: Array<{ equipmentId: string; name: string; reason: string }>
  /** Everything to announce: the headline, then each device left behind. */
  announcement: string
}

/**
 * What "Fit it for me" did, in words. `before` is the plan it ran on (for the devices' names);
 * `owned` says the new sections and mounts were marked In my rack (Recording mode).
 */
export function fitReport(
  result: Pick<FitItForMeResult, 'placed' | 'unplaced' | 'addedU'>,
  before: Plan,
  catalog: CatalogLookup,
  at: StackEnd,
  owned = false,
): FitReport {
  const placed = result.placed.length
  const added =
    result.addedU > 0
      ? ` and added ${formatU(uToSixths(result.addedU))} ${at === 'top' ? 'at the top' : 'at the bottom'}`
      : ''
  const marked = owned && placed > 0 ? `, marked ${HAVE_TEXT}` : ''
  const headline =
    placed === 0
      ? result.unplaced.length === 0
        ? 'Nothing is waiting to be placed.'
        : `None of the ${devices(result.unplaced.length)} could be placed.`
      : result.unplaced.length === 0
        ? `Placed ${placed === 1 ? 'the device' : `all ${devices(placed)}`}${added}${marked}.`
        : `Placed ${devices(placed)} of ${placed + result.unplaced.length}${added}${marked}.`
  const leftOver = result.unplaced.map(({ equipmentId, reason }) => ({
    equipmentId,
    name: equipmentName(before, catalog, equipmentId),
    reason,
  }))
  const announcement = [
    headline,
    ...leftOver.map(({ name, reason }) => `${name} is still waiting: ${reason}`),
  ].join(' ')
  return { placed, headline, leftOver, announcement }
}
