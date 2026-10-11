import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { z } from 'zod'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/**
 * Spike S4: a module worker with lazily loaded WASM (hash-wasm, meshoptimizer) under the production CSP.
 * The /dev/spike-worker route exists in dev builds and in builds made with VITE_SPIKES=1.
 * scripts/spikes/csp-check.ts drives this page through its data-testid hooks.
 */

const GENERATED_BYTES = 5 * 1024 * 1024
/** 100 × 100 quads with two triangles each: 20,000 triangles. */
const GRID_CELLS_PER_SIDE = 100
const SIMPLIFY_TARGET_RATIO = 0.1
/** FIPS 180-2 known answer: SHA-256 of one million 'a' characters (the File-transfer probe). */
const MILLION_A_SHA256 = 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'

// MessageEvent.data is untyped, so worker replies are parsed rather than trusted.
const environmentSchema = z.object({ isSecureContext: z.boolean(), hasSubtle: z.boolean() })
const violationSchema = z.object({
  effectiveDirective: z.string(),
  blockedURI: z.string(),
  sourceFile: z.string(),
  lineNumber: z.number(),
  sample: z.string(),
  disposition: z.string(),
})
const hashGeneratedSchema = z.object({
  kind: z.literal('hash-generated'),
  sizeBytes: z.number(),
  generateMs: z.number(),
  hashWasm: z.object({
    hex: z.string(),
    importMs: z.number(),
    initMs: z.number(),
    hashMs: z.number(),
    coldImport: z.boolean(),
  }),
  subtle: z.object({ hex: z.string(), ms: z.number() }).nullable(),
})
const simplifyGridSchema = z.object({
  kind: z.literal('simplify-grid'),
  inputTriangles: z.number(),
  targetTriangles: z.number(),
  outputTriangles: z.number(),
  outputVertices: z.number(),
  relativeError: z.number(),
  importMs: z.number(),
  readyMs: z.number(),
  simplifyMs: z.number(),
  coldImport: z.boolean(),
  indices: z.instanceof(Uint32Array),
  positions: z.instanceof(Float32Array),
})
const hashFileSchema = z.object({
  kind: z.literal('hash-file'),
  name: z.string(),
  type: z.string(),
  size: z.number(),
  isFile: z.boolean(),
  sha256: z.string(),
  slices: z.number(),
  ms: z.number(),
})
const workerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), env: environmentSchema }),
  z.object({ type: z.literal('result'), id: z.number(), result: z.unknown() }),
  z.object({
    type: z.literal('failure'),
    id: z.number().nullable(),
    error: z.object({ name: z.string(), message: z.string() }),
  }),
  z.object({ type: z.literal('csp-violation'), violation: violationSchema }),
])

type WorkerEnvironment = z.infer<typeof environmentSchema>
type HashGenerated = z.infer<typeof hashGeneratedSchema>
type SimplifyGrid = z.infer<typeof simplifyGridSchema>
type HashFile = z.infer<typeof hashFileSchema>
type Violation = z.infer<typeof violationSchema> & { source: 'page' | 'worker' }

interface WorkerBoot {
  env: WorkerEnvironment
  bootMs: number
}

type SpikeRequest =
  | { kind: 'hash-generated'; sizeBytes: number }
  | { kind: 'simplify-grid'; cellsPerSide: number; targetRatio: number }
  | { kind: 'hash-file'; file: Blob }

interface SpikeWorkerClient {
  /** Settles once the worker module has loaded and reported its environment. */
  boot: Promise<WorkerBoot>
  request<T>(request: SpikeRequest, schema: z.ZodType<T>): Promise<T>
  terminate(): void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type StepState<T> =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; value: T }
  | { status: 'failed'; error: string }

const IDLE: { status: 'idle' } = { status: 'idle' }

