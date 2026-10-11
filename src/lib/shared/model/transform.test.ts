import { describe, expect, it } from 'vitest'
import {
  composeTransforms,
  describeTransform,
  determinant,
  IDENTITY_TRANSFORM,
  parseTransform,
  scaleTranslation,
  toColumnMajor4x4,
  transformPoint,
} from './transform'
import type { Transform3x4 } from './types'

const rotationZ = (degrees: number, tx = 0, ty = 0, tz = 0): Transform3x4 => {
  const c = Math.cos((degrees * Math.PI) / 180)
  const s = Math.sin((degrees * Math.PI) / 180)
  return [c, s, 0, -s, c, 0, 0, 0, 1, tx, ty, tz]
}

describe('transforms', () => {
  it('parses 12 numbers and rejects anything else', () => {
    expect(parseTransform('1 0 0 0 1 0 0 0 1 10 20 30')).toEqual([
      1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 20, 30,
    ])
    expect(parseTransform('1 0 0 0 1 0 0 0 1 10 20')).toBeUndefined()
    expect(parseTransform('1 0 0 0 1 0 0 0 1 10 20 x')).toBeUndefined()
  })

  it('applies row-vector transforms: rotation then translation', () => {
    const [x, y, z] = transformPoint(rotationZ(90, 5, 0, 1), 1, 0, 0)
    expect(x).toBeCloseTo(5, 12)
    expect(y).toBeCloseTo(1, 12)
    expect(z).toBe(1)
  })

  it('composes as "first, then"', () => {
    const first = rotationZ(90)
    const then: Transform3x4 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0]
    const combined = composeTransforms(first, then)
    const direct = transformPoint(then, ...transformPoint(first, 1, 2, 3))
    transformPoint(combined, 1, 2, 3).forEach((value, i) =>
      expect(value).toBeCloseTo(direct[i] ?? Number.NaN, 12),
    )
    expect(composeTransforms(IDENTITY_TRANSFORM, then)).toEqual(then)
  })

  it('reports determinant, mirroring and Z rotation', () => {
    expect(determinant([-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])).toBe(-1)
    const rotated = describeTransform(rotationZ(37, 467.2, 60, 5))
    expect(rotated.rotationZDeg).toBeCloseTo(37, 9)
    expect(rotated.translation).toEqual([467.2, 60, 5])
    expect(rotated.mirrored).toBe(false)
    expect(rotated.axisScale).toEqual([1, 1, 1])

    const mirror = describeTransform([-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])
    expect(mirror).toMatchObject({ mirrored: true, identity: false, determinant: -1 })
    expect(mirror.rotationZDeg).toBeUndefined()
    expect(describeTransform(IDENTITY_TRANSFORM)).toMatchObject({ identity: true, rotationZDeg: 0 })
    expect(describeTransform([1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0]).rotationZDeg).toBeUndefined()
  })

  it('scales only the translation between units', () => {
    expect(scaleTranslation([2, 0, 0, 0, 2, 0, 0, 0, 2, 1, 2, 3], 25.4)).toEqual([
      2, 0, 0, 0, 2, 0, 0, 0, 2, 25.4, 50.8, 76.19999999999999,
    ])
  })

  it('maps to a column-major 4x4 for three.js', () => {
    expect(toColumnMajor4x4([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toEqual([
      1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 1,
    ])
  })
})
