/**
 * Hashing.
 *
 * - SHA-256 behind a small incremental interface. The implementation is hash-wasm, imported lazily
 *   on first use, so keys are identical on HTTPS and on plain-HTTP LAN origins (no crypto.subtle).
 * - Geometry fingerprints that survive file format, vertex order, triangle order and translation:
 *   the g1 key (exact match) and a signature of rounded measures (candidate match).
 */

import type { IHasher } from 'hash-wasm'
import { measureMesh } from './mesh'
import { roundTo } from './numbers'
import type { IndexedMesh, RandomAccessSource } from './types'

export interface IncrementalHash {
  update(data: Uint8Array): void
  /** Lowercase hex digest. Call once; the hash cannot be updated afterwards. */
  digest(): string
}

export type HashFactory = () => Promise<IncrementalHash>

let sha256Loader: Promise<() => Promise<IHasher>> | undefined

function loadSha256(): Promise<() => Promise<IHasher>> {
  sha256Loader ??= import('hash-wasm').then(
    (module) => module.createSHA256,
    (error: unknown) => {
      sha256Loader = undefined // let a later call retry, e.g. after a failed chunk fetch
      throw error
    },
  )
  return sha256Loader
}

/** SHA-256 backed by hash-wasm. */
export const createSha256: HashFactory = async () => {
  const create = await loadSha256()
  const hasher = await create()
  hasher.init()
  return {
    update(data) {
      hasher.update(data)
    },
    digest() {
      return hasher.digest('hex')
    },
  }
}

export async function sha256Hex(
  data: Uint8Array,
  factory: HashFactory = createSha256,
): Promise<string> {
  const hash = await factory()
  hash.update(data)
  return hash.digest()
}

export interface SourceHashOptions {
  chunkBytes?: number
  factory?: HashFactory
  onProgress?: (hashedBytes: number, totalBytes: number) => void
}

/** Streams a whole source (a dropped File, a file handle) through SHA-256 in chunks. */
export async function sha256OfSource(
  source: RandomAccessSource,
  options: SourceHashOptions = {},
): Promise<string> {
  const chunkBytes = options.chunkBytes ?? 4 * 1024 * 1024
  const hash = await (options.factory ?? createSha256)()
  for (let offset = 0; offset < source.size; offset += chunkBytes) {
    const length = Math.min(chunkBytes, source.size - offset)
    hash.update(await source.read(offset, length))
    options.onProgress?.(offset + length, source.size)
  }
  return hash.digest()
}

/** g1 quantum: 0.01 mm, far below print resolution and far above float32 noise at rack scale. */
const G1_STEPS_PER_MM = 100

function compareTriples(q: Int32Array, a: number, b: number): number {
  return q[a]! - q[b]! || q[a + 1]! - q[b + 1]! || q[a + 2]! - q[b + 2]!
}

function compareTriangles(data: Int32Array, a: number, b: number): number {
  for (let k = 0; k < 9; k++) {
    const difference = data[a + k]! - data[b + k]!
    if (difference !== 0) return difference
  }
  return 0
}

/** Referenced vertices only: unused vertices must not move the origin. */
function minCorner(positions: Float32Array, indices: Uint32Array): [number, number, number] {
  let x = Infinity
  let y = Infinity
  let z = Infinity
  for (const vertex of indices) {
    const at = vertex * 3
    if (positions[at]! < x) x = positions[at]!
    if (positions[at + 1]! < y) y = positions[at + 1]!
    if (positions[at + 2]! < z) z = positions[at + 2]!
  }
  return [x, y, z]
}

/**
 * The canonical form behind the g1 key: each vertex quantized to 0.01 mm (int32) relative to the
 * mesh's min corner, each triangle rotated so its smallest vertex comes first (winding kept), and
 * the triangles sorted lexicographically. Nine int32 per triangle.
 */
