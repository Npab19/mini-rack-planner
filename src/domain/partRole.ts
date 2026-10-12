/**
 * What a part is for, so the rack and every list that names a part can colour it by role:
 * compute, storage, network, power, or neutral (panels, shelves and anything else).
 *
 * Colour only repeats what the names already say, so a role is a hint, never the only cue.
 * - A device's role comes from its category (`deviceRole`).
 * - An item's role comes from what its slots accept (the most common role, ties -> first), else
 *   its render style or category (`itemRole`).
 * - A placement takes the role of the devices on it (most common, ties -> first in slot order),
 *   else its item's role; ear-mounted gear takes its device's role (`placementRole`).
 * Unknown ids are neutral.
 */
import { resolvePlaceable } from './placement'
import type { CatalogLookup, DeviceCategory, Item } from './schema/catalog'
import type { Placement } from './schema/plan'

export type PartRole = 'compute' | 'storage' | 'network' | 'power' | 'neutral'

/** Every role, in legend order. */
export const PART_ROLES: readonly PartRole[] = ['compute', 'storage', 'network', 'power', 'neutral']

export const PART_ROLE_LABEL: Readonly<Record<PartRole, string>> = {
  compute: 'Compute',
  storage: 'Storage',
  network: 'Network',
  power: 'Power',
  neutral: 'Panels and shelves',
}

export function deviceRole(category: DeviceCategory): PartRole {
  switch (category) {
    case 'mini-pc':
    case 'sbc':
      return 'compute'
    case 'nas':
    case 'drive':
      return 'storage'
    case 'switch':
    case 'router':
    case 'gateway':
    case 'patch-panel':
    case 'kvm':
      return 'network'
    case 'pdu':
    case 'ups':
    case 'power-brick':
      return 'power'
    case 'other':
      return 'neutral'
    default: {
      // A new category must pick a role here.
      const unhandled: never = category
      return unhandled
    }
  }
}

/** The most common non-neutral role, ties -> the first one seen; neutral when there is none. */
function majorityRole(roles: Iterable<PartRole>): PartRole {
  // A Map iterates in first-seen order, so the role seen first wins a tie.
  const counts = new Map<PartRole, number>()
  for (const role of roles) {
    if (role !== 'neutral') counts.set(role, (counts.get(role) ?? 0) + 1)
  }
  let best: PartRole = 'neutral'
  let bestCount = 0
  for (const [role, count] of counts) {
    if (count > bestCount) {
      best = role
      bestCount = count
    }
  }
  return best
}

/**
 * An item's role: the most common role among the device categories its slots accept (ties ->
 * first in slot order); else `render.style` power -> power, keystone -> network; else category
 * 'power' -> power; else neutral.
 */
export function itemRole(item: Pick<Item, 'category' | 'slots' | 'render'>): PartRole {
  const accepted = majorityRole(
    item.slots.flatMap((slot) => (slot.accepts?.categories ?? []).map(deviceRole)),
  )
  if (accepted !== 'neutral') return accepted
  const style = item.render?.style
  if (style === 'power') return 'power'
  if (style === 'keystone') return 'network'
  return item.category === 'power' ? 'power' : 'neutral'
}

/**
 * A placement's role: the most common role of the known devices on it (ties -> first in slot
 * order), else its item's role. Ear-mounted gear takes its device's role; unknown ids are neutral.
 */
export function placementRole(
  placement: Pick<Placement, 'itemId' | 'devices'>,
  catalog: CatalogLookup,
): PartRole {
  const placeable = resolvePlaceable(catalog, placement.itemId)
  if (placeable === undefined) return 'neutral'
  if (placeable.source === 'rackmount') {
    const device = catalog.device(placement.itemId)
    return device === undefined ? 'neutral' : deviceRole(device.category)
  }
  const slotOrder = new Map(placeable.slots.map((slot, index) => [slot.id, index]))
  // Stable sort: devices in a slot keep their stored order; stray slot ids go last.
  const devices = placement.devices.toSorted(
    (a, b) =>
      (slotOrder.get(a.slotId) ?? slotOrder.size) - (slotOrder.get(b.slotId) ?? slotOrder.size),
  )
  const held = majorityRole(
    devices.flatMap((placed) => {
      const device = catalog.device(placed.deviceId)
      return device === undefined ? [] : [deviceRole(device.category)]
    }),
  )
  if (held !== 'neutral') return held
  const item = catalog.item(placement.itemId)
  return item === undefined ? 'neutral' : itemRole(item)
}

/** The role of any catalog id: an item (or extra), a device, else neutral. */
export function catalogEntryRole(catalog: CatalogLookup, id: string): PartRole {
  const item = catalog.item(id)
  if (item !== undefined) return itemRole(item)
  const device = catalog.device(id)
  return device === undefined ? 'neutral' : deviceRole(device.category)
}
