/**
 * Plans for the palette and inspector tests: the bundled KWS Rack v2 frame (3U and 6U sections)
 * plus the plan's own `custom:` parts, so the tests do not depend on curated catalog entries.
 * Names start with "Zeta" so a search finds exactly these. Illustrative values, not measurements.
 */
import { createPlan } from '@/db/plansRepo'
import {
  PLAN_SCHEMA_VERSION,
  PlanSchema,
  type PlacedDevice,
  type Placement,
  type Plan,
} from '@/domain/schema/plan'
import { usePlanStore } from '@/state/planStore'

export const KWS_FRAME_ID = 'kws-rack-v2'
export const FIXTURE_AT = '2026-10-11T09:30:00.000Z'

export const ZETA = {
  pcMount: 'custom:zeta-pc-mount',
  blank1u: 'custom:zeta-blank-1u',
  blank2u: 'custom:zeta-blank-2u',
  labRaxMount: 'custom:zeta-lab-rax-mount',
  tinyPc: 'custom:zeta-tiny-pc',
  bigPc: 'custom:zeta-big-pc',
  switch: 'custom:zeta-switch',
  pdu: 'custom:zeta-pdu',
} as const

const UNVERIFIED = { by: 'test', date: '2026-10-11', method: 'unverified' } as const
const CHECKED = { by: 'test', date: '2026-10-11', method: 'page' } as const

const ITEMS = [
  {
    kind: 'item',
    id: ZETA.pcMount,
    name: 'Zeta PC mount 1U',
    category: 'mount',
    source: {
      platform: 'makerworld',
      url: 'https://makerworld.com/en/models/1',
      designer: 'Zeta Designer',
      license: 'Standard Digital File License',
    },
    verified: UNVERIFIED,
    heightSixths: 6,
    depthMm: 190,
    mount: { front: 4, holeOffsetsMm: [6.35, 38.1] },
    slots: [
      {
        id: 'pc',
        label: 'Mini PC',
        kind: 'fixed',
        maxW: 180,
        maxD: 184,
        maxH: 36,
        orientations: ['flat'],
        accepts: { categories: ['mini-pc'] },
        layout: { xMm: 21, yMm: 4, zMm: 0 },
      },
    ],
    options: [{ id: 'vents', label: 'Vent slots', scope: 'item', kind: 'boolean', default: false }],
  },
  {
    kind: 'item',
    id: ZETA.blank1u,
    name: 'Zeta blank 1U',
    category: 'panel',
    verified: CHECKED,
    heightSixths: 6,
    faces: ['front', 'rear'],
    depthMm: 10,
    mount: { front: 4, holeOffsetsMm: [6.35, 38.1] },
  },
  {
    kind: 'item',
    id: ZETA.blank2u,
    name: 'Zeta blank 2U',
    category: 'panel',
    verified: CHECKED,
    heightSixths: 12,
    depthMm: 10,
    mount: { front: 4 },
  },
  {
    kind: 'item',
    id: ZETA.labRaxMount,
    name: 'Zeta Lab Rax mount',
    category: 'mount',
    verified: CHECKED,
    heightSixths: 6,
    depthMm: 120,
    mount: { front: 4 },
    compat: { frames: ['lab-rax'] },
  },
]

const DEVICES = [
  {
    kind: 'device',
    id: ZETA.tinyPc,
    brand: 'Zeta',
    model: 'Tiny PC',
    category: 'mini-pc',
    dims: { w: 179, d: 183, h: 34.5 },
    verified: CHECKED,
  },
  {
    kind: 'device',
    id: ZETA.bigPc,
    brand: 'Zeta',
    model: 'Big PC',
    category: 'mini-pc',
    dims: { w: 200, d: 200, h: 50 },
    verified: CHECKED,
  },
  {
    kind: 'device',
    id: ZETA.switch,
    brand: 'Zeta',
    model: 'Switch 8',
    category: 'switch',
    dims: { w: 100, d: 98, h: 26 },
    verified: CHECKED,
  },
  {
    kind: 'device',
    id: ZETA.pdu,
    brand: 'Zeta',
    model: 'PDU 4',
    category: 'pdu',
    dims: { w: 220, d: 100, h: 40 },
    rackmount: { heightSixths: 6, face: 'front', depthMm: 100 },
    verified: CHECKED,
  },
]

export interface SectionSpec {
  id?: string
  typeId: 's3' | 's6'
  have?: boolean
}

export interface PlacementSpec {
  id?: string
  itemId: string
  y: number
  have?: boolean
  devices?: ReadonlyArray<Pick<PlacedDevice, 'id' | 'deviceId' | 'slotId' | 'have'>>
}

const HEIGHTS = { s3: 3, s6: 6 } as const

/** A KWS plan with the Zeta parts as its own entries. Ids default to sec-1.., pl-1... */
export function buildPlan(
  sections: readonly SectionSpec[],
  placements: readonly PlacementSpec[] = [],
): Plan {
  const plan = {
    schema: PLAN_SCHEMA_VERSION,
    id: 'plan-editor-test',
    rackId: 'rack-editor-test',
    name: 'Editor test',
    createdAt: FIXTURE_AT,
    updatedAt: FIXTURE_AT,
    rev: 0,
    frame: {
      frameId: KWS_FRAME_ID,
      options: {},
      caps: { top: {}, bottom: {} },
      sections: sections.map((section, index) => ({
        id: section.id ?? `sec-${index + 1}`,
        typeId: section.typeId,
        ...(section.have === true
          ? {
              have: {
                at: FIXTURE_AT,
                typeId: section.typeId,
                heightU: HEIGHTS[section.typeId],
                options: {},
              },
            }
          : {}),
      })),
    },
    placements: placements.map((placement, index): Placement => ({
      id: placement.id ?? `pl-${index + 1}`,
      itemId: placement.itemId,
      y: placement.y,
      face: 'front',
      bay: 'full',
      devices: (placement.devices ?? []).map((device) => ({ ...device })),
      ...(placement.have === true
        ? { have: { at: FIXTURE_AT, itemId: placement.itemId, options: {} } }
        : {}),
    })),
    equipment: [],
    extras: [],
    retired: [],
    custom: { frames: [], items: ITEMS, devices: DEVICES, hardware: [] },
  }
  return PlanSchema.parse(plan)
}

/** Stores the plan and opens it in the app's plan store (as the editor route does). */
export async function openPlan(plan: Plan): Promise<Plan> {
  const stored = await createPlan(plan)
  await usePlanStore.getState().load(stored.id)
  const open = usePlanStore.getState().plan
  if (open === null) throw new Error('The plan did not open.')
  return open
}

/** The open plan (throws when none is open). */
export function currentPlan(): Plan {
  const plan = usePlanStore.getState().plan
  if (plan === null) throw new Error('No plan is open.')
  return plan
}
