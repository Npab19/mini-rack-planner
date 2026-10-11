/**
 * The plan behind "Open the sample": a KWS Rack v2 going from 9U to 12U, built from the bundled
 * catalog. The 3U at the bottom and the 6U above it are built (Have) and hold a power-supply shelf,
 * a blank panel and a Lenovo Tiny with its PC; a new 3U on top (Need) holds a rack for two 3.5"
 * drives. Mounts and devices whose catalog ids are missing (renamed, or a trimmed catalog) are left
 * out, so the sample still opens.
 */
import { markSection } from '@/domain/frame'
import { uToSixths } from '@/domain/geometry'
import { ID_PREFIX, newId } from '@/domain/ids'
import { addPlacement, slotAccepts } from '@/domain/placement'
import { resolveOptionValues, sectionHeightU } from '@/domain/recipe'
import type { CatalogLookup, Frame } from '@/domain/schema/catalog'
import {
  PLAN_SCHEMA_VERSION,
  PlanSchema,
  type PlacedDevice,
  type Placement,
  type Plan,
} from '@/domain/schema/plan'

export const SAMPLE_FRAME_ID = 'kws-rack-v2'
export const SAMPLE_NAME = 'Sample: KWS 9U → 12U'
const SAMPLE_NOTES =
  'A KWS Rack v2 built as 3U + 6U, growing to 12U with one more 3U on top for two 3.5-inch drives. Everything in the built 9U is in my rack; the new section and what goes in it are to get.'

/** Bottom -> top; the first two are built. */
const SAMPLE_SECTIONS = [
  { typeId: 's3', have: true },
  { typeId: 's6', have: true },
  { typeId: 's3', have: false },
] as const

interface SampleMount {
  itemId: string
  /** Bottom edge in sixths of a U (0 = bottom of U1). */
  y: number
  devices: ReadonlyArray<{ deviceId: string; slotId: string }>
}

const SAMPLE_MOUNTS: readonly SampleMount[] = [
  // U1–U2: power bricks on the shelf (none listed: they ship with the devices).
  { itemId: 'kws-power-supplies-shelf-2u', y: 0, devices: [] },
  // U3
  { itemId: 'generic-blank-1u', y: 12, devices: [] },
  // U4, the bottom of the 6U section
  {
    itemId: 'lenovo-tiny-mount-1u',
    y: 18,
    devices: [{ deviceId: 'lenovo-thinkcentre-m720q-tiny', slotId: 'pc' }],
  },
  // U10, the bottom of the new 3U section
  {
    itemId: 'two-3-5-drive-rack-1u',
    y: 54,
    devices: [
      { deviceId: 'drive-3-5-inch', slotId: 'drive-left' },
      { deviceId: 'drive-3-5-inch', slotId: 'drive-right' },
    ],
  },
]

/** The bundled catalog cannot make the sample (the KWS frame or its section types are gone). */
export class SampleUnavailableError extends Error {
  override name = 'SampleUnavailableError'
}

export interface SampleResult {
  plan: Plan
  /** Catalog ids that were left out because the catalog does not have them. */
  skipped: string[]
}

function capsHave(plan: Plan, frame: Frame, at: string): Plan {
  // Every frame option as it resolves for the cap, like Mark as Have (and the wizard) capture it.
  const snapshot = (cap: 'top' | 'bottom') => ({
    at,
    options: resolveOptionValues(frame.options, plan.frame.options, plan.frame.caps[cap].options),
  })
  const { top, bottom } = plan.frame.caps
  return {
    ...plan,
    frame: {
      ...plan.frame,
      caps: {
        top: { ...top, have: snapshot('top') },
        bottom: { ...bottom, have: snapshot('bottom') },
      },
    },
  }
}

/** The built part of the stack, in sixths: [0, top of the last Have section at the bottom). */
function builtTopSixths(plan: Plan, frame: Frame): number {
  let top = 0
  for (const section of plan.frame.sections) {
    if (section.have === undefined) break
    top += uToSixths(sectionHeightU(frame, section.typeId, section.heightU))
  }
  return top
}

/**
 * The sample plan with fresh ids. Placements inside the built sections are Have (with snapshots),
 * the rest Need.
 * @throws SampleUnavailableError when the catalog has no KWS Rack v2 with 3U and 6U sections
 */
export function buildSamplePlan(lookup: CatalogLookup, now: string): SampleResult {
  const frame = lookup.frame(SAMPLE_FRAME_ID)
  const typeIds = new Set(frame?.sectionTypes.map((type) => type.id))
  if (frame === undefined || SAMPLE_SECTIONS.some((section) => !typeIds.has(section.typeId))) {
    throw new SampleUnavailableError(
      'The sample needs the KWS Rack v2 frame, which is missing from this version’s catalog.',
    )
  }
  const sections = SAMPLE_SECTIONS.map((section) => ({
    id: newId(ID_PREFIX.section),
    typeId: section.typeId,
  }))
  let plan: Plan = {
    schema: PLAN_SCHEMA_VERSION,
    id: newId(ID_PREFIX.plan),
    rackId: newId(ID_PREFIX.rack),
    name: SAMPLE_NAME,
    notes: SAMPLE_NOTES,
    createdAt: now,
    updatedAt: now,
    rev: 0,
    frame: { frameId: frame.id, options: {}, caps: { top: {}, bottom: {} }, sections },
    placements: [],
    equipment: [],
    extras: [],
    retired: [],
    custom: { frames: [], items: [], devices: [], hardware: [] },
  }
  for (const [index, section] of SAMPLE_SECTIONS.entries()) {
    const id = sections[index]?.id
    if (!section.have || id === undefined) continue
    const marked = markSection(plan, id, true, now, frame)
    if (marked.error !== undefined) throw new SampleUnavailableError(marked.error)
    plan = marked.plan
  }
  plan = capsHave(plan, frame, now)

  const builtTop = builtTopSixths(plan, frame)
  const skipped: string[] = []
  for (const mount of SAMPLE_MOUNTS) {
    const added = addPlacement(plan, lookup, { itemId: mount.itemId, y: mount.y })
    const item = lookup.item(mount.itemId)
    if (added.placementId === undefined || item === undefined) {
      skipped.push(mount.itemId)
      continue
    }
    const have = mount.y + item.heightSixths <= builtTop
    const devices: PlacedDevice[] = []
    for (const wanted of mount.devices) {
      const device = lookup.device(wanted.deviceId)
      const slot = item.slots.find((candidate) => candidate.id === wanted.slotId)
      if (device === undefined || slot === undefined || !slotAccepts(slot, device)) {
        skipped.push(wanted.deviceId)
        continue
      }
      devices.push({
        id: newId(ID_PREFIX.placedDevice),
        deviceId: device.id,
        slotId: slot.id,
        have,
      })
    }
    const placements = added.plan.placements.map((placement): Placement => {
      if (placement.id !== added.placementId) return placement
      const owned = have
        ? {
            have: {
              at: now,
              itemId: item.id,
              options: resolveOptionValues(item.options, placement.options),
            },
          }
        : {}
      return { ...placement, ...owned, devices }
    })
    plan = { ...added.plan, placements }
  }

  const parsed = PlanSchema.safeParse(plan)
  if (!parsed.success) {
    throw new SampleUnavailableError('The sample plan could not be built from this catalog.')
  }
  return { plan: parsed.data, skipped }
}
