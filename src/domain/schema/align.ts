import { z } from 'zod'
import { IdSchema, Vec3Schema, type Vec3 } from './common'

export const ALIGN_SCHEMA = 'mrp.align/1'

/** A signed axis of the mesh's reference frame ("+x", "-z", ...). */
export const SignedAxisSchema = z.enum(['+x', '-x', '+y', '-y', '+z', '-z'])
export type SignedAxis = z.infer<typeof SignedAxisSchema>

/** Which point of a bounding box, per axis. */
export const AxisAnchorSchema = z.enum(['min', 'mid', 'max'])
export type AxisAnchor = z.infer<typeof AxisAnchorSchema>

/** A bounding-box point, per X/Y/Z: e.g. ['mid', 'min', 'max'] = centred, bottom, front. */
export const AnchorSchema = z.tuple([AxisAnchorSchema, AxisAnchorSchema, AxisAnchorSchema])
export type Anchor = z.infer<typeof AnchorSchema>

/** Geometry fingerprint computed in the mesh's object-local frame (after PCA pre-alignment). */
export const MeshSignatureSchema = z.object({
  tri: z.number().int().nonnegative(),
  areaMm2: z.number().nonnegative(),
  volMm3: z.number(),
  extMm: Vec3Schema,
})
export type MeshSignature = z.infer<typeof MeshSignatureSchema>

export const AlignPoseSchema = z
  .object({
    /** Mesh axes that map onto the part's +X, +Y, +Z: a signed permutation. */
    basis: z.tuple([SignedAxisSchema, SignedAxisSchema, SignedAxisSchema]),
    /** Extra rotation after `basis`, as [x, y, z, w]. */
    fineQuat: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    mirrorX: z.boolean().default(false),
    /** The mesh point that lands on the slot (part envelope) point. */
    anchor: z.object({ mesh: AnchorSchema, slot: AnchorSchema }),
    offsetMm: Vec3Schema.default((): Vec3 => [0, 0, 0]),
  })
  .superRefine((pose, ctx) => {
    const axes = new Set(pose.basis.map((axis) => axis.slice(1)))
    if (axes.size !== 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['basis'],
        message: 'basis must use x, y and z once each',
      })
    }
  })
export type AlignPose = z.infer<typeof AlignPoseSchema>

/** How a user's mesh file maps onto a catalog part (curated in the catalog or made by the user). */
export const AlignRecordSchema = z.object({
  schema: z.literal(ALIGN_SCHEMA),
  /** Required for curated files under catalog/alignments (filename = id). */
  id: IdSchema.optional(),
  /** `<entry id>/<part id>`, see `partKey` in ids.ts. */
  catalogPartId: z.string().min(1),
  match: z.object({
    fileSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    geomKey: z.string().min(1).optional(),
    sig: MeshSignatureSchema.optional(),
    nameHints: z.array(z.string().min(1)).optional(),
  }),
  pose: AlignPoseSchema,
  provenance: z.object({
    method: z.enum(['auto', 'user', 'curated']),
    conf: z.number().min(0).max(1).optional(),
    appVersion: z.string().optional(),
  }),
})
export type AlignRecord = z.infer<typeof AlignRecordSchema>
