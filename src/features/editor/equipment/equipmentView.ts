/**
 * What the "Equipment to fit" tray says, as plain functions: the rack-space summary ("Needs ~10U ·
 * rack 9U, 2U free → add 3U"), how much space each device needs and why, its size, and how far the
 * rack can grow.
 */
import type { DeviceUEstimate, EquipmentUSummary } from '@/domain/devices'
import { formatU, sixthsToU, uToSixths } from '@/domain/geometry'
import type { CatalogLookup, Device, Frame } from '@/domain/schema/catalog'

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
