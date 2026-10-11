# Spike S4: module worker and lazy WASM under the production CSP

**Decision: go.** A module worker can lazily load hash-wasm and meshoptimizer under the production CSP from `scripts/headers.ts`. This works on a secure origin and on the insecure LAN origin, with zero CSP violations. The worker path needs no CSP change. The spike also turned up two header/config follow-ups (see [Requests](#requests-for-other-owners)).

- Date: 2026-10-11.
- Environment: Chromium 156.0.8078.4 (Playwright 1.64, `chromium` channel, new headless), Vite 8.3.4 with Rolldown 1.2.13, hash-wasm 4.12.0, meshoptimizer 1.3.0, Windows 11.
- Scope: this is the import path for model files, whether from MakerWorld or any other STL/3MF source. The page hands a `File` to a worker, which hashes and processes it. Nothing is uploaded or exported.

## What was built

- **`src/workers/spike-hash.worker.ts`** is a module worker.
  - Its first import is `../lib/shared/zod-setup`, and zod validates every request.
  - `hash-generated`: lazily runs `import('hash-wasm')`, then hashes a deterministic 5 MiB buffer with the incremental `createSHA256()` API in 1 MiB updates. It also runs `crypto.subtle.digest` where that API exists.
  - `simplify-grid`: lazily runs `import('meshoptimizer/simplifier')` and waits for `MeshoptSimplifier.ready`. It simplifies a 100 × 100 height-field grid (20,000 triangles) to 10%, calls `compactMesh`, and transfers the index and position buffers back to the page.
  - `hash-file`: hashes a posted `File` through 256 KiB `File.slice()` windows.
  - It relays `securitypolicyviolation` events from its own global scope to the page.
- **`src/features/dev/SpikeWorkerPage.tsx`** serves `/dev/spike-worker` in dev builds and in builds made with `VITE_SPIKES=1`.
  - It starts the worker on the first click and validates the worker's replies with zod.
  - It shows every value under a `data-testid`.
  - It posts a `File` of 1,000,000 × `a` to check a known answer (the FIPS 180-2 vector), and also hashes any file picked with `<input type="file">`.
  - It lists CSP violations from the document and from the worker relay.
- **`scripts/spikes/csp-check.ts`** runs the whole check end to end. It:
  1. builds with `VITE_SPIKES=1` into `dist-spikes/` and inspects the chunks;
  2. serves the build with Vite preview and checks the response headers;
  3. drives Chromium on both origins and runs the CSP experiments;
  4. stops the servers and deletes `dist-spikes/`.

## How it was served

- **Server.** `vite preview` with `preview.headers = securityHeaders()`. Every response carries the production headers, including the worker and library chunks under `/assets/`, so this matches nginx `add_header … always` and SWA `globalHeaders`.
  - A fetch of four responses returned 200, exactly `CSP`, `nosniff` and, for the three JavaScript chunks, `text/javascript`. The four were the page (SPA fallback), the worker chunk and both library chunks.
- **Secure origin.** `http://localhost:4181`. Localhost counts as potentially trustworthy, so the page is a secure context.
- **Insecure origin.** `http://lan.test:4181`, with Chromium launched using `--host-resolver-rules=MAP lan.test 127.0.0.1`. This matches the plain-HTTP LAN Docker case. The browser did not upgrade the URL to HTTPS.
- **Host check.** Vite preview checks the `Host` header, so the script sets `allowedHosts: ['lan.test']`. The CLI has no flag for this, so the script uses the preview JS API with the same options as `vite preview --outDir dist-spikes --port 4181 --strictPort`. nginx and SWA do no such check.

## Results

| Measure                                                              | Secure (`http://localhost:4181`)                                         | Insecure (`http://lan.test:4181`)                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `isSecureContext`, page / worker                                     | true / true                                                              | false / false                                                          |
| `crypto.subtle`, page / worker                                       | present / present                                                        | absent / absent                                                        |
| Worker start to `ready` message                                      | 15.6 ms                                                                  | 25.9 ms                                                                |
| SHA-256 of 5 MiB, hash-wasm                                          | `47bb0074…b490d93982`                                                    | same digest                                                            |
| SHA-256 of 5 MiB, `crypto.subtle`                                    | same digest                                                              | unavailable                                                            |
| hash-wasm import (cold) / `createSHA256()` including WASM compile    | 3.7 / 1.4 ms                                                             | 6.4 / 2.1 ms                                                           |
| hash-wasm hashing in 1 MiB updates                                   | 19.9 ms (about 250 MiB/s)                                                | 25.0 ms (about 200 MiB/s)                                              |
| `crypto.subtle` one-shot digest                                      | 3.6 ms                                                                   | n/a                                                                    |
| meshoptimizer import (cold) / `await ready`                          | 6.2 / 0.6 ms                                                             | 8.1 / 0.9 ms                                                           |
| Simplify + compact                                                   | 20,000 → 1,999 triangles, 1,051 vertices, relative error 6.4e-4, 10.4 ms | same result, 10.7 ms                                                   |
| Transferred back to the page                                         | 36,600 bytes in 2 `ArrayBuffer`s                                         | same                                                                   |
| `File` probe, 1,000,000 × `a`, 4 slices                              | FIPS 180-2 vector, 7.3 ms                                                | same, 8.9 ms                                                           |
| Picked file (`<input type=file>`), 3,145,851 random bytes, 13 slices | equals `node:crypto`, 18.4 ms                                            | equals `node:crypto`, 25.5 ms                                          |
| CSP violations (document, worker relay, before mount)                | 0                                                                        | 0                                                                      |
| Console errors                                                       | 0                                                                        | 1: Chrome's COOP notice, a header issue ([finding 1](#other-findings)) |

The full 5 MiB digest is `47bb007417221f0eadc05a508c7cfff6deeb7dccfc647de2e77953b490d93982`. The timings come from one run on a desktop machine, so read them as orders of magnitude.

## CSP: what is actually required

Each experiment served the same build with one directive changed, on the secure origin. Every response carried the changed policy unless the row says otherwise.

| Experiment                     | Policy change                                                            | Outcome                                                                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-wasm-unsafe-eval`          | `script-src 'self'`                                                      | The worker boots, but WASM fails. hash-wasm fails in `WebAssembly.compile()` (inside `createSHA256()`), and meshoptimizer fails in `WebAssembly.instantiate()`, which shows up as a rejected `ready`. The worker relays one violation per library: `script-src`, blocked `wasm-eval`. |
| `worker-src-none`              | `worker-src 'none'`                                                      | The worker is blocked. The page gets a `worker-src` violation and a console error. The `Worker`'s `error` event carries no message. This run is the control that proves the listeners work.                                                                                           |
| `no-worker-src`                | `worker-src` removed                                                     | Everything works, because the policy falls back to `script-src 'self'`.                                                                                                                                                                                                               |
| `connect-src-self`             | `connect-src 'self'` (no `blob:`)                                        | Everything works.                                                                                                                                                                                                                                                                     |
| `worker-response-without-wasm` | Document: production policy. Worker chunk response: `script-src 'self'`. | WASM is blocked inside the worker.                                                                                                                                                                                                                                                    |
| `document-without-wasm`        | Document: `script-src 'self'`. Worker chunk response: production policy. | Everything works.                                                                                                                                                                                                                                                                     |

Conclusions:

- **`'wasm-unsafe-eval'` is required, and both libraries need it.** Each one compiles WebAssembly from bytes embedded in its JavaScript:
  - hash-wasm compiles in `createSHA256()` (`WebAssembly.compile`);
  - meshoptimizer compiles as soon as the simplifier module is evaluated (`WebAssembly.instantiate`), and the failure surfaces through `MeshoptSimplifier.ready`.

  Chrome's error message names `'unsafe-eval'`, but `'wasm-unsafe-eval'` is the narrower and correct keyword. `'unsafe-eval'` is not needed: the worker reported zero violations while zod parsed every request with `jitless` set.

- **The worker obeys the CSP of its own script response, not the document's** (Chromium 156). So `'wasm-unsafe-eval'` must be in the policy served with `/assets/*.js`. The document itself compiles no WASM today, but keep one policy for every response.
- **`worker-src 'self'` is enough**, because the worker is a same-origin chunk. Without `worker-src`, the fallback to `script-src 'self'` also works. Keep the directive explicit so that widening `script-src` later does not widen workers too.
- **`blob:` is not needed anywhere on this path.**
  - No worker is created from a blob, and the `File` is posted directly and read with `File.slice()`, so there are no object URLs.
  - `connect-src blob:` is unused by the worker path: the `connect-src-self` experiment passed without it.
  - `img-src blob:` was not exercised; thumbnails and screenshots come in later milestones.
  - Two things would need `worker-src blob:`: Vite's `?worker&inline` and meshoptimizer's `MeshoptDecoder.useWorkers()`. Do not use either.

## Chunking

Sizes use 1 kB = 1000 bytes, as Vite reports them.

| Chunk                             | Raw     | Gzip    | How it loads                                                                               |
| --------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------ |
| `spike-hash.worker-[hash].js`     | 77.7 kB | 22.7 kB | `new Worker(new URL('/assets/…', import.meta.url), { type: 'module' })` on the first click |
| `index.esm-[hash].js` (hash-wasm) | 18.1 kB | 7.1 kB  | `import()` from the worker                                                                 |
| `meshopt_simplifier-[hash].js`    | 53.7 kB | 19.3 kB | `import()` from the worker                                                                 |

- **Lazy loading.** The worker loads both library chunks with dynamic `import()` only, never with a static import. None of the initial chunks (the entry and modulepreloads in `index.html`) contain WASM library code, and the page chunk refers to the worker only by URL.
- **No `.wasm` files.** Both libraries inline their binaries in JavaScript: hash-wasm as base64 and meshoptimizer as a packed string. So there is no `application/wasm` MIME type and no `instantiateStreaming`, and the `.wasm` entry in the SWA `mimeTypes` is unused (harmless).
- **hash-wasm tree-shakes to SHA-256 only.** The result is 7 kB gzip; the full ESM build is 216 kB minified. Three import styles give the same result with Rolldown 1.2.13 (the package declares `sideEffects: false`):
  - a destructured `await import()`;
  - `(await import()).createSHA256`;
  - a static named import.
- **Import `meshoptimizer/simplifier`, not `meshoptimizer`.** The root entry re-exports five modules and does not declare `sideEffects: false`, and each module compiles its WASM when it is evaluated. Standalone Rolldown bundles of a destructured `import()` of each entry:
  - root `meshoptimizer`: 147.0 kB, 51.9 kB gzip, six `WebAssembly.instantiate` call sites;
  - `meshoptimizer/simplifier`: 53.7 kB, 19.2 kB gzip, one call site.
- **The worker is a separate Rolldown build** and shares no chunks with the app.
  - zod is bundled again inside it and makes up most of the 22.7 kB gzip worker entry, so every worker that imports `zod-setup` pays that cost.
  - `vite:preloadError` does not exist inside workers.
- **Stable names.** The chunk file names (content hashes) were identical across two builds.

## Other findings

1. **COOP notice on plain HTTP.** On every page load of the plain-HTTP origin, Chrome logs an error: "The Cross-Origin-Opener-Policy header has been ignored, because the URL's origin was untrustworthy…". The cause is that `scripts/headers.ts` sends COOP on every transport, nginx included. This notice would fail the planned prod-lan E2E rule "fail on any console error". `csp-check.ts` reports it as a NOTE instead of failing; the secure run still tolerates zero console errors.
2. **A CSP-blocked WASM compile inside a worker is invisible from the page.** Only the worker relay surfaced it.
   - The `securitypolicyviolation` event fires only on the worker's global scope.
   - When the code catches the `CompileError`, Chrome writes nothing to the console. Playwright's console listener does receive worker console messages, and it saw nothing.
3. **Dev server only: a cold dependency cache breaks the first lazy import.** The first use of the worker's `import('meshoptimizer/simplifier')` fails with "Failed to fetch dynamically imported module". Vite discovers the dependency only at runtime and re-optimizes; the second run works. Either of these fixes it, and both were verified with a fresh cache:
   - `optimizeDeps.entries: ['index.html', 'src/workers/**/*.worker.ts']`;
   - `optimizeDeps.include: ['hash-wasm', 'meshoptimizer/simplifier']`.
4. **React Router warning.** Router logs "No `HydrateFallback` element provided to render during initial hydration" as a console warning, not an error.

## Decision and recommendations for the M7 ingest worker

1. **Create the worker on the first file drop**, with the literal form `new Worker(new URL('./ingest.worker.ts', import.meta.url), { type: 'module' })`. Vite only rewrites this exact pattern into a same-origin chunk, which `worker-src 'self'` covers.
2. **Make `../lib/shared/zod-setup` the first import and validate requests with zod.** The spike shows this runs inside the worker without violations.
3. **Hash with hash-wasm's incremental `createSHA256()` on every origin.** It gives the same digests as `crypto.subtle` and the same digests on HTTPS and LAN, at about 200 to 250 MiB/s here.
   - Do not use `crypto.subtle`. It is missing on the LAN origin, and its digest is one-shot, so the whole file would have to sit in memory.
   - Every ingest hashes, so a static hash-wasm import in the ingest worker is fine: it costs 7 kB gzip and saves a round trip. A lazy import also works, and either way only SHA-256 is bundled.
4. **Load `meshoptimizer/simplifier` lazily**, only when a mesh needs simplifying. Await `MeshoptSimplifier.ready`, then call `compactMesh` before transferring the result.
5. **Post the `File` itself to the worker** and read it with `file.slice(start, end).arrayBuffer()`. Structured clone shares the underlying blob, so there is no copy and no object URL. This random access is exactly what the central-directory unzip needs, and it works on both origins.
6. **Transfer results with `postMessage(message, [buffers])`.** Only transfer views that own their whole `ArrayBuffer`; the spike's `ownedBuffer` guard checks this.
7. **Relay `securitypolicyviolation` events from the worker** to the main thread and into the diagnostics ring buffer, and make E2E fail on relayed violations. Page listeners and console checks alone miss them ([finding 2](#other-findings)).
8. **Map failures to clear messages for users and diagnostics:**
   - A `CompileError` that mentions the Content Security Policy means "WASM blocked by the server's Content-Security-Policy": the `/assets/*.js` responses need `'wasm-unsafe-eval'`.
   - A `Worker` `error` event with no message means the worker failed to load. The cause is a `worker-src` block, a 404 after a deploy, or a wrong MIME type. Reuse the stale-deploy flow ("New version available — reload").
   - If a lazy `import()` inside the worker fails (for example a stale chunk after a deploy), report it to the main thread explicitly, because `vite:preloadError` does not fire in workers. Memoised loaders should reset on failure so that a retry can succeed, as the spike's `lazyModule` does.
9. **Put the message protocol types in one DOM-free module** that both sides import, for example `src/workers/ingest.protocol.ts` or a file under `src/lib/shared/`. If app code imported the worker file itself, the worker file would be type-checked under the DOM lib. The spike duplicates the message shapes only because of file ownership.
10. **Make sure every response carries the CSP**, especially `/assets/*.js`, because the worker takes its policy from its own script response.
    - nginx: watch `add_header` inheritance in the `/assets/` location (the plan's `add_header_inherit merge`).
    - SWA: confirm with the post-deploy check that route headers do not replace `globalHeaders`.
    - A worker chunk served without a CSP runs unrestricted. WASM still works, so nothing fails functionally, which means the header curl checks must assert the CSP on a worker chunk.

## Not covered yet

- **The nginx Docker image and SWA staging.** This spike used Vite preview with the same headers. The CI E2E against the Docker image (prod-secure and prod-lan) and the SWA post-deploy check should repeat this page or port its assertions.
- **Firefox and WebKit.** Only Chromium was tested. The nightly projects should confirm three things in those engines: `'wasm-unsafe-eval'` support, module workers, and the worker taking its CSP from its own response. Any engine without `'wasm-unsafe-eval'` would block WASM under this policy.
- **Real model files.** The spike hashes synthetic data only; M7's local-models lane covers real files.

## Requests for other owners

- **`scripts/headers.ts`, then regenerate the nginx snippet:** send `Cross-Origin-Opener-Policy` only with `{ https: true }` (SWA), the same way HSTS is handled. Otherwise the prod-lan E2E must allow-list Chrome's COOP notice.
- **`scripts/headers.ts` (optional):** drop `blob:` from `connect-src`, since the worker path does not use it. Keep it only if a later feature fetches object URLs.
- **`vite.config.ts`:** set `optimizeDeps.entries: ['index.html', 'src/workers/**/*.worker.ts']` ([finding 3](#other-findings)).
- **`.gitignore`:** add `dist-spikes/`. The script deletes the folder when it finishes, but `--keep` leaves it in place.

## Re-run

```sh
npx tsx scripts/spikes/csp-check.ts            # build, check, clean up (about a minute)
npx tsx scripts/spikes/csp-check.ts --keep     # keep dist-spikes/ for inspection
npx tsx scripts/spikes/csp-check.ts --skip-build --headed --json out.json
```
