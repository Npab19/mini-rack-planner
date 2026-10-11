import { z } from 'zod'
import {
  ConditionSchema,
  DimsSchema,
  FaceSchema,
  IdSchema,
  KeySchema,
  LengthSchema,
  MmSchema,
  OrientationSchema,
  QtySchema,
  SourceSchema,
  ThreadSchema,
  Vec3Schema,
  VerifiedSchema,
  type Face,
  type OptionValue,
  type Orientation,
} from './common'

// ---------------------------------------------------------------------------------------------
// Options

/** Where an option is edited: rack-wide, on a cap, per section, or per placed item. */
export const OptionScopeSchema = z.enum(['rack', 'top', 'bottom', 'section', 'item'])
export type OptionScope = z.infer<typeof OptionScopeSchema>

export const OptionKindSchema = z.enum(['boolean', 'choice'])
export type OptionKind = z.infer<typeof OptionKindSchema>

/** Geometry an option changes, e.g. 320 mm-deep connectors -> `{ depthMm: 320 }`. */
export const OptionEffectsSchema = z.object({
  depthMm: MmSchema.optional(),
  innerWidthMm: MmSchema.optional(),
})
export type OptionEffects = z.infer<typeof OptionEffectsSchema>

export const OptionChoiceSchema = z.object({
  id: KeySchema,
  label: z.string().min(1),
  /** Effects while this choice is selected. */
  effects: OptionEffectsSchema.optional(),
})
export type OptionChoice = z.infer<typeof OptionChoiceSchema>

/**
 * A designer option ("[Optional] magnets", "top: handle or flat"). Boolean options apply
 * `effects` while true; choice options apply the selected choice's `effects`.
 */
export const OptionSchema = z
  .object({
    id: KeySchema,
    label: z.string().min(1),
    scope: OptionScopeSchema,
    kind: OptionKindSchema,
    choices: z.array(OptionChoiceSchema).optional(),
    default: z.union([z.boolean(), z.string()]),
    effects: OptionEffectsSchema.optional(),
    help: z.string().optional(),
  })
  .superRefine((option, ctx) => {
    if (option.kind === 'boolean') {
      if (typeof option.default !== 'boolean') {
        ctx.addIssue({
          code: 'custom',
          path: ['default'],
          message: 'A boolean option needs a true/false default',
        })
      }
      return
    }
    const choiceIds = (option.choices ?? []).map((choice) => choice.id)
    if (choiceIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'A choice option needs at least one choice',
      })
    } else if (typeof option.default !== 'string' || !choiceIds.includes(option.default)) {
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: 'The default must be one of the choice ids',
      })
    }
  })
export type Option = z.infer<typeof OptionSchema>

/** A boolean for boolean options; one of the choice ids for choice options. */
export function isValidOptionValue(option: Option, value: unknown): value is OptionValue {
  if (option.kind === 'boolean') return typeof value === 'boolean'
  return typeof value === 'string' && (option.choices ?? []).some((choice) => choice.id === value)
}

/** The declared default, or a safe fallback (false / first choice) if the entry is malformed. */
export function optionDefault(option: Option): OptionValue {
  if (isValidOptionValue(option, option.default)) return option.default
  return option.kind === 'boolean' ? false : (option.choices?.[0]?.id ?? '')
}

// ---------------------------------------------------------------------------------------------
// Prints and recipes

export const PrintPieceSchema = z.object({
  /** A `parts3d` id of the same entry. */
  partId: KeySchema,
  perPrint: z.number().int().positive(),
})
export type PrintPiece = z.infer<typeof PrintPieceSchema>

/** Hardware that goes into a print while it is assembled (heat-set inserts, glued magnets). */
export const PrintEmbedSchema = z.object({
  hardwareId: IdSchema,
  perPrint: z.number().nonnegative(),
  when: ConditionSchema.optional(),
})
export type PrintEmbed = z.infer<typeof PrintEmbedSchema>

/** One print job: a designer plate, printed `count` times by recipe lines. */
export const PrintGroupSchema = z.object({
  id: KeySchema,
  /** Plate name as the designer's profile or file shows it. */
  plate: z.string().min(1),
  label: z.string().min(1),
  material: z.string().min(1).optional(),
  gramsPerPrint: z.number().nonnegative().optional(),
  minutesPerPrint: z.number().nonnegative().optional(),
  pieces: z.array(PrintPieceSchema).optional(),
  embeds: z.array(PrintEmbedSchema).optional(),
})
export type PrintGroup = z.infer<typeof PrintGroupSchema>