export function canonicalTriangles(mesh: IndexedMesh): Int32Array {
  const { positions, indices } = mesh
  const triangleCount = Math.floor(indices.length / 3)
  if (triangleCount === 0) return new Int32Array(0)
  const [minX, minY, minZ] = minCorner(positions, indices)

  const vertexCount = Math.floor(positions.length / 3)
  const quantized = new Int32Array(vertexCount * 3)
  for (let v = 0; v < vertexCount; v++) {
    quantized[v * 3] = Math.round((positions[v * 3]! - minX) * G1_STEPS_PER_MM)
    quantized[v * 3 + 1] = Math.round((positions[v * 3 + 1]! - minY) * G1_STEPS_PER_MM)
    quantized[v * 3 + 2] = Math.round((positions[v * 3 + 2]! - minZ) * G1_STEPS_PER_MM)
  }

  const rotated = new Int32Array(triangleCount * 9)
  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3]! * 3
    const b = indices[t * 3 + 1]! * 3
    const c = indices[t * 3 + 2]! * 3
    const first = smallestRotation(quantized, a, b, c)
    for (let k = 0; k < 3; k++) {
      const source = cornerAt(a, b, c, first + k)
      rotated[t * 9 + k * 3] = quantized[source]!
      rotated[t * 9 + k * 3 + 1] = quantized[source + 1]!
      rotated[t * 9 + k * 3 + 2] = quantized[source + 2]!
    }
  }

  const order = new Uint32Array(triangleCount)
  for (let t = 0; t < triangleCount; t++) order[t] = t * 9
  order.sort((x, y) => compareTriangles(rotated, x, y))
  const sorted = new Int32Array(triangleCount * 9)
  for (let t = 0; t < triangleCount; t++)
    sorted.set(rotated.subarray(order[t]!, order[t]! + 9), t * 9)
  return sorted
}

function cornerAt(a: number, b: number, c: number, position: number): number {
  const wrapped = position % 3
  return wrapped === 0 ? a : wrapped === 1 ? b : c
}

/** Compares the triangle read from corner `x` with the triangle read from corner `y`. */
function compareRotations(
  q: Int32Array,
  a: number,
  b: number,
  c: number,
  x: number,
  y: number,
): number {
  for (let k = 0; k < 3; k++) {
    const difference = compareTriples(q, cornerAt(a, b, c, x + k), cornerAt(a, b, c, y + k))
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * The corner that starts the lexicographically smallest rotation: the smallest vertex, with whole
 * rotations compared when a degenerate triangle repeats it.
 */
function smallestRotation(q: Int32Array, a: number, b: number, c: number): number {
  let best = 0
  if (compareRotations(q, a, b, c, 1, best) < 0) best = 1
  if (compareRotations(q, a, b, c, 2, best) < 0) best = 2
  return best
}

function littleEndianBytes(data: Int32Array): Uint8Array {
  const platformIsLittleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1
  if (platformIsLittleEndian) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  const bytes = new Uint8Array(data.byteLength)
  const view = new DataView(bytes.buffer)
  data.forEach((value, i) => view.setInt32(i * 4, value, true))
  return bytes
}

/**
 * Geometry key "g1:<sha256 hex>" of the canonical triangles. Equal for the same mesh whatever the
 * format (STL or 3MF), vertex order, triangle order, rotation of corners within a triangle or
 * translation. Compute it in the object-local frame (see parseMeshes).
 */
export async function geometryKeyG1(
  mesh: IndexedMesh,
  factory: HashFactory = createSha256,
): Promise<string> {
  const hash = await factory()
  hash.update(littleEndianBytes(canonicalTriangles(mesh)))
  return `g1:${hash.digest()}`
}

export interface GeometrySignature {
  tri: number
  areaMm2: number
  /** Absolute enclosed volume. */
  volMm3: number
  /** Bounding-box extents, largest first: unchanged by axis swaps and mirroring. */
  extMm: [number, number, number]
}

/** Signature measures are kept to 0.01 (mm, mm², mm³). */
function round2(value: number): number {
  return roundTo(value, 2)
}

/** Rounded measures for candidate matching when exact g1 keys differ (rotated or remeshed parts). */
export function geometrySignature(mesh: IndexedMesh): GeometrySignature {
  const { positions, indices } = mesh
  const measures = measureMesh(mesh)
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (const vertex of indices) {
    const at = vertex * 3
    if (positions[at]! > maxX) maxX = positions[at]!
    if (positions[at + 1]! > maxY) maxY = positions[at + 1]!
    if (positions[at + 2]! > maxZ) maxZ = positions[at + 2]!
  }
  const [minX, minY, minZ] = minCorner(positions, indices)
  const extents =
    indices.length === 0
      ? [0, 0, 0]
      : [maxX - minX, maxY - minY, maxZ - minZ].toSorted((a, b) => b - a)
  return {
    tri: Math.floor(indices.length / 3),
    areaMm2: round2(measures.areaMm2),
    volMm3: round2(Math.abs(measures.signedVolumeMm3)),
    extMm: [round2(extents[0] ?? 0), round2(extents[1] ?? 0), round2(extents[2] ?? 0)],
  }
}
