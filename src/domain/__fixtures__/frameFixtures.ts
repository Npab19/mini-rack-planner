/**
 * Synthetic fixtures for the stack and placement engine tests (frame.test.ts, placement.test.ts):
 * a KWS-like frame with 3U and 6U sections on an EIA rail, a few mounts, devices and an
 * ear-mounted switch, and a plan builder. Generic names and round numbers, not catalog facts.
 */
import { sectionHeightU } from '../recipe'
import {
  catalogBundle,
  createCatalogLookup,
  DeviceSchema,
  FrameSchema,
  ItemSchema,
  type CatalogLookup,
  type Device,
  type Frame,
  type Item,
} from '../schema/catalog'
import type { Face, OptionValues, Orientation } from '../schema/common'
import { PlanSchema, type Plan, type PlacementBay } from '../schema/plan'

export const NOW = '2026-10-11T09:30:00.000Z'

const VERIFIED = { by: 'test', date: '2026-10-11', method: 'unverified' } as const

const FRAME_BASE = {
  kind: 'frame',
  verified: VERIFIED,
  standard: { panelWidthMm: 254, innerWidthMm: 222, depthMm: 200, rearOpen: true },
  rail: { earSpacingMm: 236.525, holeOffsetsPerUMm: [6.35, 22.225, 38.1], holeTolMm: 0.5 },
  equipmentFastener: { thread: 'M5', perHole: 'screw', screwIds: ['m5x10-shcs'], engagementMm: 5 },
} as const

/** 3U and 6U sections, 3U–18U stacks, 200 mm deep (320 mm with the rack option `deep`). */
export const FRAME: Frame = FrameSchema.parse({
  ...FRAME_BASE,
  id: 'test-frame',
  name: 'Test frame',
  sectionTypes: [
    { id: 's3', label: '3U section', heightU: 3 },
    { id: 's6', label: '6U section', heightU: 6 },
  ],
  stack: { minU: 3, maxU: 18, joint: { gapMm: 0, deadSixths: 0 } },
  options: [
    { id: 'magnets', label: 'Magnets', scope: 'section', kind: 'boolean', default: true },
    {
      id: 'deep',
      label: '320 mm connectors',
      scope: 'rack',
      kind: 'boolean',
      default: false,
      effects: { depthMm: 320 },
    },
    {
      id: 'top',
      label: 'Top',
      scope: 'top',
      kind: 'choice',
      choices: [
        { id: 'handle', label: 'Handle' },
        { id: 'flat', label: 'Flat' },
      ],
      default: 'handle',
    },
  ],
})

/** The same frame with 2 sixths at each joint where nothing can mount. */
export const DEAD_ZONE_FRAME: Frame = {
  ...FRAME,
  stack: { ...FRAME.stack, joint: { gapMm: 3, deadSixths: 2 } },
}

/** Plain rails: a section type with a height range plus a fixed 1U block. */
export const RANGE_FRAME: Frame = FrameSchema.parse({
  ...FRAME_BASE,
  id: 'test-rails',
  name: 'Test rails',
  sectionTypes: [
    { id: 'rails', label: 'Rails', heightU: { min: 2, max: 20 } },
    { id: 'block', label: '1U block', heightU: 1 },
  ],
  stack: { minU: 1, maxU: 30 },
})

function item(input: Record<string, unknown>): Item {
  return ItemSchema.parse({ kind: 'item', category: 'mount', verified: VERIFIED, ...input })
}

/** EIA hole pair 6.35 / 38.1 mm: a 1U item that only fits on whole U. */
export const BLANK_1U = item({
  id: 'blank-1u',
  name: 'Blank 1U',
  heightSixths: 6,
  faces: ['front', 'rear'],
  depthMm: 10,
  mount: { front: 4, holeOffsetsMm: [6.35, 38.1] },
})

export const BLANK_2U = item({
  id: 'blank-2u',
  name: 'Blank 2U',
  heightSixths: 12,
  faces: ['front', 'rear'],
  depthMm: 10,
  mount: { front: 4 },
})

/** No hole data: phases come from its height. */
export const HALF_U_PANEL = item({
  id: 'half-u-panel',
  name: 'Half-U panel',
  heightSixths: 3,
  faces: ['front', 'rear'],
  depthMm: 10,
  mount: { front: 2 },
})

export const SHELF_1U = item({
  id: 'shelf-1u',
  name: 'Shelf 1U',
  heightSixths: 6,
  depthMm: 150,
  mount: { front: 4, holeOffsetsMm: [6.35, 38.1] },
  slots: [
    {
      id: 'deck',
      label: 'Shelf deck',
      kind: 'area',
      maxW: 210,
      maxD: 150,
      orientations: ['flat', 'flat-rotated', 'on-side', 'upright'],
      layout: { xMm: 6, yMm: 4, zMm: -5 },
    },
  ],
})

export const PC_MOUNT_2U = item({
  id: 'mini-pc-mount-2u',
  name: 'Mini PC mount 2U',
  heightSixths: 12,
  depthMm: 190,
  mount: { front: 4 },
  slots: [
    {
      id: 'bay',
      label: 'Mini PC bay',
      kind: 'fixed',
      maxW: 190,
      maxD: 190,
      maxH: 80,
      orientations: ['flat', 'flat-rotated'],
      accepts: { categories: ['mini-pc'] },
      layout: { xMm: 16, yMm: 5, zMm: -3 },
    },
  ],
})

export const HALF_BAY_1U = item({
  id: 'half-bay-1u',
  name: 'Half-width 1U',
  heightSixths: 6,
  bay: 'half',
  depthMm: 80,
  mount: { front: 2 },
})

