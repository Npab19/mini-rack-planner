import { describe, expect, it } from 'vitest'
import {
  canonicalTriangles,
  createSha256,
  geometryKeyG1,
  geometrySignature,
  sha256Hex,
  sha256OfSource,
} from './hash'
import { parseStl } from './stl'
import { buildCore3mf } from './testing/build3mf'
import { buildAsciiStl, buildBinaryStl } from './testing/buildStl'
import {
  boxMesh,
  cubeMesh,
  mergeMeshes,
  panelMesh,
  type TestMesh,
  toIndexedMesh,
  transformMesh,
} from './testing/meshes'
import { parseMeshes } from './threemf'
import type { IndexedMesh } from './types'
import { bytesSource } from './zip'

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

/** An asymmetric part with non-integer coordinates, so rotations and mirrors change it. */
const PART: TestMesh = mergeMeshes(boxMesh(12.34, 5.67, 8.9), boxMesh(3.3, 2.2, 1.1, [12.34, 0, 0]))

describe('SHA-256', () => {
  it('matches the FIPS 180 test vector, one-shot and incrementally', async () => {
    const abc = new TextEncoder().encode('abc')
    expect(await sha256Hex(abc)).toBe(ABC_SHA256)
    const hash = await createSha256()
    hash.update(abc.subarray(0, 1))
    hash.update(abc.subarray(1))
    expect(hash.digest()).toBe(ABC_SHA256)
  })

  it('hashes a random-access source in chunks', async () => {
    const data = new Uint8Array(1000).map((_, i) => (i * 7) & 0xff)
    const progress: number[] = []
    const hex = await sha256OfSource(bytesSource(data), {
      chunkBytes: 64,
      onProgress: (done) => progress.push(done),
    })
    expect(hex).toBe(await sha256Hex(data))
    expect(progress.at(-1)).toBe(1000)
    expect(progress).toHaveLength(16)
  })
})

function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items]
  let state = seed
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    const j = state % (i + 1)
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

/** Same surface, different bookkeeping: vertices renumbered, triangles reordered and rotated. */
function reshuffle(mesh: TestMesh, seed: number): TestMesh {
  const vertexCount = mesh.positions.length / 3
  const order = shuffled([...Array(vertexCount).keys()], seed)
  const newIndexOf = new Map(order.map((oldIndex, newIndex) => [oldIndex, newIndex]))
  const positions = order.flatMap((oldIndex) =>
    mesh.positions.slice(oldIndex * 3, oldIndex * 3 + 3),
  )
  const triangles = [...Array(mesh.indices.length / 3).keys()].map((t) =>
    [0, 1, 2].map((k) => newIndexOf.get(mesh.indices[t * 3 + k] ?? 0) ?? 0),
  )
  const indices = shuffled(triangles, seed + 1).flatMap(([a = 0, b = 0, c = 0], i) =>
    i % 3 === 0 ? [a, b, c] : i % 3 === 1 ? [b, c, a] : [c, a, b],
  )
  return { positions, indices }
}

describe('geometryKeyG1', () => {
  it('is a versioned SHA-256 key', async () => {
    expect(await geometryKeyG1(toIndexedMesh(PART))).toMatch(/^g1:[0-9a-f]{64}$/)
  })

  it('ignores vertex order, triangle order, corner rotation and translation', async () => {
    const reference = await geometryKeyG1(toIndexedMesh(PART))
    expect(await geometryKeyG1(toIndexedMesh(reshuffle(PART, 7)))).toBe(reference)
    const moved = transformMesh(PART, [1, 0, 0, 0, 1, 0, 0, 0, 1, 1000, -250, 37.5])
    expect(await geometryKeyG1(toIndexedMesh(moved))).toBe(reference)
  })

  it('ignores unreferenced vertices', async () => {
    const mesh = toIndexedMesh(PART)
    const padded: IndexedMesh = {
      positions: Float32Array.from([...mesh.positions, -500, -500, -500]),
      indices: mesh.indices,
    }
    expect(await geometryKeyG1(padded)).toBe(await geometryKeyG1(mesh))
  })

  it('changes with the geometry, rotations and mirroring', async () => {
    const reference = await geometryKeyG1(toIndexedMesh(PART))
    const nudged = { positions: [...PART.positions], indices: PART.indices }
    nudged.positions[3] = (nudged.positions[3] ?? 0) + 0.02
    expect(await geometryKeyG1(toIndexedMesh(nudged))).not.toBe(reference)
    const rotated = transformMesh(PART, [0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0])
    expect(await geometryKeyG1(toIndexedMesh(rotated))).not.toBe(reference)
  })

  it('is the same for one mesh read from binary STL, ASCII STL and 3MF', async () => {
    const fromBinary = parseStl(buildBinaryStl(PART))
    const fromAscii = parseStl(buildAsciiStl([{ name: 'part', mesh: PART }]))
    const from3mf = (await parseMeshes(bytesSource(buildCore3mf({ mesh: PART })))).objects[0]
    expect(from3mf).toBeDefined()
    const keys = await Promise.all(
      [fromBinary, fromAscii, from3mf!].map((mesh) => geometryKeyG1(mesh)),
    )
    expect(new Set(keys).size).toBe(1)
  })

  it('canonicalises degenerate triangles regardless of corner order', () => {
    const positions = Float32Array.of(0, 0, 0, 1, 0, 0)
    const a = canonicalTriangles({ positions, indices: Uint32Array.of(0, 0, 1) })
    const b = canonicalTriangles({ positions, indices: Uint32Array.of(0, 1, 0) })
    const c = canonicalTriangles({ positions, indices: Uint32Array.of(1, 0, 0) })
    expect(Array.from(b)).toEqual(Array.from(a))
    expect(Array.from(c)).toEqual(Array.from(a))
    expect(Array.from(a)).toEqual([0, 0, 0, 0, 0, 0, 100, 0, 0])
  })
})

describe('geometrySignature', () => {
  it('summarises triangles, area, volume and sorted extents', () => {
    expect(geometrySignature(toIndexedMesh(cubeMesh(10)))).toEqual({
      tri: 12,
      areaMm2: 600,
      volMm3: 1000,
      extMm: [10, 10, 10],
    })
    expect(geometrySignature(toIndexedMesh(panelMesh())).extMm).toEqual([254, 88, 4])
  })

  it('is unchanged by rotation and mirroring, unlike g1', () => {
    const reference = geometrySignature(toIndexedMesh(PART))
    const rotated = transformMesh(PART, [0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0])
    const mirrored = transformMesh(PART, [-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])
    expect(geometrySignature(toIndexedMesh(rotated))).toEqual(reference)
    expect(geometrySignature(toIndexedMesh(mirrored))).toEqual(reference)
  })
})
