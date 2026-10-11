/**
 * Performance sanity: a generated 500,000-triangle model must parse in a few seconds in Node.
 * Timings are printed; the asserted ceilings are loose so a busy CI runner does not flake.
 */

import { describe, expect, it } from 'vitest'
import { geometryKeyG1 } from './hash'
import { parseStl } from './stl'
import { buildGrid3mf } from './testing/build3mf'
import { buildBinaryStl } from './testing/buildStl'
import { gridMesh } from './testing/meshes'
import { parseMeshes, parseStructure } from './threemf'
import { bytesSource, openZip } from './zip'

const CELLS = 500 // 500 x 500 quads = 500,000 triangles
const TRIANGLES = CELLS * CELLS * 2
const MiB = 1024 * 1024
const CEILING_MS = 8000

async function timed<T>(label: string, run: () => Promise<T> | T): Promise<T> {
  const start = performance.now()
  const result = await run()
  console.info(`[perf] ${label}: ${Math.round(performance.now() - start)} ms`)
  return result
}

describe('performance sanity (500k triangles)', () => {
  const grid = gridMesh(CELLS)

  it('parses a 3MF with parseMeshes and parseStructure', async () => {
    const bytes = buildGrid3mf(grid, 1)
    const zip = await openZip(bytesSource(bytes))
    const xmlBytes = zip.get('3D/3dmodel.model')?.size ?? 0
    console.info(
      `[perf] 3MF fixture: ${(bytes.length / MiB).toFixed(1)} MiB zipped, ${(xmlBytes / MiB).toFixed(1)} MiB XML`,
    )

    const start = performance.now()
    const meshes = await timed('parseMeshes', () => parseMeshes(bytesSource(bytes)))
    const meshMs = performance.now() - start
    expect(meshes.objects[0]?.triangleCount).toBe(TRIANGLES)
    expect(meshes.objects[0]?.vertexCount).toBe((CELLS + 1) ** 2)
    expect(meshMs).toBeLessThan(CEILING_MS)

    const structure = await timed('parseStructure', () => parseStructure(bytesSource(bytes)))
    expect(structure.objects[0]?.triangleCount).toBe(TRIANGLES)

    const key = await timed('geometryKeyG1', () => geometryKeyG1(meshes.objects[0]!))
    expect(key).toMatch(/^g1:/)
  }, 120_000)

  it('parses and welds a binary STL', async () => {
    const stl = buildBinaryStl({
      positions: Array.from(grid.positions),
      indices: Array.from(grid.indices),
    })
    const start = performance.now()
    const mesh = await timed('parseStl (binary, weld)', () => parseStl(stl))
    expect(performance.now() - start).toBeLessThan(CEILING_MS)
    expect(mesh.triangleCount).toBe(TRIANGLES)
    expect(mesh.vertexCount).toBe((CELLS + 1) ** 2)
  }, 120_000)
})
