/**
 * Geometry helpers on indexed meshes in millimetres: bounds, vertex welding, transformed appends,
 * surface/volume measures and connected pieces ("islands").
 */

import { GrowableFloat32Array, GrowableUint32Array } from './growable'
import { determinant } from './transform'
import type { BBox, IndexedMesh, Transform3x4 } from './types'

/** Default weld tolerance: well below print resolution, well above float32 noise at rack scale. */
export const DEFAULT_WELD_TOLERANCE_MM = 1e-4

/** Running min/max over points. */
export class BoundsBuilder {
  minX = Infinity
  minY = Infinity
  minZ = Infinity
  maxX = -Infinity
  maxY = -Infinity
  maxZ = -Infinity

  add(x: number, y: number, z: number): void {
    if (x < this.minX) this.minX = x
    if (x > this.maxX) this.maxX = x
    if (y < this.minY) this.minY = y
    if (y > this.maxY) this.maxY = y
    if (z < this.minZ) this.minZ = z
    if (z > this.maxZ) this.maxZ = z
  }

  build(): BBox | undefined {
    if (this.minX > this.maxX) return undefined
    return { min: [this.minX, this.minY, this.minZ], max: [this.maxX, this.maxY, this.maxZ] }
  }
}

/** Bounds of every vertex; undefined for an empty mesh. */
export function computeBBox(positions: Float32Array): BBox | undefined {
  const bounds = new BoundsBuilder()
  for (let i = 0; i + 2 < positions.length; i += 3) {
    bounds.add(positions[i]!, positions[i + 1]!, positions[i + 2]!)
  }
  return bounds.build()
}

export function bboxSize(bbox: BBox): [number, number, number] {
  return [bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]]
}

export function scaleBBox(bbox: BBox, factor: number): BBox {
  const [x0, y0, z0] = bbox.min
  const [x1, y1, z1] = bbox.max
  return {
    min: [x0 * factor, y0 * factor, z0 * factor],
    max: [x1 * factor, y1 * factor, z1 * factor],
  }
}

function hashCell(x: number, y: number, z: number): number {
  // `| 0` may wrap huge cells; that only costs a collision, equality is checked on full values.
  let h = Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca77) ^ Math.imul(z | 0, 0xc2b2ae3d)
  h ^= h >>> 15
  return Math.imul(h, 0x2c1b3c6d)
}

function tableSizeFor(vertices: number): number {
  let size = 1024
  while (size < vertices * 2) size *= 2
  return size
}

/**
 * Merges vertices that fall in the same cell of a grid with `toleranceMm` spacing. The first vertex
 * seen in a cell keeps its exact coordinates. Open addressing over typed arrays: millions of
 * vertices without an object or a string per vertex.
 */
export class VertexWelder {
  private readonly inverseCell: number
  private readonly output: GrowableFloat32Array
  private cells: Float64Array
  private table: Int32Array
  private count = 0

  constructor(toleranceMm = DEFAULT_WELD_TOLERANCE_MM, expectedVertices = 1024) {
    this.inverseCell = 1 / toleranceMm
    const capacity = Math.max(1024, Math.ceil(expectedVertices))
    this.output = new GrowableFloat32Array(capacity * 3)
    this.cells = new Float64Array(capacity * 3)
    this.table = new Int32Array(tableSizeFor(capacity))
  }

  get vertexCount(): number {
    return this.count
  }

  /** Index of the welded vertex at (x, y, z), adding it when its cell is new. */
  add(x: number, y: number, z: number): number {
    const cx = Math.round(x * this.inverseCell)
    const cy = Math.round(y * this.inverseCell)
    const cz = Math.round(z * this.inverseCell)
    const mask = this.table.length - 1
    let slot = hashCell(cx, cy, cz) & mask
    for (;;) {
      const stored = this.table[slot]!
      if (stored === 0) break
      const at = (stored - 1) * 3
      if (this.cells[at] === cx && this.cells[at + 1] === cy && this.cells[at + 2] === cz)
        return stored - 1
      slot = (slot + 1) & mask
    }
    const index = this.count++
    if (index * 3 + 3 > this.cells.length) this.growCells()
    this.cells[index * 3] = cx
    this.cells[index * 3 + 1] = cy
    this.cells[index * 3 + 2] = cz
    this.output.push3(x, y, z)
    this.table[slot] = index + 1
    if (this.count * 2 > this.table.length) this.rehash()
    return index
  }

  positions(): Float32Array<ArrayBuffer> {
    return this.output.toArray()
  }

