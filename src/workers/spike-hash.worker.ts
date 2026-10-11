// Must stay the first import: configures zod (jitless) before any schema is built, so the CSP never sees `new Function`.
import '../lib/shared/zod-setup'
import type { MeshoptSimplifier } from 'meshoptimizer/simplifier'
import { z } from 'zod'

/**
 * Spike S4: a module worker that lazily loads two WASM libraries under the production CSP.
 *  - hash-wasm: incremental SHA-256. It also works on insecure LAN origins, where crypto.subtle does not exist.
 *  - meshoptimizer (simplifier only): mesh simplification.
 *
 * Protocol: each request `{ id, kind, ... }` gets exactly one reply, `{ type: 'result' | 'failure', id }`.
 * A CSP violation raised in here fires on the worker's global scope, which the page cannot observe,
 * so the worker relays it as `{ type: 'csp-violation' }`.
 */

const MiB = 1024 * 1024
/** The generated buffer goes into hash-wasm in 1 MiB updates, the way a streamed file would. */
const HASH_UPDATE_BYTES = MiB
/** Files are read through File.slice() windows: the random-access pattern the M7 unzip will use. */
const FILE_SLICE_BYTES = 256 * 1024
/** Relative error cap (fraction of the mesh extent). It lets the gently curved grid reach the ~10% target. */
const SIMPLIFY_MAX_ERROR = 0.01
/** compactMesh marks vertices that the simplified index buffer no longer uses with ~0u. */
const UNUSED_VERTEX = 0xffffffff

const requestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hash-generated'),
    id: z.number().int(),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(64 * MiB),
  }),
  z.object({
    kind: z.literal('simplify-grid'),
    id: z.number().int(),
    cellsPerSide: z.number().int().min(1).max(1024),
    targetRatio: z.number().gt(0).lt(1),
  }),
  z.object({ kind: z.literal('hash-file'), id: z.number().int(), file: z.instanceof(Blob) }),
])

type SpikeRequest = z.infer<typeof requestSchema>
type Simplifier = typeof MeshoptSimplifier

interface WorkerEnvironment {
  isSecureContext: boolean
  hasSubtle: boolean
}

interface ViolationReport {
  effectiveDirective: string
  blockedURI: string
  sourceFile: string
  lineNumber: number
  sample: string
  disposition: string
}

interface HashGeneratedResult {
  kind: 'hash-generated'
  sizeBytes: number
  generateMs: number
  hashWasm: { hex: string; importMs: number; initMs: number; hashMs: number; coldImport: boolean }
  /** null where crypto.subtle does not exist (insecure origins). */
  subtle: { hex: string; ms: number } | null
}

interface SimplifyGridResult {
  kind: 'simplify-grid'
  inputTriangles: number
  targetTriangles: number
  outputTriangles: number
  outputVertices: number
  relativeError: number
  importMs: number
  readyMs: number
  simplifyMs: number
  coldImport: boolean
  /** Compacted mesh, transferred (not copied) to the page. */
  indices: Uint32Array
  positions: Float32Array
}

interface HashFileResult {
  kind: 'hash-file'
  name: string
  type: string
  size: number
  isFile: boolean
  sha256: string
  slices: number
  ms: number
}

type SpikeResult = HashGeneratedResult | SimplifyGridResult | HashFileResult

type WorkerMessage =
  | { type: 'ready'; env: WorkerEnvironment }
  | { type: 'result'; id: number; result: SpikeResult }
  | { type: 'failure'; id: number | null; error: { name: string; message: string } }
  | { type: 'csp-violation'; violation: ViolationReport }

interface Reply {
  result: SpikeResult
  transfer: Transferable[]
}

/** Memoised dynamic import that reports how long the caller waited and whether this call started the load. */
function lazyModule<T>(
  load: () => Promise<T>,
): () => Promise<{ value: T; waitMs: number; cold: boolean }> {
  let loading: Promise<T> | undefined
  return async () => {
    const cold = loading === undefined
    const start = performance.now()
    loading ??= load().catch((error: unknown) => {
      loading = undefined // let the next request retry, e.g. after a transient chunk fetch failure
      throw error
    })
    const value = await loading
    return { value, waitMs: performance.now() - start, cold }
  }
}

