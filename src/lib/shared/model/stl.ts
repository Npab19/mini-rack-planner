/**
 * STL, binary and ASCII. A file is binary when its size is exactly 84 + 50 × (triangle count in the
 * header); anything else is read as ASCII, where several `solid` blocks become groups. Triangles are
 * welded into an indexed mesh with a quantized vertex hash. STL has no unit: millimetres assumed.
 */

import { GrowableFloat32Array } from './growable'
import { computeBBox, DEFAULT_WELD_TOLERANCE_MM, weldTriangleSoup } from './mesh'
import { isXmlWhitespace, parseDecimal } from './numbers'
import { type BBox, DEFAULT_LIMITS, LimitExceededError, ModelError } from './types'

const HEADER_BYTES = 80
const BINARY_PREFIX_BYTES = 84
const BINARY_TRIANGLE_BYTES = 50
const UTF8 = new TextDecoder()

export interface StlGroup {
  /** The `solid` name (ASCII) or '' (binary). */
  name: string
  firstTriangle: number
  triangleCount: number
}

export interface StlMesh {
  format: 'binary' | 'ascii'
  /** Millimetres (assumed), welded. */
  positions: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
  vertexCount: number
  triangleCount: number
  bbox?: BBox
  /** Consecutive triangle ranges, one per `solid` block. */
  groups: StlGroup[]
  /** Triangles dropped for non-finite coordinates or loops with fewer than three vertices. */
  skippedTriangleCount: number
  /** Printable text of the binary header, if any. */
  header?: string
  warnings: string[]
}

export interface StlOptions {
  weldToleranceMm?: number
  maxTriangles?: number
}

interface TriangleSoup {
  /** Nine floats per triangle. */
  soup: Float32Array
  groups: StlGroup[]
  skipped: number
}

function invalid(message: string): ModelError {
  return new ModelError('invalid-stl', message)
}

function declaredTriangleCount(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    HEADER_BYTES,
    true,
  )
}

/** The size rule: exactly 84 + 50 × the header's triangle count. */
export function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < BINARY_PREFIX_BYTES) return false
  return BINARY_PREFIX_BYTES + BINARY_TRIANGLE_BYTES * declaredTriangleCount(bytes) === bytes.length
}

function checkTriangleBudget(count: number, max: number): void {
  if (count > max)
    throw new LimitExceededError('triangles', count, max, `STL has more than ${max} triangles`)
}

function readHeaderText(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes.subarray(0, HEADER_BYTES)) {
    if (byte === 0) break
    text += byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ' '
  }
  return text.trim()
}

function readBinary(bytes: Uint8Array, count: number, maxTriangles: number): TriangleSoup {
  checkTriangleBudget(count, maxTriangles)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const soup = new Float32Array(count * 9)
  let kept = 0
  for (let t = 0; t < count; t++) {
    // Skip the 12-byte facet normal: it is recomputed from the winding wherever it is needed.
    const record = BINARY_PREFIX_BYTES + t * BINARY_TRIANGLE_BYTES + 12
    let finite = true
    for (let k = 0; k < 9; k++) {
      const value = view.getFloat32(record + k * 4, true)
      if (!Number.isFinite(value)) finite = false
      soup[kept * 9 + k] = value
    }
    if (finite) kept++
  }
  return {
    soup: soup.subarray(0, kept * 9),
    groups: [{ name: '', firstTriangle: 0, triangleCount: kept }],
    skipped: count - kept,
  }
}

/** Case-insensitive keyword test on a token. */
function tokenIs(bytes: Uint8Array, start: number, end: number, word: string): boolean {
  if (end - start !== word.length) return false
  for (let k = 0; k < word.length; k++) {
    if ((bytes[start + k]! | 0x20) !== word.charCodeAt(k)) return false
  }
  return true
}

/** Byte-level ASCII STL reader: no per-line strings, tolerant of case and odd whitespace. */
class AsciiStlReader {
  private readonly bytes: Uint8Array
  private readonly maxTriangles: number
  private readonly soup = new GrowableFloat32Array()
  private readonly groups: StlGroup[] = []
  private readonly loop: number[] = []
  private group: StlGroup | undefined
  private triangles = 0
  private skipped = 0
  private pos = 0
  private tokenStart = 0

  constructor(bytes: Uint8Array, maxTriangles: number) {
    this.bytes = bytes
    this.maxTriangles = maxTriangles
  }

  read(): TriangleSoup {
    for (let end = this.nextToken(); end >= 0; end = this.nextToken()) {
      const start = this.tokenStart
      if (tokenIs(this.bytes, start, end, 'solid')) this.startGroup(this.restOfLine())
      else if (tokenIs(this.bytes, start, end, 'endsolid')) this.endGroup()
      else if (tokenIs(this.bytes, start, end, 'outer')) this.loop.length = 0
      else if (tokenIs(this.bytes, start, end, 'vertex')) this.readVertex()
      else if (tokenIs(this.bytes, start, end, 'endloop')) this.closeLoop()
      // facet, normal (and its numbers), loop and endfacet carry nothing that is needed.
    }
    return { soup: this.soup.view(), groups: this.groups, skipped: this.skipped }
  }

