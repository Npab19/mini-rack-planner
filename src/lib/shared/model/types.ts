/**
 * Shared types, limits and errors for the DOM-free model parsers (ZIP, 3MF, STL).
 *
 * Everything under src/lib/shared/model runs unchanged in a module worker, in Node scripts and in
 * tests: no DOM, no Node built-ins. Millimetres everywhere.
 */

export type Vec3 = [number, number, number]

/** Axis-aligned bounding box. */
export interface BBox {
  min: Vec3
  max: Vec3
}

/**
 * A 3MF affine transform in file order: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32.
 * Points are row vectors, [x y z 1] × M, so m30..m32 is the translation.
 */
export type Transform3x4 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
]

/**
 * Random-access byte source. Adapters: `bytesSource` (tests, nested archives), `blobSource`
 * (File/Blob in the app) and a file handle in Node scripts.
 */
export interface RandomAccessSource {
  readonly size: number
  /** Resolves exactly `length` bytes starting at `offset`, or rejects. */
  read(offset: number, length: number): Promise<Uint8Array>
}

/** Indexed triangle mesh, three floats per vertex and three indices per triangle. */
export interface IndexedMesh {
  positions: Float32Array
  indices: Uint32Array
}

/** Caps that keep hostile or broken files (zip bombs, runaway XML) from exhausting the worker. */
export interface ModelLimits {
  /** Entries declared in the ZIP central directory. */
  maxEntries: number
  /** Inflated bytes of one entry, declared or actual. */
  maxEntryInflatedBytes: number
  /** Inflated bytes across every entry read from one archive. */
  maxTotalInflatedBytes: number
  /** Triangles across one parse call (all model files of a package, or one STL). */
  maxTriangles: number
  /** Vertices across one parse call. */
  maxVertices: number
  /** Longest single XML tag, comment or CDATA section the streaming scanner buffers. */
  maxXmlTokenBytes: number
  /** Deepest XML element nesting. */
  maxXmlDepth: number
  /** Deepest 3MF component nesting (component -> object -> component ...). */
  maxComponentDepth: number
}

const MiB = 1024 * 1024

export const DEFAULT_LIMITS: Readonly<ModelLimits> = {
  maxEntries: 10_000,
  maxEntryInflatedBytes: 1024 * MiB,
  maxTotalInflatedBytes: 2048 * MiB,
  maxTriangles: 20_000_000,
  maxVertices: 30_000_000,
  maxXmlTokenBytes: 8 * MiB,
  maxXmlDepth: 256,
  maxComponentDepth: 32,
}

export function resolveLimits(overrides: Partial<ModelLimits> = {}): ModelLimits {
  return { ...DEFAULT_LIMITS, ...overrides }
}

export type ModelErrorCode =
  /** No ZIP end-of-central-directory record: not a ZIP (or truncated). */
  | 'not-a-zip'
  /** Bad signatures, offsets, sizes or CRC. */
  | 'zip-corrupt'
  /** Multi-disk archives or compression methods other than stored/deflate. */
  | 'zip-unsupported'
  | 'zip-encrypted'
  | 'entry-not-found'
  /** A cap from ModelLimits was hit; always a LimitExceededError. */
  | 'limit-exceeded'
  | 'xml-malformed'
  | 'invalid-3mf'
  | 'invalid-stl'

/** Every parser failure is a ModelError, so the ingest worker can map `code` to a user message. */
export class ModelError extends Error {
  override name = 'ModelError'
  readonly code: ModelErrorCode

  constructor(code: ModelErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

export type LimitKind =
  | 'entries'
  | 'entry-bytes'
  | 'total-bytes'
  /** An entry inflated past the size its header declared: a lying header, typical of zip bombs. */
  | 'declared-size'
  | 'triangles'
  | 'vertices'
  | 'xml-token'
  | 'xml-depth'
  | 'component-depth'

/** A ModelLimits cap was exceeded. Zip bombs end here. */
export class LimitExceededError extends ModelError {
  override name = 'LimitExceededError'
  readonly limit: LimitKind
  readonly actual: number
  readonly max: number

  constructor(limit: LimitKind, actual: number, max: number, message?: string) {
    super('limit-exceeded', message ?? `Limit "${limit}" exceeded: ${actual} > ${max}`)
    this.limit = limit
    this.actual = actual
    this.max = max
  }
}