// Destructured dynamic imports so the bundler keeps only what is used, in chunks of their own.
const loadSha256Factory = lazyModule(async () => {
  const { createSHA256 } = await import('hash-wasm')
  return createSHA256
})
// The `meshoptimizer/simplifier` subpath, not the root: the root re-exports five modules and each one
// compiles its own WASM binary as soon as it is evaluated.
const loadSimplifier = lazyModule(async () => {
  const { MeshoptSimplifier } = await import('meshoptimizer/simplifier')
  return MeshoptSimplifier
})

/** crypto.subtle exists only in secure contexts; the plain-HTTP LAN Docker origin has none. */
function getSubtle(): SubtleCrypto | undefined {
  const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle
  return subtle
}

function describeEnvironment(): WorkerEnvironment {
  return { isSecureContext, hasSubtle: getSubtle() !== undefined }
}

/** Deterministic xorshift32 bytes, so every origin and run hashes identical input. */
function generateBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  let state = 0x9e3779b9
  for (let i = 0; i < length; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    bytes[i] = state // a Uint8Array store keeps the low 8 bits
  }
  return bytes
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function digestWithSubtle(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<HashGeneratedResult['subtle']> {
  const subtle = getSubtle()
  if (!subtle) return null
  const start = performance.now()
  const digest = await subtle.digest('SHA-256', bytes)
  return { hex: toHex(new Uint8Array(digest)), ms: performance.now() - start }
}

async function hashGenerated(sizeBytes: number): Promise<HashGeneratedResult> {
  const generateStart = performance.now()
  const bytes = generateBytes(sizeBytes)
  const generateMs = performance.now() - generateStart

  const { value: createSHA256, waitMs: importMs, cold } = await loadSha256Factory()
  const initStart = performance.now()
  // The first createSHA256() compiles the WASM module, which is the step 'wasm-unsafe-eval' gates.
  const hasher = await createSHA256()
  const initMs = performance.now() - initStart

  const hashStart = performance.now()
  hasher.init()
  for (let offset = 0; offset < bytes.length; offset += HASH_UPDATE_BYTES) {
    hasher.update(bytes.subarray(offset, offset + HASH_UPDATE_BYTES))
  }
  const hex = hasher.digest('hex')
  const hashMs = performance.now() - hashStart

  return {
    kind: 'hash-generated',
    sizeBytes,
    generateMs,
    hashWasm: { hex, importMs, initMs, hashMs, coldImport: cold },
    subtle: await digestWithSubtle(bytes),
  }
}

/** A gently curved height field: cellsPerSide² quads with two triangles each (100 gives 20,000 triangles). */
function createGridMesh(cellsPerSide: number): { positions: Float32Array; indices: Uint32Array } {
  const side = cellsPerSide + 1
  const positions = new Float32Array(side * side * 3)
  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const offset = (row * side + col) * 3
      positions[offset] = col
      positions[offset + 1] = row
      positions[offset + 2] = 4 * Math.sin(col / 9) * Math.cos(row / 11)
    }
  }
  const indices = new Uint32Array(cellsPerSide * cellsPerSide * 6)
  let cursor = 0
  for (let row = 0; row < cellsPerSide; row++) {
    for (let col = 0; col < cellsPerSide; col++) {
      const a = row * side + col
      const c = a + side
      indices.set([a, a + 1, c + 1, a, c + 1, c], cursor)
      cursor += 6
    }
  }
  return { positions, indices }
}

/** Drops the vertices that the simplified mesh no longer uses, so only live data goes back to the page. */
function compactMesh(
  simplifier: Simplifier,
  indices: Uint32Array,
  positions: Float32Array,
): Float32Array {
  const [remap, vertexCount] = simplifier.compactMesh(indices) // rewrites `indices` in place
  const compacted = new Float32Array(vertexCount * 3)
  remap.forEach((target, source) => {
    if (target === UNUSED_VERTEX) return
    compacted.set(positions.subarray(source * 3, source * 3 + 3), target * 3)
  })
  return compacted
}