function createSpikeWorkerClient(onViolation: (violation: Violation) => void): SpikeWorkerClient {
  const startedAt = performance.now()
  // Keep this literal form: Vite only emits `new Worker(new URL('…', import.meta.url))` as a separate module chunk.
  const worker = new Worker(new URL('../../workers/spike-hash.worker.ts', import.meta.url), {
    type: 'module',
  })
  const pending = new Map<number, PendingRequest>()
  let nextId = 1

  const rejectAll = (error: Error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }

  const settle = (id: number, outcome: { value: unknown } | { error: Error }) => {
    const request = pending.get(id)
    pending.delete(id)
    if ('error' in outcome) request?.reject(outcome.error)
    else request?.resolve(outcome.value)
  }

  const boot = new Promise<WorkerBoot>((resolve, reject) => {
    worker.addEventListener('message', (event: MessageEvent<unknown>) => {
      const parsed = workerMessageSchema.safeParse(event.data)
      if (!parsed.success) {
        rejectAll(new Error(`Unexpected worker message: ${z.prettifyError(parsed.error)}`))
        return
      }
      const message = parsed.data
      switch (message.type) {
        case 'ready':
          resolve({ env: message.env, bootMs: performance.now() - startedAt })
          break
        case 'csp-violation':
          onViolation({ ...message.violation, source: 'worker' })
          break
        case 'result':
          settle(message.id, { value: message.result })
          break
        case 'failure': {
          const error = new Error(`${message.error.name}: ${message.error.message}`)
          if (message.id === null) rejectAll(error)
          else settle(message.id, { error })
          break
        }
      }
    })
    worker.addEventListener('error', (event) => {
      // A module worker that cannot load (404, wrong MIME type, CSP worker-src) gets a bare Event without a message.
      const error = new Error(event.message || 'The worker failed to load or crashed')
      reject(error)
      rejectAll(error)
    })
    worker.addEventListener('messageerror', () => {
      rejectAll(new Error('A worker message could not be deserialized'))
    })
  })

  return {
    boot,
    request<T>(request: SpikeRequest, schema: z.ZodType<T>): Promise<T> {
      const id = nextId++
      const reply = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject })
      })
      worker.postMessage({ ...request, id })
      return reply.then((value) => schema.parse(value))
    },
    terminate() {
      worker.terminate()
      rejectAll(new Error('The worker was terminated'))
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runs one step and mirrors its progress into state; resolves to undefined when the step failed. */
async function runStep<T>(
  setState: (state: StepState<T>) => void,
  task: () => Promise<T>,
): Promise<T | undefined> {
  setState({ status: 'running' })
  try {
    const value = await task()
    setState({ status: 'ok', value })
    return value
  } catch (error) {
    setState({ status: 'failed', error: errorMessage(error) })
    return undefined
  }
}

function describePageViolation(event: SecurityPolicyViolationEvent): Violation {
  return {
    effectiveDirective: event.effectiveDirective,
    blockedURI: event.blockedURI,
    sourceFile: event.sourceFile,
    lineNumber: event.lineNumber,
    sample: event.sample,
    disposition: event.disposition,
    source: 'page',
  }
}

/** crypto.subtle is missing on insecure origins (plain-HTTP LAN), even though the DOM types say otherwise. */
function hasSubtleCrypto(): boolean {
  const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle
  return subtle !== undefined
}

function createProbeFile(): File {
  return new File(['a'.repeat(1_000_000)], 'million-a.txt', { type: 'text/plain' })
}

function isConsistentMesh({
  indices,
  positions,
  outputTriangles,
  outputVertices,
}: SimplifyGrid): boolean {
  return (
    indices.length === outputTriangles * 3 &&
    positions.length === outputVertices * 3 &&
    indices.every((index) => index < outputVertices)
  )
}

const formatMs = (ms: number) => ms.toFixed(1)

const STATUS_VARIANT = {
  idle: 'outline',
  running: 'secondary',
  ok: 'default',
  failed: 'destructive',
} as const

function StatusBadge({ state, testId }: { state: StepState<unknown>; testId: string }) {
  return (
    <Badge variant={STATUS_VARIANT[state.status]} data-testid={testId}>
      {state.status}
    </Badge>
  )
}

function Field({
  label,
  testId,
  wide = false,
  children,
}: {
  label: string
  testId: string
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', wide && 'sm:col-span-2')}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm break-all" data-testid={testId}>
        {children}
      </dd>
    </div>
  )
}

function Fields({ children }: { children: ReactNode }) {
  return <dl className="grid gap-3 sm:grid-cols-2">{children}</dl>
}

function StepCard({
  title,
  description,
  testId,
  state,
  className,
  children,
}: {
  title: string
  description: ReactNode
  testId: string
  state: StepState<unknown>
  className?: string
  children?: ReactNode
}) {
  return (
    <Card size="sm" data-testid={testId} className={className}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span>{title}</span>
          <StatusBadge state={state} testId={`${testId}-status`} />
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state.status === 'failed' && (
          <p
            role="alert"
            className="text-sm break-words text-destructive"
            data-testid={`${testId}-error`}
          >
            {state.error}
          </p>
        )}
        {children}
      </CardContent>
    </Card>
  )
}

