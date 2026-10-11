/**
 * Pure placement edits the inspector needs on top of placement.ts: a duplicate that lands on a
 * free spot, and what the selection ids point at.
 */
import { placementName } from '@/domain/frame'
import { canPlace, duplicatePlacement } from '@/domain/placement'
import type { CatalogLookup, Frame } from '@/domain/schema/catalog'
import type { Placement, PlacementBay, PlanSection, Plan } from '@/domain/schema/plan'
import { nearestFreeStart } from './stackModel'

export interface Duplicated {
  plan: Plan
  placementId: string
}

/**
 * "Duplicate": the copy (reset to To get) goes right above the original when that spot is free,
 * else on the free spot nearest to it on the same face (the other half for half-width parts).
 * Returns a user-facing reason when there is no room.
 */
export function duplicateNear(
  plan: Plan,
  lookup: CatalogLookup,
  frame: Frame | undefined,
  placementId: string,
): Duplicated | string {
  const original = plan.placements.find((placement) => placement.id === placementId)
  if (original === undefined) return 'That part is no longer in the plan.'
  const name = placementName(original, lookup)
  const above = duplicatePlacement(plan, placementId, { catalog: lookup })
  const copy = above.plan.placements.find((placement) => placement.id === above.placementId)
  if (copy === undefined || above.placementId === undefined) return `${name} could not be copied.`
  if (frame === undefined) return { plan: above.plan, placementId: above.placementId }
  const fits = canPlace(plan, lookup, frame, {
    itemId: copy.itemId,
    y: copy.y,
    face: copy.face,
    bay: copy.bay,
    devices: copy.devices,
  })
  if (fits.ok) return { plan: above.plan, placementId: above.placementId }
  const otherBay: PlacementBay[] =
    original.bay === 'left'
      ? ['left', 'right']
      : original.bay === 'right'
        ? ['right', 'left']
        : ['full']
  const spot = nearestFreeStart(plan, lookup, frame, {
    itemId: original.itemId,
    face: original.face,
    near: original.y,
    bays: otherBay,
    devices: copy.devices,
  })
  if (spot === undefined) {
    return `There is no free spot for another ${name} on the ${original.face} of the rack.`
  }
  const placed = duplicatePlacement(plan, placementId, { catalog: lookup, ...spot })
  if (placed.placementId === undefined) return `${name} could not be copied.`
  return { plan: placed.plan, placementId: placed.placementId }
}

export type ResolvedSelection =
  | { kind: 'none' }
  | { kind: 'placement'; placement: Placement; deviceEntryId?: string }
  | { kind: 'section'; section: PlanSection }
  | { kind: 'multi'; placements: Placement[]; sections: PlanSection[] }

const NONE: ResolvedSelection = { kind: 'none' }

/**
 * What the selected ids point at in this plan: placements, sections, or devices inside placements
 * (which select their placement). Stale ids are ignored; several things make a multi-selection.
 */
export function resolveSelection(plan: Plan, ids: readonly string[]): ResolvedSelection {
  if (ids.length === 0) return NONE
  const placements: Placement[] = []
  const sections: PlanSection[] = []
  const seen = new Set<string>()
  let deviceEntryId: string | undefined
  for (const id of ids) {
    const direct = plan.placements.find((placement) => placement.id === id)
    const holder =
      direct ?? plan.placements.find((placement) => placement.devices.some((d) => d.id === id))
    if (holder !== undefined) {
      if (direct === undefined) deviceEntryId ??= id
      if (!seen.has(holder.id)) placements.push(holder)
      seen.add(holder.id)
      continue
    }
    const section = plan.frame.sections.find((candidate) => candidate.id === id)
    if (section !== undefined && !seen.has(section.id)) {
      seen.add(section.id)
      sections.push(section)
    }
  }
  const [placement] = placements
  const [section] = sections
  if (placements.length + sections.length > 1) return { kind: 'multi', placements, sections }
  if (placement !== undefined) {
    return deviceEntryId === undefined
      ? { kind: 'placement', placement }
      : { kind: 'placement', placement, deviceEntryId }
  }
  return section === undefined ? NONE : { kind: 'section', section }
}