/** Screwed to both rails. */
export const DEEP_TRAY_2U = item({
  id: 'deep-tray-2u',
  name: 'Deep tray 2U',
  heightSixths: 12,
  depthMm: 180,
  requiresRearSupport: true,
  mount: { front: 4, rear: 4 },
})

export const REAR_FAN_1U = item({
  id: 'rear-fan-1u',
  name: 'Rear fan 1U',
  heightSixths: 6,
  faces: ['rear'],
  depthMm: 30,
  mount: { front: 4 },
})

export const VENT_1_5U = item({
  id: 'vent-1-5u',
  name: 'Vent 1½U',
  heightSixths: 9,
  depthMm: 10,
  mount: { front: 4 },
})

export const STRIP_THIRD_U = item({
  id: 'strip-third-u',
  name: 'Third-U strip',
  heightSixths: 2,
  depthMm: 10,
  mount: { front: 2 },
})

export const STRIP_TWO_THIRDS_U = item({
  id: 'strip-two-thirds-u',
  name: 'Two-thirds-U strip',
  heightSixths: 4,
  depthMm: 10,
  mount: { front: 2 },
})

export const FEET: Item = ItemSchema.parse({
  kind: 'extra',
  id: 'rubber-feet',
  name: 'Rubber feet',
  category: 'accessory',
  verified: VERIFIED,
  heightSixths: 0,
  depthMm: 0,
})

function device(input: Record<string, unknown>): Device {
  return DeviceSchema.parse({ kind: 'device', brand: 'Test', verified: VERIFIED, ...input })
}

export const MINI_PC = device({
  id: 'test-mini-pc',
  model: 'Mini PC',
  category: 'mini-pc',
  dims: { w: 179, d: 183, h: 35 },
})

export const NAS = device({
  id: 'test-nas',
  model: 'NAS',
  category: 'nas',
  dims: { w: 150, d: 140, h: 120 },
})

export const SBC = device({
  id: 'test-sbc',
  model: 'SBC',
  category: 'sbc',
  dims: { w: 90, d: 60, h: 25 },
})

/** Ear-mounted 1U gear, placed without a mount. */
export const SWITCH = device({
  id: 'test-switch',
  model: 'Switch',
  category: 'switch',
  dims: { w: 220, d: 100, h: 40 },
  rackmount: { heightSixths: 6, face: 'front', depthMm: 100 },
})

export const ITEMS: readonly Item[] = [
  BLANK_1U,
  BLANK_2U,
  HALF_U_PANEL,
  SHELF_1U,
  PC_MOUNT_2U,
  HALF_BAY_1U,
  DEEP_TRAY_2U,
  REAR_FAN_1U,
  VENT_1_5U,
  STRIP_THIRD_U,
  STRIP_TWO_THIRDS_U,
  FEET,
]

export const DEVICES: readonly Device[] = [MINI_PC, NAS, SBC, SWITCH]

export const CATALOG: CatalogLookup = createCatalogLookup(
  catalogBundle([FRAME, RANGE_FRAME, ...ITEMS, ...DEVICES]),
)

// ---------------------------------------------------------------------------------------------
// Plans

export interface SectionSpec {
  id: string
  typeId: string
  have?: boolean
  heightU?: number
  options?: OptionValues
}

export interface DeviceSpec {
  id: string
  deviceId: string
  slotId: string
  have?: boolean
  xMm?: number
  orientation?: Orientation
}

export interface PlacementSpec {
  id: string
  itemId: string
  y: number
  face?: Face
  bay?: PlacementBay
  have?: boolean
  label?: string
  devices?: readonly DeviceSpec[]
}

export interface PlanSpec {
  frame?: Frame
  sections?: readonly SectionSpec[]
  placements?: readonly PlacementSpec[]
}

/** The user's rack today: a 3U section at the bottom and a 6U above it, both built. */
export const USER_SECTIONS: readonly SectionSpec[] = [
  { id: 'sec-a', typeId: 's3', have: true },
  { id: 'sec-b', typeId: 's6', have: true },
]

/** A valid plan (through PlanSchema); placements get their catalog name and height denormalized. */
export function makePlan(spec: PlanSpec = {}): Plan {
  const frame = spec.frame ?? FRAME
  return PlanSchema.parse({
    schema: 1,
    id: 'plan-test',
    rackId: 'rack-test',
    name: 'Test plan',
    createdAt: NOW,
    updatedAt: NOW,
    frame: {
      frameId: frame.id,
      sections: (spec.sections ?? []).map((section) => planSection(section, frame)),
    },
    placements: (spec.placements ?? []).map(planPlacement),
  })
}

function planSection(spec: SectionSpec, frame: Frame): Record<string, unknown> {
  const { have, ...section } = spec
  if (have !== true) return section
  const heightU = sectionHeightU(frame, spec.typeId, spec.heightU)
  return { ...section, have: { at: NOW, typeId: spec.typeId, heightU, options: {} } }
}

function planPlacement(spec: PlacementSpec): Record<string, unknown> {
  const { have, devices = [], ...placement } = spec
  const known = CATALOG.item(spec.itemId)
  const rackmount = CATALOG.device(spec.itemId)
  const name = known?.name ?? (rackmount === undefined ? undefined : rackmount.model)
  const heightSixths = known?.heightSixths ?? rackmount?.rackmount?.heightSixths
  return {
    ...placement,
    ...(name === undefined ? {} : { name }),
    ...(heightSixths === undefined ? {} : { heightSixths }),
    ...(have === true ? { have: { at: NOW, itemId: spec.itemId, options: {} } } : {}),
    devices: devices.map((placed) => ({ have: false, ...placed })),
  }
}