/**
 * What a recipe line is counted per:
 * rack (once per stack) | top | bottom (once per cap) | section | joint (adjacent pair) | item.
 */
export const RecipeUnitSchema = z.enum(['rack', 'top', 'bottom', 'section', 'joint', 'item'])
export type RecipeUnit = z.infer<typeof RecipeUnitSchema>

/**
 * - assembly: parts that hold the frame or item together (reusable when the plan changes)
 * - rack-mount: screws that fix gear to the rails; the BOM derives these per placement, so recipe
 *   lines with this role are informational only
 * - embedded: hardware that ends up inside prints (never surplus)
 */
export const RecipeRoleSchema = z.enum(['assembly', 'rack-mount', 'embedded'])
export type RecipeRole = z.infer<typeof RecipeRoleSchema>

export const RecipeRefSchema = z.union([
  /** A `prints` id of the same entry. */
  z.strictObject({ print: KeySchema }),
  /** A hardware catalog id. */
  z.strictObject({ hardware: IdSchema }),
])
export type RecipeRef = z.infer<typeof RecipeRefSchema>

export const RecipeLineSchema = z.object({
  /** Immutable: line keys and saved state may refer to it. */
  id: KeySchema,
  unit: RecipeUnitSchema,
  ref: RecipeRefSchema,
  count: QtySchema,
  /** Cut length per piece for cut-to-length hardware. */
  length: LengthSchema.optional(),
  when: ConditionSchema.optional(),
  role: RecipeRoleSchema.default('assembly'),
  note: z.string().optional(),
})
export type RecipeLine = z.infer<typeof RecipeLineSchema>

// ---------------------------------------------------------------------------------------------
// Hardware

export const HardwareCategorySchema = z.enum([
  'screw',
  'nut',
  'insert',
  'cage-nut',
  't-nut',
  'washer',
  'magnet',
  'foot',
  'extrusion',
  'standoff',
  'cable-tie',
  'other',
])
export type HardwareCategory = z.infer<typeof HardwareCategorySchema>

export const HardwareHeadSchema = z.enum([
  'shcs',
  'bhcs',
  'fhcs',
  'hex',
  'nyloc',
  'square',
  'cage',
  'other',
])
export type HardwareHead = z.infer<typeof HardwareHeadSchema>

export const HardwareSchema = z.object({
  kind: z.literal('hardware'),
  id: IdSchema,
  name: z.string().min(1),
  category: HardwareCategorySchema,
  spec: z
    .object({
      /** Free text: "M6", "M5", "10-32", "M2.5". */
      thread: z.string().min(1).optional(),
      lengthMm: MmSchema.optional(),
      head: HardwareHeadSchema.optional(),
      odMm: MmSchema.optional(),
      /** Free-form size such as "10x5" (magnets) or "M5x8x7" (inserts). */
      dims: z.string().min(1).optional(),
    })
    .default(() => ({})),
  /** `mm` for cut-to-length stock (extrusions); quantities are then millimetres or pieces + cut length. */
  unit: z.enum(['pcs', 'mm']).default('pcs'),
  packSizes: z.array(z.number().int().positive()).optional(),
  aliases: z.array(z.string().min(1)).optional(),
  source: SourceSchema.optional(),
  verified: VerifiedSchema.optional(),
})
export type Hardware = z.infer<typeof HardwareSchema>

// ---------------------------------------------------------------------------------------------
// 3D

export const Part3DRoleSchema = z.enum([
  'leg',
  'connector',
  'cap',
  'panel',
  'tray',
  'shelf',
  'plate',
  'other',
])
export type Part3DRole = z.infer<typeof Part3DRoleSchema>

/** A distinct printed part shape; the proxy box (`envelopeMm`) renders until a mesh is linked. */
export const Part3DSchema = z.object({
  id: KeySchema,
  label: z.string().min(1),
  role: Part3DRoleSchema,
  envelopeMm: DimsSchema,
  mirrorAllowed: z.boolean().optional(),
  /** Object/plate names in the designer's files that identify this part. */
  nameHints: z.array(z.string().min(1)).optional(),
})
export type Part3D = z.infer<typeof Part3DSchema>

/** Front-left, front-right, rear-left, rear-right. */
export const CornerSchema = z.enum(['fl', 'fr', 'rl', 'rr'])
export type Corner = z.infer<typeof CornerSchema>