/** Transferring is only cheap and safe when each view owns its whole (non-shared) ArrayBuffer. */
function ownedBuffer(view: Uint32Array | Float32Array): ArrayBuffer {
  const { buffer } = view
  if (
    !(buffer instanceof ArrayBuffer) ||
    view.byteOffset !== 0 ||
    view.byteLength !== buffer.byteLength
  ) {
    throw new TypeError('Result views must own their whole ArrayBuffer to be transferred')
  }
  return buffer
}

async function simplifyGrid(cellsPerSide: number, targetRatio: number): Promise<Reply> {
  const mesh = createGridMesh(cellsPerSide)
  const inputTriangles = mesh.indices.length / 3

  const { value: simplifier, waitMs: importMs, cold } = await loadSimplifier()
  const readyStart = performance.now()
  // Evaluating the module started WASM instantiation; `ready` settles when the CSP has allowed (or refused) it.
  await simplifier.ready
  const readyMs = performance.now() - readyStart

  const targetTriangles = Math.max(1, Math.round(inputTriangles * targetRatio))
  const simplifyStart = performance.now()
  const [indices, relativeError] = simplifier.simplify(
    mesh.indices,
    mesh.positions,
    3,
    targetTriangles * 3,
    SIMPLIFY_MAX_ERROR,
  )
  const positions = compactMesh(simplifier, indices, mesh.positions)
  const simplifyMs = performance.now() - simplifyStart

  return {
    result: {
      kind: 'simplify-grid',
      inputTriangles,
      targetTriangles,
      outputTriangles: indices.length / 3,
      outputVertices: positions.length / 3,
      relativeError,
      importMs,
      readyMs,
      simplifyMs,
      coldImport: cold,
      indices,
      positions,
    },
    transfer: [ownedBuffer(indices), ownedBuffer(positions)],
  }
}

async function hashFile(file: Blob): Promise<HashFileResult> {
  const { value: createSHA256 } = await loadSha256Factory()
  const start = performance.now()
  const hasher = await createSHA256()
  hasher.init()
  let slices = 0
  for (let offset = 0; offset < file.size; offset += FILE_SLICE_BYTES) {
    const slice = await file.slice(offset, offset + FILE_SLICE_BYTES).arrayBuffer()
    hasher.update(new Uint8Array(slice))
    slices += 1
  }
  const isFile = file instanceof File
  return {
    kind: 'hash-file',
    name: isFile ? file.name : '',
    type: file.type,
    size: file.size,
    isFile,
    sha256: hasher.digest('hex'),
    slices,
    ms: performance.now() - start,
  }
}

async function runRequest(request: SpikeRequest): Promise<Reply> {
  switch (request.kind) {
    case 'hash-generated':
      return { result: await hashGenerated(request.sizeBytes), transfer: [] }
    case 'simplify-grid':
      return simplifyGrid(request.cellsPerSide, request.targetRatio)
    case 'hash-file':
      return { result: await hashFile(request.file), transfer: [] }
  }
}

function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: 'Error', message: String(error) }
}

function readRequestId(data: unknown): number | null {
  if (typeof data === 'object' && data !== null && 'id' in data && typeof data.id === 'number')
    return data.id
  return null
}

function post(message: WorkerMessage, transfer: Transferable[] = []): void {
  postMessage(message, transfer)
}

async function handleRequest(data: unknown): Promise<void> {
  const parsed = requestSchema.safeParse(data)
  if (!parsed.success) {
    const message = z.prettifyError(parsed.error)
    post({ type: 'failure', id: readRequestId(data), error: { name: 'BadRequest', message } })
    return
  }
  const request = parsed.data
  try {
    const { result, transfer } = await runRequest(request)
    post({ type: 'result', id: request.id, result }, transfer)
  } catch (error) {
    post({ type: 'failure', id: request.id, error: describeError(error) })
  }
}

addEventListener('securitypolicyviolation', (event) => {
  if (!(event instanceof SecurityPolicyViolationEvent)) return
  post({
    type: 'csp-violation',
    violation: {
      effectiveDirective: event.effectiveDirective,
      blockedURI: event.blockedURI,
      sourceFile: event.sourceFile,
      lineNumber: event.lineNumber,
      sample: event.sample,
      disposition: event.disposition,
    },
  })
})

addEventListener('message', (event: MessageEvent<unknown>) => {
  void handleRequest(event.data)
})

post({ type: 'ready', env: describeEnvironment() })