  private growCells(): void {
    const next = new Float64Array(this.cells.length * 2)
    next.set(this.cells)
    this.cells = next
  }

  private rehash(): void {
    const table = new Int32Array(this.table.length * 2)
    const mask = table.length - 1
    for (let index = 0; index < this.count; index++) {
      const at = index * 3
      let slot = hashCell(this.cells[at]!, this.cells[at + 1]!, this.cells[at + 2]!) & mask
      while (table[slot] !== 0) slot = (slot + 1) & mask
      table[slot] = index + 1
    }
    this.table = table
  }
}

/** Welds a triangle soup (9 floats per triangle, as in STL) into an indexed mesh. */
export function weldTriangleSoup(
  soup: Float32Array,
  toleranceMm = DEFAULT_WELD_TOLERANCE_MM,
): { positions: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const cornerCount = Math.floor(soup.length / 3)
  // Closed meshes have about half as many vertices as triangles, a sixth of the corners.
  const welder = new VertexWelder(toleranceMm, cornerCount / 6)
  const indices = new Uint32Array(cornerCount)
  for (let corner = 0; corner < cornerCount; corner++) {
    const at = corner * 3
    indices[corner] = welder.add(soup[at]!, soup[at + 1]!, soup[at + 2]!)
  }
  return { positions: welder.positions(), indices }
}

/**
 * Appends `mesh` transformed by `t` to growable buffers. A mirroring transform (determinant < 0)
 * would turn every face inside out, so the winding is reversed to keep normals pointing outward.
 */
export function appendTransformedMesh(
  positions: GrowableFloat32Array,
  indices: GrowableUint32Array,
  mesh: IndexedMesh,
  t: Transform3x4,
): void {
  const base = positions.length / 3
  const source = mesh.positions
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22, tx, ty, tz] = t
  for (let i = 0; i + 2 < source.length; i += 3) {
    const x = source[i]!
    const y = source[i + 1]!
    const z = source[i + 2]!
    positions.push3(
      x * a00 + y * a10 + z * a20 + tx,
      x * a01 + y * a11 + z * a21 + ty,
      x * a02 + y * a12 + z * a22 + tz,
    )
  }
  const flip = determinant(t) < 0
  const triangles = mesh.indices
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const a = triangles[i]! + base
    const b = triangles[i + 1]! + base
    const c = triangles[i + 2]! + base
    if (flip) indices.push3(a, c, b)
    else indices.push3(a, b, c)
  }
}

/** The triangles for which `keep` is true, with only the vertices they use. */
export function selectTriangles(
  mesh: IndexedMesh,
  keep: (triangle: number) => boolean,
): { positions: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const source = mesh.positions
  const remap = new Int32Array(Math.floor(source.length / 3)).fill(-1)
  const positions = new GrowableFloat32Array()
  const indices = new GrowableUint32Array()
  const vertexFor = (vertex: number): number => {
    let mapped = remap[vertex]!
    if (mapped < 0) {
      mapped = positions.length / 3
      remap[vertex] = mapped
      positions.push3(source[vertex * 3]!, source[vertex * 3 + 1]!, source[vertex * 3 + 2]!)
    }
    return mapped
  }
  for (let t = 0; t * 3 + 2 < mesh.indices.length; t++) {
    if (!keep(t)) continue
    const a = vertexFor(mesh.indices[t * 3]!)
    const b = vertexFor(mesh.indices[t * 3 + 1]!)
    const c = vertexFor(mesh.indices[t * 3 + 2]!)
    indices.push3(a, b, c)
  }
  return { positions: positions.toArray(), indices: indices.toArray() }
}

export interface MeshMeasures {
  areaMm2: number
  /** Positive for closed meshes with outward normals. */
  signedVolumeMm3: number
}

/** Surface area and signed volume (divergence theorem; exact for closed meshes). */
export function measureMesh(mesh: IndexedMesh): MeshMeasures {
  const p = mesh.positions
  const idx = mesh.indices
  let area = 0
  let volume = 0
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i]! * 3
    const b = idx[i + 1]! * 3
    const c = idx[i + 2]! * 3
    const ax = p[a]!
    const ay = p[a + 1]!
    const az = p[a + 2]!
    const ux = p[b]! - ax
    const uy = p[b + 1]! - ay
    const uz = p[b + 2]! - az
    const vx = p[c]! - ax
    const vy = p[c + 1]! - ay
    const vz = p[c + 2]! - az
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    area += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2
    // a · (b × c) equals a · (u × v) for b = a + u and c = a + v.
    volume += (ax * nx + ay * ny + az * nz) / 6
  }
  return { areaMm2: area, signedVolumeMm3: volume }
}