/** Where `assembly.ts` places a part. Kept small; extended compatibly by the assembly code. */
export const AssemblyRuleSchema = z.object({
  partId: KeySchema,
  at: z.enum(['section', 'joint', 'top', 'bottom', 'item']),
  sectionTypes: z.array(KeySchema).optional(),
  corners: z.array(CornerSchema).optional(),
  transform: z
    .object({
      rotDeg: Vec3Schema.optional(),
      offsetMm: Vec3Schema.optional(),
      mirrorX: z.boolean().optional(),
    })
    .optional(),
  when: ConditionSchema.optional(),
})
export type AssemblyRule = z.infer<typeof AssemblyRuleSchema>

// ---------------------------------------------------------------------------------------------
// Frames

export const SectionTypeSchema = z.object({
  id: KeySchema,
  label: z.string().min(1),
  /** Fixed height, or a range the user picks from (stored on the plan section). */
  heightU: z.union([
    z.number().int().positive(),
    z.object({ min: z.number().int().positive(), max: z.number().int().positive() }),
  ]),
})
export type SectionType = z.infer<typeof SectionTypeSchema>

export const PerHoleSchema = z.enum(['screw', 'screw+nut', 'screw+cage-nut'])
export type PerHole = z.infer<typeof PerHoleSchema>