  /** Advances to the next whitespace-separated token; returns its end, or -1 at the end of input. */
  private nextToken(): number {
    const bytes = this.bytes
    let i = this.pos
    while (i < bytes.length && isXmlWhitespace(bytes[i]!)) i++
    if (i >= bytes.length) return -1
    this.tokenStart = i
    while (i < bytes.length && !isXmlWhitespace(bytes[i]!)) i++
    this.pos = i
    return i
  }

  private restOfLine(): string {
    const bytes = this.bytes
    let end = this.pos
    while (end < bytes.length && bytes[end] !== 10 && bytes[end] !== 13) end++
    const text = UTF8.decode(bytes.subarray(this.pos, end)).trim()
    this.pos = end
    return text
  }

  private startGroup(name: string): StlGroup {
    const group = { name, firstTriangle: this.triangles, triangleCount: 0 }
    this.group = group
    this.groups.push(group)
    return group
  }

  private endGroup(): void {
    this.restOfLine()
    this.group = undefined
  }

  private readVertex(): void {
    for (let axis = 0; axis < 3; axis++) {
      const end = this.nextToken()
      const value = end < 0 ? Number.NaN : parseDecimal(this.bytes, this.tokenStart, end)
      if (!Number.isFinite(value))
        throw invalid(`Invalid vertex coordinate near byte ${this.tokenStart}`)
      this.loop.push(value)
    }
  }

  /** Emits the loop as a triangle fan (STL loops are triangles in practice). */
  private closeLoop(): void {
    const corners = this.loop.length / 3
    if (corners < 3) {
      this.skipped++
      return
    }
    // Facets before any `solid` line still need a group.
    const group = this.group ?? this.startGroup('')
    const l = this.loop
    for (let k = 1; k + 1 < corners; k++) {
      checkTriangleBudget(++this.triangles, this.maxTriangles)
      this.soup.push3(l[0]!, l[1]!, l[2]!)
      this.soup.push3(l[k * 3]!, l[k * 3 + 1]!, l[k * 3 + 2]!)
      this.soup.push3(l[k * 3 + 3]!, l[k * 3 + 4]!, l[k * 3 + 5]!)
      group.triangleCount++
    }
    this.loop.length = 0
  }
}

function startsWithSolid(bytes: Uint8Array): boolean {
  let i = 0
  while (i < bytes.length && isXmlWhitespace(bytes[i]!)) i++
  return tokenIs(bytes, i, Math.min(i + 5, bytes.length), 'solid')
}

/** Triangles a padded binary file holds, when its declared count fits; 0 otherwise. */
function paddedBinaryCount(bytes: Uint8Array): number {
  if (bytes.length < BINARY_PREFIX_BYTES) return 0
  const count = declaredTriangleCount(bytes)
  return BINARY_PREFIX_BYTES + BINARY_TRIANGLE_BYTES * count <= bytes.length ? count : 0
}

interface DetectedSoup extends TriangleSoup {
  binary: boolean
}

function readSoup(bytes: Uint8Array, maxTriangles: number, warnings: string[]): DetectedSoup {
  if (isBinaryStl(bytes)) {
    return { ...readBinary(bytes, declaredTriangleCount(bytes), maxTriangles), binary: true }
  }
  const padded = paddedBinaryCount(bytes)
  try {
    const ascii = new AsciiStlReader(bytes, maxTriangles).read()
    // An empty "solid ... endsolid" is a valid (empty) ASCII STL.
    const isEmptySolid = padded === 0 && startsWithSolid(bytes)
    if (ascii.soup.length > 0 || isEmptySolid) return { ...ascii, binary: false }
  } catch (error) {
    // Binary data can contain anything, including the word "vertex": fall back when it fits.
    if (padded === 0 || !(error instanceof ModelError) || error.code !== 'invalid-stl') throw error
  }
  if (padded > 0) {
    const trailing = bytes.length - BINARY_PREFIX_BYTES - BINARY_TRIANGLE_BYTES * padded
    warnings.push(`Binary STL with ${trailing} unexpected trailing bytes`)
    return { ...readBinary(bytes, padded, maxTriangles), binary: true }
  }
  throw invalid('Not an STL file: neither the binary size rule nor ASCII facets match')
}

/** Parses an STL file into a welded, indexed mesh. */
export function parseStl(bytes: Uint8Array, options: StlOptions = {}): StlMesh {
  const warnings: string[] = []
  const maxTriangles = options.maxTriangles ?? DEFAULT_LIMITS.maxTriangles
  const { soup, groups, skipped, binary } = readSoup(bytes, maxTriangles, warnings)
  const { positions, indices } = weldTriangleSoup(
    soup,
    options.weldToleranceMm ?? DEFAULT_WELD_TOLERANCE_MM,
  )
  if (skipped > 0)
    warnings.push(`${skipped} triangles skipped (non-finite coordinates or short loops)`)
  const mesh: StlMesh = {
    format: binary ? 'binary' : 'ascii',
    positions,
    indices,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
    bbox: computeBBox(positions),
    groups,
    skippedTriangleCount: skipped,
    warnings,
  }
  if (binary) mesh.header = readHeaderText(bytes)
  return mesh
}
