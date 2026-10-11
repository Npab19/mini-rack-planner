/**
 * Synthetic meshes for tests and fixtures. Model files are never committed: every fixture is built
 * in code from these.
 */

import type { IndexedMesh, Vec3 } from '../types'

export interface TestMesh {
  /** Three numbers per vertex. */
  positions: number[]
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  indices: number[]
}

/**
 * Axis-aligned box from `origin` to `origin + size`: 8 vertices and 12 triangles with outward
 * normals, so its signed volume is positive.
 */
export function boxMesh(sx: number, sy: number, sz: number, origin: Vec3 = [0, 0, 0]): TestMesh {
  const [ox, oy, oz] = origin
  const positions = [
    [0, 0, 0],
    [sx, 0, 0],
    [sx, sy, 0],
    [0, sy, 0],
    [0, 0, sz],
    [sx, 0, sz],
    [sx, sy, sz],
    [0, sy, sz],
  ].flatMap(([x = 0, y = 0, z = 0]) => [ox + x, oy + y, oz + z])
  const indices = [
    [0, 2, 1],
    [0, 3, 2], // bottom (-z)
    [4, 5, 6],
    [4, 6, 7], // top (+z)
    [0, 1, 5],
    [0, 5, 4], // front (-y)
    [3, 7, 6],
    [3, 6, 2], // back (+y)
    [0, 4, 7],
    [0, 7, 3], // left (-x)
    [1, 2, 6],
    [1, 6, 5], // right (+x)
  ].flat()
  return { positions, indices }
}

export function cubeMesh(size = 10, origin: Vec3 = [0, 0, 0]): TestMesh {
  return boxMesh(size, size, size, origin)
}

/** A 254 x 88 x 4 mm plate: the footprint of a 2U blank for a 10" rack. */
export function panelMesh(): TestMesh {
  return boxMesh(254, 88, 4)
}

/** Concatenates meshes into one (separate islands unless they share positions). */
export function mergeMeshes(...meshes: TestMesh[]): TestMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const mesh of meshes) {
    const base = positions.length / 3
    positions.push(...mesh.positions)
    for (const index of mesh.indices) indices.push(index + base)
  }
  return { positions, indices }
}

/** Reverses every triangle's winding (an inside-out mesh, as a cavity would be). */
export function flipWinding(mesh: TestMesh): TestMesh {
  const indices: number[] = []
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    indices.push(mesh.indices[i] ?? 0, mesh.indices[i + 2] ?? 0, mesh.indices[i + 1] ?? 0)
  }
  return { positions: [...mesh.positions], indices }
}

export interface GridMesh {
  positions: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
}

/**
 * A gently curved height field of cells x cells quads, two triangles each: 500 cells gives
 * 500,000 triangles. Typed arrays, because performance tests build very large ones.
 */
export function gridMesh(cells: number, cellMm = 0.5): GridMesh {
  const side = cells + 1
  const positions = new Float32Array(side * side * 3)
  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const at = (row * side + col) * 3
      positions[at] = col * cellMm
      positions[at + 1] = row * cellMm
      positions[at + 2] = 2 * Math.sin(col / 17) * Math.cos(row / 23)
    }
  }
  const indices = new Uint32Array(cells * cells * 6)
  let cursor = 0
  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < cells; col++) {
      const a = row * side + col
      const c = a + side
      indices.set([a, a + 1, c + 1, a, c + 1, c], cursor)
      cursor += 6
    }
  }
  return { positions, indices }
}

export function toIndexedMesh(mesh: TestMesh): IndexedMesh {
  return { positions: Float32Array.from(mesh.positions), indices: Uint32Array.from(mesh.indices) }
}

/** Applies a 3MF-order transform (row vectors) to every vertex; mirrors keep their winding. */
export function transformMesh(mesh: TestMesh, t: readonly number[]): TestMesh {
  const m = (i: number): number => t[i] ?? 0
  const positions: number[] = []
  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    const x = mesh.positions[i] ?? 0
    const y = mesh.positions[i + 1] ?? 0
    const z = mesh.positions[i + 2] ?? 0
    positions.push(
      x * m(0) + y * m(3) + z * m(6) + m(9),
      x * m(1) + y * m(4) + z * m(7) + m(10),
      x * m(2) + y * m(5) + z * m(8) + m(11),
    )
  }
  return { positions, indices: [...mesh.indices] }
}