function EnvironmentCard({ boot }: { boot: StepState<WorkerBoot> }) {
  return (
    <StepCard
      title="Worker boot"
      description="Module worker from a same-origin chunk (worker-src 'self'); zod-setup is its first import."
      testId="step-boot"
      state={boot}
    >
      <Fields>
        <Field label="Page origin" testId="origin" wide>
          {window.location.origin}
        </Field>
        <Field label="Page isSecureContext" testId="secure-context">
          {String(window.isSecureContext)}
        </Field>
        <Field label="Page crypto.subtle" testId="subtle-available">
          {String(hasSubtleCrypto())}
        </Field>
        {boot.status === 'ok' && (
          <>
            <Field label="Worker isSecureContext" testId="worker-secure-context">
              {String(boot.value.env.isSecureContext)}
            </Field>
            <Field label="Worker crypto.subtle" testId="worker-subtle-available">
              {String(boot.value.env.hasSubtle)}
            </Field>
            <Field label="Boot to ready (ms)" testId="worker-boot-ms">
              {formatMs(boot.value.bootMs)}
            </Field>
          </>
        )}
      </Fields>
    </StepCard>
  )
}

function HashCard({ state }: { state: StepState<HashGenerated> }) {
  return (
    <StepCard
      title="SHA-256 of a generated 5 MiB buffer"
      description="hash-wasm from a lazy chunk (incremental createSHA256), compared with crypto.subtle where it exists."
      testId="step-hash"
      state={state}
    >
      {state.status === 'ok' && <HashDetails result={state.value} />}
    </StepCard>
  )
}

function HashDetails({ result }: { result: HashGenerated }) {
  const { hashWasm, subtle } = result
  const match = subtle === null ? 'n/a' : subtle.hex === hashWasm.hex ? 'match' : 'mismatch'
  const mibPerSecond = result.sizeBytes / (1024 * 1024) / (hashWasm.hashMs / 1000)
  return (
    <Fields>
      <Field label="Bytes" testId="hash-bytes">
        {result.sizeBytes}
      </Field>
      <Field label="Generate (ms)" testId="hash-generate-ms">
        {formatMs(result.generateMs)}
      </Field>
      <Field label="hash-wasm SHA-256" testId="sha256-hash-wasm" wide>
        {hashWasm.hex}
      </Field>
      <Field label="crypto.subtle SHA-256" testId="sha256-subtle" wide>
        {subtle?.hex ?? 'unavailable'}
      </Field>
      <Field label="Digests" testId="sha256-match">
        {match}
      </Field>
      <Field label="First import of hash-wasm" testId="hash-wasm-cold">
        {String(hashWasm.coldImport)}
      </Field>
      <Field label="hash-wasm import (ms)" testId="hash-wasm-import-ms">
        {formatMs(hashWasm.importMs)}
      </Field>
      <Field label="createSHA256, incl. WASM compile (ms)" testId="hash-wasm-init-ms">
        {formatMs(hashWasm.initMs)}
      </Field>
      <Field label="hash-wasm hash (ms)" testId="hash-wasm-hash-ms">
        {formatMs(hashWasm.hashMs)}
      </Field>
      <Field label="hash-wasm (MiB/s)" testId="hash-wasm-mib-per-s">
        {mibPerSecond.toFixed(0)}
      </Field>
      <Field label="crypto.subtle digest (ms)" testId="subtle-ms">
        {subtle ? formatMs(subtle.ms) : 'n/a'}
      </Field>
    </Fields>
  )
}

function SimplifyCard({ state }: { state: StepState<SimplifyGrid> }) {
  return (
    <StepCard
      title="Simplify a 20k-triangle grid to ~10%"
      description="meshoptimizer/simplifier from a lazy chunk; the compacted mesh comes back as transferred typed arrays."
      testId="step-simplify"
      state={state}
    >
      {state.status === 'ok' && <SimplifyDetails result={state.value} />}
    </StepCard>
  )
}

