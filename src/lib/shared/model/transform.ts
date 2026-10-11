/**
 * 3MF affine transforms (row-vector convention, see Transform3x4): parsing, composition and the
 * facts the structure report prints (translation, mirroring, rotation about Z).
 */

import { parseNumberList, roundTo } from './numbers'
import type { Transform3x4, Vec3 } from './types'

export const IDENTITY_TRANSFORM: Transform3x4 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

const EPSILON = 1e-9

export function toTransform(values: readonly number[]): Transform3x4 | undefined {
  if (values.length !== 12 || !values.every(Number.isFinite)) return undefined
  const v = (i: number): number => values[i] ?? 0
  return [v(0), v(1), v(2), v(3), v(4), v(5), v(6), v(7), v(8), v(9), v(10), v(11)]
}

/** Parses a `transform` attribute: 12 numbers. Undefined when malformed. */
export function parseTransform(text: string): Transform3x4 | undefined {
  const values = parseNumberList(text)
  return values ? toTransform(values) : undefined
}

/** The transform that applies `first`, then `then` (p × first × then). */
export function composeTransforms(first: Transform3x4, then: Transform3x4): Transform3x4 {
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22, a30, a31, a32] = first
  const [b00, b01, b02, b10, b11, b12, b20, b21, b22, b30, b31, b32] = then
  return [
    a00 * b00 + a01 * b10 + a02 * b20,
    a00 * b01 + a01 * b11 + a02 * b21,
    a00 * b02 + a01 * b12 + a02 * b22,
    a10 * b00 + a11 * b10 + a12 * b20,
    a10 * b01 + a11 * b11 + a12 * b21,
    a10 * b02 + a11 * b12 + a12 * b22,
    a20 * b00 + a21 * b10 + a22 * b20,
    a20 * b01 + a21 * b11 + a22 * b21,
    a20 * b02 + a21 * b12 + a22 * b22,
    a30 * b00 + a31 * b10 + a32 * b20 + b30,
    a30 * b01 + a31 * b11 + a32 * b21 + b31,
    a30 * b02 + a31 * b12 + a32 * b22 + b32,
  ]
}

/** Determinant of the linear part. Negative means the transform mirrors (winding must flip). */
export function determinant(t: Transform3x4): number {
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = t
  return (
    a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20)
  )
}

export function transformPoint(t: Transform3x4, x: number, y: number, z: number): Vec3 {
  return [
    x * t[0] + y * t[3] + z * t[6] + t[9],
    x * t[1] + y * t[4] + z * t[7] + t[10],
    x * t[2] + y * t[5] + z * t[8] + t[11],
  ]
}

/** Converts the translation to another unit; the linear part is unitless. */
export function scaleTranslation(t: Transform3x4, factor: number): Transform3x4 {
  if (factor === 1) return t
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22, tx, ty, tz] = t
  return [a00, a01, a02, a10, a11, a12, a20, a21, a22, tx * factor, ty * factor, tz * factor]
}

export function isIdentityTransform(t: Transform3x4, epsilon = EPSILON): boolean {
  return t.every((value, i) => Math.abs(value - (IDENTITY_TRANSFORM[i] ?? 0)) <= epsilon)
}

/** Column-major 4x4 (three.js Matrix4.fromArray order). The row-vector 3MF layout maps straight in. */
export function toColumnMajor4x4(t: Transform3x4): number[] {
  return [t[0], t[1], t[2], 0, t[3], t[4], t[5], 0, t[6], t[7], t[8], 0, t[9], t[10], t[11], 1]
}

export interface TransformSummary {
  identity: boolean
  translation: Vec3
  determinant: number
  mirrored: boolean
  /** Length of each transformed axis (1 for rotations and mirrors). */
  axisScale: Vec3
  /** Set when the linear part only rotates about Z (Z kept or flipped): the usual plate placement. */
  rotationZDeg?: number
}

function near(a: number, b: number, tolerance = 1e-6): boolean {
  return Math.abs(a - b) <= tolerance
}

/** Facts about a transform for reports, rounded for readability. */
export function describeTransform(t: Transform3x4): TransformSummary {
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22, tx, ty, tz] = t
  const det = determinant(t)
  const summary: TransformSummary = {
    identity: isIdentityTransform(t, 1e-7),
    translation: [roundTo(tx, 4), roundTo(ty, 4), roundTo(tz, 4)],
    determinant: roundTo(det, 6),
    mirrored: det < 0,
    axisScale: [
      roundTo(Math.hypot(a00, a01, a02), 6),
      roundTo(Math.hypot(a10, a11, a12), 6),
      roundTo(Math.hypot(a20, a21, a22), 6),
    ],
  }
  // Rotation by θ about Z: m00 = m11 = cos θ, m01 = -m10 = sin θ, Z axis kept (or flipped).
  const keepsZ =
    near(a02, 0) && near(a12, 0) && near(a20, 0) && near(a21, 0) && near(Math.abs(a22), 1)
  const rotatesXY = near(a00, a11) && near(a01, -a10) && near(Math.hypot(a00, a01), 1)
  if (keepsZ && rotatesXY) summary.rotationZDeg = roundTo((Math.atan2(a01, a00) * 180) / Math.PI, 4)
  return summary
}
