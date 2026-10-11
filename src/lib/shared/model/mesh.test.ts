import { describe, expect, it } from 'vitest'
import { GrowableFloat32Array, GrowableUint32Array } from './growable'
import {
  analyzeIslands,
  appendTransformedMesh,
  computeBBox,
  measureMesh,
  VertexWelder,
} from './mesh'
import { boxMesh, cubeMesh, flipWinding, mergeMeshes, toIndexedMesh } from './testing/meshes'

describe('VertexWelder', () => {
  it('keeps distinct cells apart and merges repeats, across many rehashes', () => {
    const welder = new VertexWelder(1e-4, 16)
    const count = 50_000
    for (let i = 0; i < count; i++) expect(welder.add(i * 0.5, -i, i % 7)).toBe(i)
    for (let i = 0; i < count; i += 997) expect(welder.add(i * 0.5 + 1e-6, -i, i % 7)).toBe(i)
    expect(welder.vertexCount).toBe(count)
    expect(welder.positions().length).toBe(count * 3)
  })

  it('treats -0 and 0 as the same position', () => {
    const welder = new VertexWelder()
    expect(welder.add(0, 0, 0)).toBe(welder.add(-0, -0.00000001, 0))
  })
})

describe('measureMesh', () => {
  it('measures area and signed volume of closed boxes', () => {
    const { areaMm2, signedVolumeMm3 } = measureMesh(toIndexedMesh(boxMesh(2, 3, 4, [10, -5, 7])))
    expect(areaMm2).toBeCloseTo(2 * (6 + 8 + 12), 9)
    expect(signedVolumeMm3).toBeCloseTo(24, 9)
    expect(measureMesh(toIndexedMesh(flipWinding(boxMesh(2, 3, 4)))).signedVolumeMm3).toBeCloseTo(
      -24,
      9,
    )
  })
})

describe('appendTransformedMesh', () => {
  it('transforms vertices and flips winding under a mirror', () => {
    const positions = new GrowableFloat32Array()
    const indices = new GrowableUint32Array()
    const cube = toIndexedMesh(cubeMesh(1))
    appendTransformedMesh(positions, indices, cube, [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 0, 0])
    appendTransformedMesh(positions, indices, cube, [-1, 0, 0, 0, 1, 0, 0, 0, 1, -5, 0, 0])
    const mesh = { positions: positions.toArray(), indices: indices.toArray() }
    expect(computeBBox(mesh.positions)).toEqual({ min: [-6, 0, 0], max: [6, 1, 1] })
    expect(mesh.indices.slice(0, 3)).toEqual(Uint32Array.of(0, 2, 1))
    // The mirrored copy's first triangle: (0, 2, 1) offset by 8 vertices, winding reversed.
    expect(mesh.indices.slice(36, 39)).toEqual(Uint32Array.of(8, 9, 10))
    expect(measureMesh(mesh).signedVolumeMm3).toBeCloseTo(2, 9)
  })
})

describe('analyzeIslands', () => {
  it('separates pieces and recognises enclosed cavities by negative volume', () => {
    // A 20 mm block with a sealed 10 x 10 x 5 pocket inside (as for a magnet inserted mid-print),
    // plus a separate pin. The pocket's faces point into the void, so its volume is negative.
    const block = boxMesh(20, 20, 20)
    const pocket = flipWinding(boxMesh(10, 10, 5, [5, 5, 5]))
    const pin = cubeMesh(2, [40, 0, 0])
    const summary = analyzeIslands(toIndexedMesh(mergeMeshes(block, pocket, pin)))
    expect(summary.count).toBe(3)
    expect(summary.islands.map((island) => Math.round(island.signedVolumeMm3))).toEqual([
      8000, -500, 8,
    ])
    expect(summary.islands[1]?.bbox).toEqual({ min: [5, 5, 5], max: [15, 15, 10] })
    expect(summary.islands.every((island) => island.triangleCount === 12)).toBe(true)
  })

  it('groups faces that repeat vertices instead of sharing them', () => {
    const cube = cubeMesh(1)
    // Unshare every corner: each triangle gets its own three vertices.
    const positions: number[] = []
    for (const index of cube.indices)
      positions.push(...cube.positions.slice(index * 3, index * 3 + 3))
    const soup = {
      positions,
      indices: positions.map((_, i) => i).filter((i) => i < positions.length / 3),
    }
    expect(analyzeIslands(toIndexedMesh(soup)).count).toBe(1)
  })
})
