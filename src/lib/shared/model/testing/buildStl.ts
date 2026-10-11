/** Builds binary and ASCII STL files in memory from test meshes. */

import type { TestMesh } from './meshes'

function corner(mesh: TestMesh, triangle: number, k: number): [number, number, number] {
  const v = (mesh.indices[triangle * 3 + k] ?? 0) * 3
  return [mesh.positions[v] ?? 0, mesh.positions[v + 1] ?? 0, mesh.positions[v + 2] ?? 0]
}

function facetNormal(a: number[], b: number[], c: number[]): [number, number, number] {
  const [ax = 0, ay = 0, az = 0] = a
  const ux = (b[0] ?? 0) - ax
  const uy = (b[1] ?? 0) - ay
  const uz = (b[2] ?? 0) - az
  const vx = (c[0] ?? 0) - ax
  const vy = (c[1] ?? 0) - ay
  const vz = (c[2] ?? 0) - az
  const n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
  const length = Math.hypot(...n) || 1
  return [n[0] / length, n[1] / length, n[2] / length]
}

/** Binary STL: 80-byte header, uint32 count, 50 bytes per triangle. */
export function buildBinaryStl(
  mesh: TestMesh,
  header = 'binary STL test fixture',
): Uint8Array<ArrayBuffer> {
  const count = Math.floor(mesh.indices.length / 3)
  const bytes = new Uint8Array(84 + 50 * count)
  bytes.set(new TextEncoder().encode(header).subarray(0, 80))
  const view = new DataView(bytes.buffer)
  view.setUint32(80, count, true)
  for (let t = 0; t < count; t++) {
    const corners = [corner(mesh, t, 0), corner(mesh, t, 1), corner(mesh, t, 2)]
    const values = [
      ...facetNormal(corners[0] ?? [], corners[1] ?? [], corners[2] ?? []),
      ...corners.flat(),
    ]
    values.forEach((value, k) => view.setFloat32(84 + t * 50 + k * 4, value, true))
  }
  return bytes
}

export interface AsciiSolid {
  name: string
  mesh: TestMesh
}

export interface AsciiStlOptions {
  /** How coordinates are written; exponent notation by default, as most CAD exporters do. */
  format?: (value: number) => string
  /** Upper-case keywords, as some old exporters write them. */
  upperCase?: boolean
}

/** ASCII STL with one `solid` block per entry. */
export function buildAsciiStl(
  solids: AsciiSolid[],
  options: AsciiStlOptions = {},
): Uint8Array<ArrayBuffer> {
  const format = options.format ?? ((value: number) => value.toExponential(6))
  const word = (text: string): string => (options.upperCase ? text.toUpperCase() : text)
  const lines: string[] = []
  for (const { name, mesh } of solids) {
    lines.push(`${word('solid')} ${name}`)
    for (let t = 0; t < mesh.indices.length / 3; t++) {
      const corners = [corner(mesh, t, 0), corner(mesh, t, 1), corner(mesh, t, 2)]
      const normal = facetNormal(corners[0] ?? [], corners[1] ?? [], corners[2] ?? [])
      lines.push(`  ${word('facet normal')} ${normal.map(format).join(' ')}`)
      lines.push(`    ${word('outer loop')}`)
      for (const point of corners)
        lines.push(`      ${word('vertex')} ${point.map(format).join(' ')}`)
      lines.push(`    ${word('endloop')}`, `  ${word('endfacet')}`)
    }
    lines.push(`${word('endsolid')} ${name}`)
  }
  return new TextEncoder().encode(`${lines.join('\n')}\n`)
}
