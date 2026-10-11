/**
 * Copies of a plan with fresh ids: "Duplicate", "Save as a copy" and backup import in copy mode.
 * Pure (no database access).
 */
import { ID_PREFIX, newId } from '@/domain/ids'
import type {
  CapState,
  PlacedDevice,
  Placement,
  Plan,
  PlanEquipment,
  PlanExtra,
  PlanSection,
  RetiredEntry,
} from '@/domain/schema/plan'

const MAX_NAME_LENGTH = 200
const COPY_SUFFIX = ' (copy)'

export interface ClonePlanOptions {
  /** Name of the copy (default: the original's). */
  name?: string
  /** rackId of the copy: the original's for another idea for the same rack, else a new one. */
  rackId: string
  /**
   * Start over from nothing owned: clears every Have mark (sections, caps, placements, devices,
   * equipment, extras) and drops retired parts. Otherwise ownership is kept.
   */
  resetHave: boolean
  /** createdAt / updatedAt of the copy (ISO date-time). */
  now: string
}

/** "Rack (copy)", kept within the 200-character name limit. */
export function copyName(name: string): string {
  const base = name.trim() || 'Untitled plan'
  return `${base.slice(0, MAX_NAME_LENGTH - COPY_SUFFIX.length)}${COPY_SUFFIX}`
}

/**
 * The plan with new ids for itself and every section, placement, placed device, equipment entry,
 * extra and retired entry. Nothing in a plan refers to these ids (placements sit at a `y`, not on
 * a section id), so no references need rewriting. Catalog ids, including the plan's `custom:`
 * entries, stay as they are.
 */
export function clonePlanWithNewIds(plan: Plan, options: ClonePlanOptions): Plan {
  const reset = options.resetHave
  return {
    ...plan,
    id: newId(ID_PREFIX.plan),
    rackId: options.rackId,
    name: options.name ?? plan.name,
    createdAt: options.now,
    updatedAt: options.now,
    rev: 0,
    frame: {
      ...plan.frame,
      caps: {
        top: capCopy(plan.frame.caps.top, reset),
        bottom: capCopy(plan.frame.caps.bottom, reset),
      },
      sections: plan.frame.sections.map((section) => sectionCopy(section, reset)),
    },
    placements: plan.placements.map((placement) => placementCopy(placement, reset)),
    equipment: plan.equipment.map((entry) => equipmentCopy(entry, reset)),
    extras: plan.extras.map((extra) => extraCopy(extra, reset)),
    retired: reset ? [] : plan.retired.map(retiredCopy),
  }
}

function capCopy(cap: CapState, reset: boolean): CapState {
  const copy = { ...cap }
  if (reset) delete copy.have
  return copy
}

function sectionCopy(section: PlanSection, reset: boolean): PlanSection {
  const copy: PlanSection = { ...section, id: newId(ID_PREFIX.section) }
  if (reset) delete copy.have
  return copy
}

function deviceCopy(device: PlacedDevice, reset: boolean): PlacedDevice {
  return { ...device, id: newId(ID_PREFIX.placedDevice), have: reset ? false : device.have }
}

function placementCopy(placement: Placement, reset: boolean): Placement {
  const copy: Placement = {
    ...placement,
    id: newId(ID_PREFIX.placement),
    devices: placement.devices.map((device) => deviceCopy(device, reset)),
  }
  if (reset) delete copy.have
  return copy
}

function equipmentCopy(entry: PlanEquipment, reset: boolean): PlanEquipment {
  return { ...entry, id: newId(ID_PREFIX.equipment), have: reset ? false : entry.have }
}

function extraCopy(extra: PlanExtra, reset: boolean): PlanExtra {
  return { ...extra, id: newId(ID_PREFIX.extra), haveQty: reset ? 0 : extra.haveQty }
}

function retiredCopy(entry: RetiredEntry): RetiredEntry {
  return { ...entry, id: newId(ID_PREFIX.retired) }
}