function SimplifyDetails({ result }: { result: SimplifyGrid }) {
  return (
    <Fields>
      <Field label="Input triangles" testId="simplify-input-triangles">
        {result.inputTriangles}
      </Field>
      <Field label="Target triangles" testId="simplify-target-triangles">
        {result.targetTriangles}
      </Field>
      <Field label="Output triangles" testId="simplify-output-triangles">
        {result.outputTriangles}
      </Field>
      <Field label="Output vertices" testId="simplify-output-vertices">
        {result.outputVertices}
      </Field>
      <Field label="Relative error" testId="simplify-error">
        {result.relativeError.toPrecision(3)}
      </Field>
      <Field label="First import of meshoptimizer" testId="meshopt-cold">
        {String(result.coldImport)}
      </Field>
      <Field label="meshoptimizer import (ms)" testId="meshopt-import-ms">
        {formatMs(result.importMs)}
      </Field>
      <Field label="Await ready, WASM instantiate (ms)" testId="meshopt-ready-ms">
        {formatMs(result.readyMs)}
      </Field>
      <Field label="Simplify + compact (ms)" testId="simplify-ms">
        {formatMs(result.simplifyMs)}
      </Field>
      <Field label="Bytes received (transferred)" testId="simplify-received-bytes">
        {result.indices.byteLength + result.positions.byteLength}
      </Field>
      <Field label="Indices and vertices consistent" testId="simplify-consistent">
        {String(isConsistentMesh(result))}
      </Field>
    </Fields>
  )
}

function FileDetails({ result, testIdPrefix }: { result: HashFile; testIdPrefix: string }) {
  return (
    <>
      <Field label="Name" testId={`${testIdPrefix}-name`}>
        {result.name}
      </Field>
      <Field label="Size (bytes)" testId={`${testIdPrefix}-size`}>
        {result.size}
      </Field>
      <Field label="Arrived as a File" testId={`${testIdPrefix}-is-file`}>
        {String(result.isFile)}
      </Field>
      <Field label="Slices read" testId={`${testIdPrefix}-slices`}>
        {result.slices}
      </Field>
      <Field label="SHA-256" testId={`${testIdPrefix}-sha256`} wide>
        {result.sha256}
      </Field>
      <Field label="Read + hash (ms)" testId={`${testIdPrefix}-ms`}>
        {formatMs(result.ms)}
      </Field>
    </>
  )
}

function FileProbeCard({ state }: { state: StepState<HashFile> }) {
  return (
    <StepCard
      title="File posted to the worker"
      description="A File of one million 'a' characters, read in the worker through File.slice() and hashed with hash-wasm."
      testId="step-file"
      state={state}
    >
      {state.status === 'ok' && (
        <Fields>
          <FileDetails result={state.value} testIdPrefix="file" />
          <Field label="Expected (FIPS 180-2 vector)" testId="file-expected-sha256" wide>
            {MILLION_A_SHA256}
          </Field>
          <Field label="Known answer" testId="file-match">
            {state.value.sha256 === MILLION_A_SHA256 ? 'match' : 'mismatch'}
          </Field>
        </Fields>
      )}
    </StepCard>
  )
}