export interface IslandInfo {
  triangleCount: number
  bbox: BBox
  areaMm2: number
  /** Negative for an enclosed cavity (normals facing into the void), e.g. a magnet pocket. */
  signedVolumeMm3: number
}

export interface IslandSummary {
  count: number
  /** Largest |volume| first; equal volumes by lowest min corner. */
  islands: IslandInfo[]
}

function compareIslands(a: IslandInfo, b: IslandInfo): number {
  const va = Math.abs(a.signedVolumeMm3)
  const vb = Math.abs(b.signedVolumeMm3)
  // Volumes equal up to float noise count as ties, so the order does not depend on summation order.
  if (Math.abs(va - vb) > 1e-9 * Math.max(va, vb, 1)) return vb - va
  for (let axis = 0; axis < 3; axis++) {
    const difference = (a.bbox.min[axis] ?? 0) - (b.bbox.min[axis] ?? 0)
    if (difference !== 0) return difference
  }
  return b.triangleCount - a.triangleCount
}

function findRoot(parent: Int32Array, start: number): number {
  let node = start
  while (parent[node] !== node) {
    const grandparent = parent[parent[node]!]!
    parent[node] = grandparent // path halving
    node = grandparent
  }
  return node
}

/** Union-find over welded vertex positions; returns each triangle's island id and the island count. */
function labelIslands(
  mesh: IndexedMesh,
  toleranceMm: number,
): { labels: Uint32Array; count: number } {
  const p = mesh.positions
  const idx = mesh.indices
  const vertexCount = Math.floor(p.length / 3)
  const welder = new VertexWelder(toleranceMm, vertexCount)
  const canonical = new Uint32Array(vertexCount)
  for (let v = 0; v < vertexCount; v++)
    canonical[v] = welder.add(p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!)

  const parent = new Int32Array(welder.vertexCount)
  for (let i = 0; i < parent.length; i++) parent[i] = i
  const union = (a: number, b: number): void => {
    const rootA = findRoot(parent, a)
    const rootB = findRoot(parent, b)
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB)
  }
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = canonical[idx[i]!]!
    union(a, canonical[idx[i + 1]!]!)
    union(a, canonical[idx[i + 2]!]!)
  }

  const labelOfRoot = new Map<number, number>()
  const labels = new Uint32Array(Math.floor(idx.length / 3))
  for (let t = 0; t < labels.length; t++) {
    const root = findRoot(parent, canonical[idx[t * 3]!]!)
    let label = labelOfRoot.get(root)
    if (label === undefined) {
      label = labelOfRoot.size
      labelOfRoot.set(root, label)
    }
    labels[t] = label
  }
  return { labels, count: labelOfRoot.size }
}

function describeIsland(positions: Float32Array, indices: Uint32Array): IslandInfo {
  const bounds = new BoundsBuilder()
  for (const v of indices)
    bounds.add(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!)
  const measures = measureMesh({ positions, indices })
  return {
    triangleCount: indices.length / 3,
    bbox: bounds.build() ?? { min: [0, 0, 0], max: [0, 0, 0] },
    areaMm2: measures.areaMm2,
    signedVolumeMm3: measures.signedVolumeMm3,
  }
}

/**
 * Splits a mesh into pieces that share no vertex position. Vertices are welded first, so meshes
 * that repeat vertices per face still group correctly.
 */
export function analyzeIslands(
  mesh: IndexedMesh,
  toleranceMm = DEFAULT_WELD_TOLERANCE_MM,
): IslandSummary {
  const { labels, count } = labelIslands(mesh, toleranceMm)
  // Counting sort of triangles by island, so each island is gathered in one pass.
  const starts = new Uint32Array(count + 1)
  for (const label of labels) starts[label + 1]!++
  for (let i = 1; i <= count; i++) starts[i]! += starts[i - 1]!
  const cursor = starts.slice(0, count)
  const order = new Uint32Array(labels.length)
  for (let t = 0; t < labels.length; t++) order[cursor[labels[t]!]!++] = t

  const islands: IslandInfo[] = []
  for (let island = 0; island < count; island++) {
    const first = starts[island]!
    const end = starts[island + 1]!
    const indices = new Uint32Array((end - first) * 3)
    for (let k = first; k < end; k++) {
      const corner = order[k]! * 3
      indices.set(mesh.indices.subarray(corner, corner + 3), (k - first) * 3)
    }
    islands.push(describeIsland(mesh.positions, indices))
  }
  islands.sort(compareIslands)
  return { count, islands }
}
