import { z } from 'zod'
import { KEBAB_PATTERN } from '../ids'

/** Prefix of the user's private catalog entries (a plan's `custom` entries, the library). */
export const CUSTOM_ID_PREFIX = 'custom:'

export function isCustomId(id: string): boolean {
  return id.startsWith(CUSTOM_ID_PREFIX)
}

/**
 * Immutable id of a catalog entry or a plan entity: kebab-case, with a `custom:` prefix for the
 * user's private parts. Catalog ids are deprecated (never removed or renamed).
 */
export const IdSchema = z
  .string()
  .max(100)
  .regex(
    new RegExp(`^(?:${CUSTOM_ID_PREFIX})?${KEBAB_PATTERN}$`),
    `Use kebab-case (a-z, 0-9, -), optionally prefixed with "${CUSTOM_ID_PREFIX}"`,
  )

/** Id local to one catalog entry: options, choices, prints, recipe lines, section types, slots, 3D parts. */
export const KeySchema = z
  .string()
  .max(100)
  .regex(new RegExp(`^${KEBAB_PATTERN}$`), 'Use kebab-case (a-z, 0-9, -)')

/** Positive millimetres. */
export const MmSchema = z.number().positive()

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()])
export type Vec3 = z.infer<typeof Vec3Schema>

export const PlatformSchema = z.enum([
  'makerworld',
  'printables',
  'thingiverse',
  'github',
  'vendor',
  'other',
])
export type Platform = z.infer<typeof PlatformSchema>

/** Where a design lives. The app only links to it: it never fetches from these hosts. */
export const SourceSchema = z.object({
  platform: PlatformSchema,
  // http(s) only: these URLs end up in links, so javascript:/data: must never get through.
  url: z.url({ protocol: /^https?$/ }).max(2048),
  modelId: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  designer: z.string().min(1).optional(),
  /** Licence label exactly as the source page shows it (e.g. "Standard Digital File License"). */
  license: z.string().min(1).optional(),
})
export type Source = z.infer<typeof SourceSchema>

export const VerifyMethodSchema = z.enum([
  'page',
  'user-files',
  'calipers',
  'vendor-spec',
  'unverified',
])
export type VerifyMethod = z.infer<typeof VerifyMethodSchema>

export const VerifiedSchema = z.object({
  by: z.string().min(1),
  /** YYYY-MM-DD */
  date: z.iso.date(),
  method: VerifyMethodSchema,
  note: z.string().optional(),
})
export type Verified = z.infer<typeof VerifiedSchema>

/** Outer dimensions in mm: w along X, d along Z (depth), h along Y, as the thing normally sits. */
export const DimsSchema = z.object({ w: MmSchema, d: MmSchema, h: MmSchema })
export type Dims = z.infer<typeof DimsSchema>

/** Fastener threads used to mount rack equipment. */
export const ThreadSchema = z.enum(['M3', 'M4', 'M5', 'M6', '10-32', '12-24'])
export type Thread = z.infer<typeof ThreadSchema>

export const FaceSchema = z.enum(['front', 'rear'])
export type Face = z.infer<typeof FaceSchema>

export const OrientationSchema = z.enum(['flat', 'flat-rotated', 'on-side', 'upright'])
export type Orientation = z.infer<typeof OrientationSchema>

// ---------------------------------------------------------------------------------------------
// Option values

export const OptionValueSchema = z.union([z.string(), z.boolean(), z.number()])
export type OptionValue = z.infer<typeof OptionValueSchema>

/** Chosen option values keyed by option id. */
export const OptionValuesSchema = z.record(z.string(), OptionValueSchema)
export type OptionValues = z.infer<typeof OptionValuesSchema>

// ---------------------------------------------------------------------------------------------
// Quantities

const CountSchema = z.number().nonnegative()

export const JointFilterSchema = z.strictObject({
  /** A joint counts only when neither neighbouring section has one of these section types. */
  notAdjacentTo: z.array(KeySchema).optional(),
})
export type JointFilter = z.infer<typeof JointFilterSchema>

/** A quantity formula; every term is optional and they add up. See `evaluateQty`. */
export const QtyObjectSchema = z.strictObject({
  base: CountSchema.optional(),
  perU: CountSchema.optional(),
  /** Keyed by section type id. */
  perSection: z.record(KeySchema, CountSchema).optional(),
  perSectionAny: CountSchema.optional(),
  perJoint: CountSchema.optional(),
  jointFilter: JointFilterSchema.optional(),
})
export type QtyObject = z.infer<typeof QtyObjectSchema>

export const QtySchema = z.union([CountSchema, QtyObjectSchema])
export type Qty = z.infer<typeof QtySchema>

/** Cut length of a cut-to-length item (extrusion, rail): base + perU × U, in mm. */
export const LengthSchema = z.strictObject({
  base: z.number().default(0),
  perU: z.number().default(0),
})
export type Length = z.infer<typeof LengthSchema>

// ---------------------------------------------------------------------------------------------
// Conditions (recursive)

export type OptionMatch = OptionValue | OptionValue[]

export interface StackCondition {
  minU?: number | undefined
  maxU?: number | undefined
  minSections?: number | undefined
  maxSections?: number | undefined
  /** Type id of the top-most section. */
  topTypeId?: string | undefined
  /** Type id of the bottom-most section. */
  bottomTypeId?: string | undefined
}

/**
 * When a recipe line, embed or assembly rule applies.
 * - `option`: every listed option equals the value, or is one of the values when given an array.
 * - `stack`: whole-stack facts (height, section count, top/bottom section type).
 * - `all` / `any` / `not`: combinators.
 */
export type Condition =
  | { option: Record<string, OptionMatch> }
  | { stack: StackCondition }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }

export const OptionMatchSchema = z.union([OptionValueSchema, z.array(OptionValueSchema)])

export const StackConditionSchema = z.strictObject({
  minU: z.number().nonnegative().optional(),
  maxU: z.number().nonnegative().optional(),
  minSections: z.number().int().nonnegative().optional(),
  maxSections: z.number().int().nonnegative().optional(),
  topTypeId: KeySchema.optional(),
  bottomTypeId: KeySchema.optional(),
})

// Strict objects: each condition has exactly one key, so `{ option, stack }` is rejected instead
// of silently dropping `stack`.
export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ option: z.record(KeySchema, OptionMatchSchema) }),
    z.strictObject({ stack: StackConditionSchema }),
    z.strictObject({ all: z.array(ConditionSchema) }),
    z.strictObject({ any: z.array(ConditionSchema) }),
    z.strictObject({ not: ConditionSchema }),
  ]),
)
