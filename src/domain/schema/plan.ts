import { z } from 'zod'
import { DeviceSchema, FrameSchema, HardwareSchema, ItemSchema } from './catalog'
import {
  CUSTOM_ID_PREFIX,
  FaceSchema,
  IdSchema,
  isCustomId,
  KeySchema,
  OptionValuesSchema,
  OrientationSchema,
} from './common'

/** Bump together with a new step in `migrate.ts`. */
export const PLAN_SCHEMA_VERSION = 1

const IsoDateTimeSchema = z.iso.datetime({ offset: true })

/**
 * What the user owned when they marked something as Have: the as-built BOM is computed from
 * these, so later edits to the planned version never change what is already built.
 * - section: typeId, heightU, options
 * - cap: options
 * - placement / extra: itemId, options
 */
export const SnapshotSchema = z.object({
  at: IsoDateTimeSchema,
  typeId: KeySchema.optional(),
  heightU: z.number().int().positive().optional(),
  itemId: IdSchema.optional(),
  /** Resolved option values at capture time. */
  options: OptionValuesSchema.default(() => ({})),
})
export type Snapshot = z.infer<typeof SnapshotSchema>

export const PlanSectionSchema = z.object({
  id: IdSchema,
  typeId: KeySchema,
  /** Only for section types with a height range. */
  heightU: z.number().int().positive().optional(),
  options: OptionValuesSchema.optional(),
  have: SnapshotSchema.optional(),
})
export type PlanSection = z.infer<typeof PlanSectionSchema>

export const CapStateSchema = z.object({
  options: OptionValuesSchema.optional(),
  have: SnapshotSchema.optional(),
})
export type CapState = z.infer<typeof CapStateSchema>

export const PlanFrameSchema = z.object({
  frameId: IdSchema,
  /** Rack-wide option values. */
  options: OptionValuesSchema.default(() => ({})),
  caps: z
    .object({
      top: CapStateSchema.default(() => ({})),
      bottom: CapStateSchema.default(() => ({})),
    })
    .default(() => ({ top: {}, bottom: {} })),
  /** Bottom -> top. */
  sections: z.array(PlanSectionSchema).default(() => []),
})
export type PlanFrame = z.infer<typeof PlanFrameSchema>

/** A device sitting in one of a placement's slots. */
export const PlacedDeviceSchema = z.object({
  id: IdSchema,
  deviceId: IdSchema,
  slotId: KeySchema,
  /** Position along X inside an area slot; auto-packed when missing. */
  xMm: z.number().optional(),
  orientation: OrientationSchema.optional(),
  have: z.boolean().default(false),
})
export type PlacedDevice = z.infer<typeof PlacedDeviceSchema>

export const PlacementBaySchema = z.enum(['full', 'left', 'right'])
export type PlacementBay = z.infer<typeof PlacementBaySchema>

export const PlacementSchema = z.object({
  id: IdSchema,
  itemId: IdSchema,
  /** Denormalized so unknown catalog ids still render as labelled placeholders. */
  name: z.string().optional(),
  /** Denormalized, as above. */
  heightSixths: z.number().int().nonnegative().optional(),
  /** Bottom edge in sixths from the bottom of U1. Out-of-rack values are flagged by checks. */
  y: z.number().int(),
  face: FaceSchema.default('front'),
  bay: PlacementBaySchema.default('full'),
  options: OptionValuesSchema.optional(),
  have: SnapshotSchema.optional(),
  label: z.string().optional(),
  devices: z.array(PlacedDeviceSchema).default(() => []),
})
export type Placement = z.infer<typeof PlacementSchema>

/** A device not placed yet (the "Equipment to fit" tray). */
export const PlanEquipmentSchema = z.object({
  id: IdSchema,
  deviceId: IdSchema,
  have: z.boolean().default(false),
  note: z.string().optional(),
})
export type PlanEquipment = z.infer<typeof PlanEquipmentSchema>

export const PlanExtraSchema = z.object({
  id: IdSchema,
  itemId: IdSchema,
  qty: z.number().int().nonnegative(),
  haveQty: z.number().int().nonnegative().default(0),
})
export type PlanExtra = z.infer<typeof PlanExtraSchema>

export const RetiredKindSchema = z.enum(['section', 'placement', 'extra', 'cap'])
export type RetiredKind = z.infer<typeof RetiredKindSchema>

/** Removed from the plan but still owned: Reuse / Keep as spare / Discard. */
export const RetiredEntrySchema = z.object({
  id: IdSchema,
  kind: RetiredKindSchema,
  snapshot: SnapshotSchema,
  /** Id of the removed section/placement/extra, or 'top' | 'bottom' for a cap. */
  sourceId: z.string().optional(),
  /** Device catalog ids that were owned in the removed placement. */
  devices: z.array(IdSchema).optional(),
  /** Owned quantity for a retired extra. */
  qty: z.number().int().nonnegative().optional(),
})
export type RetiredEntry = z.infer<typeof RetiredEntrySchema>

const CUSTOM_KINDS = ['frames', 'items', 'devices', 'hardware'] as const

/**
 * The user's private catalog entries used by this plan. Their ids must start with `custom:` so a
 * plan (or a share link) can never shadow a curated entry.
 */
export const PlanCustomSchema = z
  .object({
    frames: z.array(FrameSchema).default(() => []),
    items: z.array(ItemSchema).default(() => []),
    devices: z.array(DeviceSchema).default(() => []),
    hardware: z.array(HardwareSchema).default(() => []),
  })
  .superRefine((custom, ctx) => {
    for (const kind of CUSTOM_KINDS) {
      const entries: ReadonlyArray<{ id: string }> = custom[kind]
      for (const [index, entry] of entries.entries()) {
        if (isCustomId(entry.id)) continue
        ctx.addIssue({
          code: 'custom',
          path: [kind, index, 'id'],
          message: `Custom entries need an id that starts with "${CUSTOM_ID_PREFIX}"`,
        })
      }
    }
  })
export type PlanCustom = z.infer<typeof PlanCustomSchema>

export const PlanSchema = z.object({
  schema: z.literal(PLAN_SCHEMA_VERSION),
  id: IdSchema,
  /** Groups the ideas made for one physical rack. */
  rackId: IdSchema,
  name: z.string().max(200),
  notes: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  /** Compare-and-swap revision for autosave across tabs. */
  rev: z.number().int().nonnegative().default(0),
  catalogRev: z.string().optional(),
  frame: PlanFrameSchema,
  placements: z.array(PlacementSchema).default(() => []),
  equipment: z.array(PlanEquipmentSchema).default(() => []),
  extras: z.array(PlanExtraSchema).default(() => []),
  retired: z.array(RetiredEntrySchema).default(() => []),
  custom: PlanCustomSchema.default(() => ({ frames: [], items: [], devices: [], hardware: [] })),
})
export type Plan = z.infer<typeof PlanSchema>