export const FrameSchema = z.object({
  kind: z.literal('frame'),
  id: IdSchema,
  name: z.string().min(1),
  /** Required for curated entries (see `checkEntryIntegrity`); a user's own design may have none. */
  source: SourceSchema.optional(),
  verified: VerifiedSchema,
  standard: z.object({
    panelWidthMm: MmSchema,
    innerWidthMm: MmSchema,
    depthMm: MmSchema,
    rearOpen: z.boolean(),
  }),
  rail: z.object({
    earSpacingMm: MmSchema,
    /** Hole centres within each U, from the bottom of that U. */
    holeOffsetsPerUMm: z.array(z.number().nonnegative()).min(1),
    holeTolMm: z.number().nonnegative(),
  }),
  equipmentFastener: z.object({
    thread: ThreadSchema,
    perHole: PerHoleSchema,
    /** Stock screw hardware ids, any order; the BOM picks the shortest that is long enough. */
    screwIds: z.array(IdSchema),
    /** Thread engagement needed beyond the ear thickness. */
    engagementMm: z.number().nonnegative(),
    nutId: IdSchema.optional(),
  }),
  sectionTypes: z.array(SectionTypeSchema).min(1),
  stack: z.object({
    minU: z.number().int().positive(),
    maxU: z.number().int().positive(),
    joint: z
      .object({
        gapMm: z.number().nonnegative(),
        /** Sixths at each joint where nothing can mount. */
        deadSixths: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  options: z.array(OptionSchema).default(() => []),
  prints: z.array(PrintGroupSchema).default(() => []),
  recipe: z.array(RecipeLineSchema).default(() => []),
  parts3d: z.array(Part3DSchema).optional(),
  assembly3d: z.array(AssemblyRuleSchema).optional(),
})
export type Frame = z.infer<typeof FrameSchema>

// ---------------------------------------------------------------------------------------------
// Devices

export const DeviceCategorySchema = z.enum([
  'mini-pc',
  'sbc',
  'nas',
  'drive',
  'switch',
  'router',
  'gateway',
  'pdu',
  'ups',
  'power-brick',
  'kvm',
  'patch-panel',
  'other',
])
export type DeviceCategory = z.infer<typeof DeviceCategorySchema>

export const PowerInputKindSchema = z.enum(['ac', 'usb-c-pd', 'poe', 'dc', 'none'])
export type PowerInputKind = z.infer<typeof PowerInputKindSchema>

/** How a brick plugs in: IEC C5/C7/C13 cord, or straight into the wall (takes 2 outlets). */
export const PlugSchema = z.enum(['c5', 'c7', 'c13', 'wall'])
export type Plug = z.infer<typeof PlugSchema>

export const PowerOutputSchema = z.object({
  kind: z.enum(['ac', 'poe', 'usb-c', 'dc']),
  count: z.number().int().positive(),
  maxWEach: z.number().nonnegative().optional(),
  budgetW: z.number().nonnegative().optional(),
  batteryBacked: z.boolean().optional(),
})
export type PowerOutput = z.infer<typeof PowerOutputSchema>

export const DevicePowerSchema = z.object({
  typW: z.number().nonnegative().optional(),
  maxW: z.number().nonnegative().optional(),
  input: z.object({
    kind: PowerInputKindSchema,
    connector: z.string().min(1).optional(),
    brick: z
      .object({
        dims: DimsSchema.optional(),
        outputW: z.number().positive().optional(),
        /** Ships with the device: a derived accessory, never on the shopping list. */
        included: z.boolean(),
        plug: PlugSchema.optional(),
      })
      .optional(),
  }),
  outputs: z.array(PowerOutputSchema).optional(),
})
export type DevicePower = z.infer<typeof DevicePowerSchema>

export const DeviceSchema = z.object({
  kind: z.literal('device'),
  id: IdSchema,
  brand: z.string().min(1),
  model: z.string().min(1),
  category: DeviceCategorySchema,
  dims: DimsSchema,
  weightG: z.number().positive().optional(),
  power: DevicePowerSchema.optional(),
  /** Ear-mounted 10" gear (PDUs, switches, patch panels) places directly without a mount item. */
  rackmount: z
    .object({
      heightSixths: z.number().int().positive(),
      face: FaceSchema,
      depthMm: MmSchema,
    })
    .optional(),
  source: SourceSchema.optional(),
  verified: VerifiedSchema,
})
export type Device = z.infer<typeof DeviceSchema>

/** What to call a device in labels and messages: brand and model ("Apple Mac mini M4"). */
export function deviceName(device: Pick<Device, 'brand' | 'model'>): string {
  return `${device.brand} ${device.model}`
}

// ---------------------------------------------------------------------------------------------
// Items (mounts, panels, shelves) and extras

export const SlotSchema = z.object({
  id: KeySchema,
  label: z.string().optional(),
  /** fixed: one device in a cradle; area: devices auto-pack left to right. */
  kind: z.enum(['fixed', 'area']),
  maxW: MmSchema,
  maxD: MmSchema,
  maxH: MmSchema.optional(),
  orientations: z
    .array(OrientationSchema)
    .min(1)
    .default((): Orientation[] => ['flat', 'flat-rotated']),
  accepts: z
    .object({
      categories: z.array(DeviceCategorySchema).optional(),
      deviceIds: z.array(IdSchema).optional(),
    })
    .optional(),
  /** Slot origin relative to the item origin (item bottom, left edge of the opening, rail front face). */
  layout: z.object({ xMm: z.number(), yMm: z.number(), zMm: z.number() }),
})
export type Slot = z.infer<typeof SlotSchema>

export const MountSchema = z.object({
  /** Screw holes on the front ears (see `defaultMountHoles`). */
  front: z.number().int().nonnegative(),
  rear: z.number().int().nonnegative().default(0),
  /** Hole centres from the item's bottom edge, in mm. Missing -> whole-U positions only. */
  holeOffsetsMm: z.array(z.number().nonnegative()).optional(),
  /** Vertical slot length when the ear holes are slotted. */
  slotLengthMm: z.number().nonnegative().optional(),
  clearance: ThreadSchema.optional(),
  earThicknessMm: MmSchema.optional(),
})
export type Mount = z.infer<typeof MountSchema>

export const RenderStyleSchema = z.enum([
  'blank',
  'vent',
  'keystone',
  'shelf',
  'tray',
  'device',
  'fan',
  'power',
  'other',
])
export type RenderStyle = z.infer<typeof RenderStyleSchema>

export const ItemKindSchema = z.enum(['item', 'extra'])
export type ItemKind = z.infer<typeof ItemKindSchema>

export const BaySchema = z.enum(['full', 'half'])
export type Bay = z.infer<typeof BaySchema>

/** A placeable mount/panel/shelf (`item`), or a non-U accessory (`extra`, heightSixths 0). */
export const ItemSchema = z.object({
  kind: ItemKindSchema,
  id: IdSchema,
  name: z.string().min(1),
  category: z.string().min(1),
  /** Required for curated entries (see `checkEntryIntegrity`); a user's own design may have none. */
  source: SourceSchema.optional(),
  verified: VerifiedSchema,
  heightSixths: z.number().int().nonnegative(),
  faces: z
    .array(FaceSchema)
    .min(1)
    .default((): Face[] => ['front']),
  bay: BaySchema.default('full'),
  depthMm: z.number().nonnegative(),
  options: z.array(OptionSchema).default(() => []),
  prints: z.array(PrintGroupSchema).default(() => []),
  recipe: z.array(RecipeLineSchema).default(() => []),
  // Extras do not mount; items must declare their holes (checkEntryIntegrity enforces it).
  mount: MountSchema.default(() => ({ front: 0, rear: 0 })),
  slots: z.array(SlotSchema).default(() => []),
  requiresRearSupport: z.boolean().optional(),
  compat: z
    .object({
      frames: z.array(IdSchema).optional(),
      notes: z.string().optional(),
    })
    .optional(),
  render: z
    .object({
      style: RenderStyleSchema,
      // Hex only: the value lands in SVG/3D styling.
      color: z
        .string()
        .regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i)
        .optional(),
    })
    .optional(),
  parts3d: z.array(Part3DSchema).optional(),
})
export type Item = z.infer<typeof ItemSchema>

/** Default screw holes per face: 2 for ½U-or-less or half-bay items, otherwise 4. */
export function defaultMountHoles(heightSixths: number, bay: Bay): number {
  return heightSixths <= 3 || bay === 'half' ? 2 : 4
}

// ---------------------------------------------------------------------------------------------
// Catalog

export const CatalogEntrySchema = z.discriminatedUnion('kind', [
  FrameSchema,
  ItemSchema,
  DeviceSchema,
  HardwareSchema,
])
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>
export type CatalogKind = CatalogEntry['kind']

export interface CatalogBundle {
  frames: ReadonlyMap<string, Frame>
  /** Items and extras. */
  items: ReadonlyMap<string, Item>
  devices: ReadonlyMap<string, Device>
  hardware: ReadonlyMap<string, Hardware>
}

/** Read access to the catalog. Unknown ids return undefined (plans keep them as placeholders). */
export interface CatalogLookup {
  frame(id: string): Frame | undefined
  item(id: string): Item | undefined
  device(id: string): Device | undefined
  hardware(id: string): Hardware | undefined
  allFrames(): Frame[]
  allItems(): Item[]
  allDevices(): Device[]
  allHardware(): Hardware[]
}

/** The user's private entries (`custom:` ids), as stored in `plan.custom`. */
export interface CustomEntries {
  frames: readonly Frame[]
  items: readonly Item[]
  devices: readonly Device[]
  hardware: readonly Hardware[]
}

/** Groups entries by kind. A later entry with the same id replaces an earlier one. */
export function catalogBundle(entries: Iterable<CatalogEntry>): CatalogBundle {
  const frames = new Map<string, Frame>()
  const items = new Map<string, Item>()
  const devices = new Map<string, Device>()
  const hardware = new Map<string, Hardware>()
  for (const entry of entries) {
    switch (entry.kind) {
      case 'frame':
        frames.set(entry.id, entry)
        break
      case 'item':
      case 'extra':
        items.set(entry.id, entry)
        break
      case 'device':
        devices.set(entry.id, entry)
        break
      case 'hardware':
        hardware.set(entry.id, entry)
        break
    }
  }
  return { frames, items, devices, hardware }
}

export function createCatalogLookup(bundle: CatalogBundle): CatalogLookup {
  return {
    frame: (id) => bundle.frames.get(id),
    item: (id) => bundle.items.get(id),
    device: (id) => bundle.devices.get(id),
    hardware: (id) => bundle.hardware.get(id),
    allFrames: () => [...bundle.frames.values()],
    allItems: () => [...bundle.items.values()],
    allDevices: () => [...bundle.devices.values()],
    allHardware: () => [...bundle.hardware.values()],
  }
}

function overlayAll<T extends { id: string }>(overlay: ReadonlyMap<string, T>, base: T[]): T[] {
  return [...overlay.values(), ...base.filter((entry) => !overlay.has(entry.id))]
}

/**
 * Lookup that also resolves a plan's custom entries (they win on id clashes). Idempotent, so
 * domain entry points can apply it to whatever lookup they are given.
 */
export function withCustomEntries(base: CatalogLookup, custom: CustomEntries): CatalogLookup {
  const overlay = catalogBundle([
    ...custom.frames,
    ...custom.items,
    ...custom.devices,
    ...custom.hardware,
  ])
  const empty =
    overlay.frames.size + overlay.items.size + overlay.devices.size + overlay.hardware.size === 0
  if (empty) return base
  return {
    frame: (id) => overlay.frames.get(id) ?? base.frame(id),
    item: (id) => overlay.items.get(id) ?? base.item(id),
    device: (id) => overlay.devices.get(id) ?? base.device(id),
    hardware: (id) => overlay.hardware.get(id) ?? base.hardware(id),
    allFrames: () => overlayAll(overlay.frames, base.allFrames()),
    allItems: () => overlayAll(overlay.items, base.allItems()),
    allDevices: () => overlayAll(overlay.devices, base.allDevices()),
    allHardware: () => overlayAll(overlay.hardware, base.allHardware()),
  }
}
