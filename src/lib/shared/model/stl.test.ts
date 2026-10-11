import { describe, expect, it } from 'vitest'
import { measureMesh } from './mesh'
import { isBinaryStl, parseStl } from './stl'
import { buildAsciiStl, buildBinaryStl } from './testing/buildStl'
import { boxMesh, cubeMesh, mergeMeshes, panelMesh } from './testing/meshes'
import { LimitExceededError, ModelError } from './types'

describe('parseStl: binary', () => {
  it('welds a cube into 8 vertices and 12 triangles', () => {
    const stl = buildBinaryStl(cubeMesh(10))
    expect(stl.length).toBe(84 + 50 * 12)
    expect(isBinaryStl(stl)).toBe(true)
    const mesh = parseStl(stl)
    expect(mesh.format).toBe('binary')
    expect([mesh.vertexCount, mesh.triangleCount, mesh.skippedTriangleCount]).toEqual([8, 12, 0])
    expect(mesh.bbox).toEqual({ min: [0, 0, 0], max: [10, 10, 10] })
    expect(mesh.header).toBe('binary STL test fixture')
    expect(measureMesh(mesh).signedVolumeMm3).toBeCloseTo(1000, 6)
  })

  it('measures a 254 x 88 x 4 panel', () => {
    const mesh = parseStl(buildBinaryStl(panelMesh()))
    expect(mesh.bbox).toEqual({ min: [0, 0, 0], max: [254, 88, 4] })
    expect(measureMesh(mesh).areaMm2).toBeCloseTo(2 * (254 * 88 + 254 * 4 + 88 * 4), 3)
  })

  it('uses the size rule even when the header starts with "solid"', () => {
    const mesh = parseStl(buildBinaryStl(cubeMesh(2), 'solid exported-by-a-cad-tool'))
    expect(mesh.format).toBe('binary')
    expect(mesh.triangleCount).toBe(12)
  })

  it('accepts padded binary files with a warning', () => {
    const exact = buildBinaryStl(cubeMesh(3))
    const padded = new Uint8Array(exact.length + 7)
    padded.set(exact)
    const mesh = parseStl(padded)
    expect(mesh.format).toBe('binary')
    expect(mesh.triangleCount).toBe(12)
    expect(mesh.warnings).toEqual(['Binary STL with 7 unexpected trailing bytes'])
  })

  it('skips triangles with non-finite coordinates', () => {
    const stl = buildBinaryStl(cubeMesh(1))
    new DataView(stl.buffer).setFloat32(84 + 12, Number.NaN, true)
    const mesh = parseStl(stl)
    expect([mesh.triangleCount, mesh.skippedTriangleCount]).toEqual([11, 1])
  })

  it('welds within the tolerance only', () => {
    // Two triangles sharing an edge, one corner nudged by 1e-6 mm (welds) and one by 1e-2 mm (does not).
    const soup = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0.000001, 0, 1.01, 1, 0, 0, 1, 0],
      indices: [0, 1, 2, 3, 4, 5],
    }
    expect(parseStl(buildBinaryStl(soup)).vertexCount).toBe(4)
    expect(parseStl(buildBinaryStl(soup), { weldToleranceMm: 0.1 }).vertexCount).toBe(4)
    expect(parseStl(buildBinaryStl(soup), { weldToleranceMm: 1e-9 }).vertexCount).toBe(5)
  })

  it('enforces the triangle cap before reading', () => {
    expect(() => parseStl(buildBinaryStl(cubeMesh(1)), { maxTriangles: 5 })).toThrow(
      LimitExceededError,
    )
  })
})

describe('parseStl: ASCII', () => {
  it('reads several solids as groups and welds shared vertices', () => {
    const leg = boxMesh(30, 20, 264)
    const pin = cubeMesh(5, [100, 0, 0])
    const mesh = parseStl(
      buildAsciiStl([
        { name: 'leg', mesh: leg },
        { name: 'magnet pin', mesh: pin },
      ]),
    )
    expect(mesh.format).toBe('ascii')
    expect(mesh.groups).toEqual([
      { name: 'leg', firstTriangle: 0, triangleCount: 12 },
      { name: 'magnet pin', firstTriangle: 12, triangleCount: 12 },
    ])
    expect([mesh.vertexCount, mesh.triangleCount]).toEqual([16, 24])
    expect(mesh.bbox).toEqual({ min: [0, 0, 0], max: [105, 20, 264] })
  })

  it('accepts upper-case keywords, plain numbers and CRLF line ends', () => {
    const bytes = buildAsciiStl([{ name: 'CUBE', mesh: cubeMesh(4) }], {
      upperCase: true,
      format: String,
    })
    const crlf = new TextEncoder().encode(new TextDecoder().decode(bytes).replace(/\n/g, '\r\n'))
    const mesh = parseStl(crlf)
    expect([mesh.format, mesh.vertexCount, mesh.triangleCount]).toEqual(['ascii', 8, 12])
    expect(mesh.groups[0]?.name).toBe('CUBE')
  })

  it('gives the same mesh as the binary file', () => {
    const shape = mergeMeshes(boxMesh(12.5, 3.25, 7), cubeMesh(2, [-4, -4, -4]))
    const ascii = parseStl(
      buildAsciiStl([{ name: 'x', mesh: shape }], { format: (v) => v.toExponential(9) }),
    )
    const binary = parseStl(buildBinaryStl(shape))
    expect(Array.from(ascii.positions)).toEqual(Array.from(binary.positions))
    expect(Array.from(ascii.indices)).toEqual(Array.from(binary.indices))
  })

  it('triangulates polygon loops as fans and skips short loops', () => {
    const text = [
      'solid quad',
      'facet normal 0 0 1',
      ' outer loop',
      '  vertex 0 0 0',
      '  vertex 1 0 0',
      '  vertex 1 1 0',
      '  vertex 0 1 0',
      ' endloop',
      'endfacet',
      'facet normal 0 0 1',
      ' outer loop',
      '  vertex 0 0 0',
      '  vertex 1 0 0',
      ' endloop',
      'endfacet',
      'endsolid quad',
    ].join('\n')
    const mesh = parseStl(new TextEncoder().encode(text))
    expect([mesh.triangleCount, mesh.vertexCount, mesh.skippedTriangleCount]).toEqual([2, 4, 1])
  })

  it('reads an empty solid as an empty mesh', () => {
    const mesh = parseStl(new TextEncoder().encode('solid nothing\nendsolid nothing\n'))
    expect([mesh.format, mesh.triangleCount, mesh.bbox]).toEqual(['ascii', 0, undefined])
  })

  it('rejects files that are neither binary nor ASCII STL', () => {
    expect(() => parseStl(new TextEncoder().encode('hello, this is not a model'))).toThrow(
      ModelError,
    )
    expect(() =>
      parseStl(
        new TextEncoder().encode('solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 zz\n'),
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid-stl' }))
  })
})