function PickedFileCard({
  state,
  onPick,
}: {
  state: StepState<HashFile>
  onPick: (event: ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <StepCard
      title="Hash a file you pick"
      description="Same path as a dropped model file: the File goes to the worker, and the bytes never leave the browser."
      testId="step-picked"
      state={state}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="spike-file-input">File</Label>
        <Input id="spike-file-input" type="file" data-testid="file-input" onChange={onPick} />
      </div>
      {state.status === 'ok' && (
        <Fields>
          <FileDetails result={state.value} testIdPrefix="picked-file" />
        </Fields>
      )}
    </StepCard>
  )
}

function ViolationsCard({ violations }: { violations: Violation[] }) {
  return (
    <Card size="sm" className="md:col-span-2">
      <CardHeader>
        <CardTitle>CSP violations</CardTitle>
        <CardDescription>
          securitypolicyviolation events since this page mounted: from the document, and relayed
          from the worker&apos;s global scope (the page cannot listen there).
        </CardDescription>
      </CardHeader>
      <CardContent
        data-testid="csp-violations"
        data-count={violations.length}
        className="flex flex-col gap-2"
      >
        <p className="text-sm">
          Count: <span data-testid="csp-violation-count">{violations.length}</span>
        </p>
        {violations.length > 0 && (
          <ul className="flex flex-col gap-1 font-mono text-xs break-all">
            {violations.map((violation, index) => (
              <li key={`${index}-${violation.effectiveDirective}`} data-testid="csp-violation">
                [{violation.source}] {violation.effectiveDirective} blocked{' '}
                {violation.blockedURI || '(inline)'} at {violation.sourceFile || '?'}:
                {violation.lineNumber}
                {violation.sample && ` "${violation.sample}"`}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

/** Spike S4 (module worker + lazily loaded WASM under the production CSP). Dev-only route: /dev/spike-worker */
export function SpikeWorkerPage() {
  const [violations, setViolations] = useState<Violation[]>([])
  const [running, setRunning] = useState(false)
  const [completedRuns, setCompletedRuns] = useState(0)
  const [boot, setBoot] = useState<StepState<WorkerBoot>>(IDLE)
  const [hash, setHash] = useState<StepState<HashGenerated>>(IDLE)
  const [simplify, setSimplify] = useState<StepState<SimplifyGrid>>(IDLE)
  const [probe, setProbe] = useState<StepState<HashFile>>(IDLE)
  const [picked, setPicked] = useState<StepState<HashFile>>(IDLE)
  const clientRef = useRef<SpikeWorkerClient | null>(null)

  const addViolation = useCallback((violation: Violation) => {
    setViolations((list) => [...list, violation])
  }, [])

  useEffect(() => {
    const onViolation = (event: SecurityPolicyViolationEvent) =>
      addViolation(describePageViolation(event))
    document.addEventListener('securitypolicyviolation', onViolation)
    return () => document.removeEventListener('securitypolicyviolation', onViolation)
  }, [addViolation])

  useEffect(() => () => clientRef.current?.terminate(), [])

  /** Starts the worker on first use, as the ingest worker will, and reports its boot as a step. */
  const ensureWorker = async (): Promise<SpikeWorkerClient | undefined> => {
    clientRef.current ??= createSpikeWorkerClient(addViolation)
    const client = clientRef.current
    if (await runStep(setBoot, () => client.boot)) return client
    client.terminate()
    clientRef.current = null // the next attempt starts a fresh worker
    return undefined
  }

  const runSpike = async () => {
    setRunning(true)
    setHash(IDLE)
    setSimplify(IDLE)
    setProbe(IDLE)
    const client = await ensureWorker()
    if (client) {
      await runStep(setHash, () =>
        client.request({ kind: 'hash-generated', sizeBytes: GENERATED_BYTES }, hashGeneratedSchema),
      )
      await runStep(setSimplify, () =>
        client.request(
          {
            kind: 'simplify-grid',
            cellsPerSide: GRID_CELLS_PER_SIDE,
            targetRatio: SIMPLIFY_TARGET_RATIO,
          },
          simplifyGridSchema,
        ),
      )
      await runStep(setProbe, () =>
        client.request({ kind: 'hash-file', file: createProbeFile() }, hashFileSchema),
      )
    }
    setRunning(false)
    setCompletedRuns((count) => count + 1)
  }

  const hashPickedFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    if (!file) return
    const client = await ensureWorker()
    if (!client) return
    await runStep(setPicked, () => client.request({ kind: 'hash-file', file }, hashFileSchema))
  }

  const runStatus = running ? 'running' : completedRuns > 0 ? 'done' : 'idle'

  return (
    <div className="mx-auto flex w-full max-w-screen-lg flex-col gap-4 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Spike S4: worker and WASM under the CSP
        </h1>
        <p className="text-sm text-muted-foreground">
          Starts a module worker, lazily loads hash-wasm and meshoptimizer inside it, and lists
          every Content Security Policy violation from the page or the worker.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button data-testid="run-spike" disabled={running} onClick={() => void runSpike()}>
            {running ? 'Running…' : 'Run spike'}
          </Button>
          <p className="text-sm" aria-live="polite">
            Status: <span data-testid="spike-status">{runStatus}</span>
          </p>
        </div>
      </header>
      <div className="grid gap-4 md:grid-cols-2">
        <EnvironmentCard boot={boot} />
        <HashCard state={hash} />
        <SimplifyCard state={simplify} />
        <FileProbeCard state={probe} />
        <PickedFileCard state={picked} onPick={(event) => void hashPickedFile(event)} />
        <ViolationsCard violations={violations} />
      </div>
    </div>
  )
}
