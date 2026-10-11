# Mini Rack Planner — working notes for Claude

Browser-only planner for 3D-printed 10" homelab racks: to-scale 2D/3D layout, a BOM and a "what I still need" shopping list, plus saved and compared ideas. It ships as a static SPA in Docker (nginx) and on Azure Static Web Apps Free.

The approved plan is the source of truth for scope and design:
`C:\Users\npab1\.claude\plans\alright-new-project-i-eventual-penguin.md`.
Read the sections relevant to your task before writing code.

## Commands

- `npm run dev`: Vite dev server
- `npm run build`: `tsc -b` + Vite build
- `npm run typecheck`
- `npm test`: Vitest projects `unit` (node) and `dom` (jsdom)
- `npm run lint`: oxlint
- `npm run headers`: regenerates `nginx/security-headers.conf` and `public/staticwebapp.config.json` from `scripts/headers.ts`. `--check` fails on drift.
- `npm run validate-catalog`
- `npm run bom -- <plan.json>`
- `npm run e2e`

## Hard rules

- **Never contact MakerWorld or any external host** from app code, scripts or tests (MakerWorld ToS §9). The app makes no network calls at all.
- **Never commit model files** (`*.stl`, `*.3mf`, `*.step`, `*.zip`, `*.gcode`). Test fixtures are generated in code. Real files are read only via `MRP_LOCAL_MODELS=<dir>`, which lives outside the repo.
- Catalog entries store links and facts only: no images, no copied descriptions.
- **Don't add or upgrade dependencies** without explicit approval. Versions in `package.json` are pinned exactly. React must stay `<19.4`, the @react-three/fiber peer range.
- Don't commit or push unless the user asks. The workflow is GitHub Flow: issue → `feature/<#>-slug` → squash-merged PR with a Conventional Commit title.

## Architecture boundaries

- `src/domain/**`: pure TypeScript.
  - No React, DOM, Dexie, three or `import.meta.glob`.
  - Imports inside domain are **relative** (`./bom.ts`-style without the extension is fine).
  - It is type-checked under the WebWorker lib (`tsconfig.worker.json`), so DOM APIs fail the build.
- `src/lib/shared/**`: DOM-free helpers shared by the app, workers and Node scripts.
- `src/catalog/**`: the only place that uses `import.meta.glob` to load `catalog/**/*.json`.
- `three`, `@react-three/*` and `meshoptimizer` are imported only under `src/features/viewer3d/**` (loaded via `React.lazy`) and `src/workers/**`. Initial-bundle budgets are enforced by `scripts/check-budgets.ts`.
- Workers are module workers: `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`.
- `src/main.tsx` must import `./lib/shared/zod-setup` first, and every worker entry must too. It sets `z.config({ jitless: true })` so the strict CSP never sees `new Function`.
- Modules that `main.tsx` imports statically must **not build zod schemas at module load**. Rolldown evaluates the whole static graph before `main.tsx` body runs `z.config`, so such modules would trip the CSP. Load them with a dynamic `import()` or `React.lazy` instead; `AppLayout` and the plan store already do this, and E2E fails on any CSP violation.

## Conventions

- **Naming:** React components `PascalCase.tsx` with named exports; hooks `useThing.ts`; other modules `camelCase.ts`. Tests sit next to their code as `*.test.ts(x)`.
- **Units:**
  - Millimetres everywhere.
  - Rack positions and heights are **integer sixths of a U** (1U = 6). Constants live in `src/domain/geometry.ts`.
  - Rack frame axes: X right, Y up (0 = bottom of U1), Z toward the viewer (0 = rail front face).
- **Schemas:** zod 4 schemas live in `src/domain/schema/`. Infer TS types from them (`z.infer`), and validate every external input (catalog files, imports, share links).
- **UI:** shadcn/ui on **Base UI** (style `base-nova`). Base UI uses the `render` prop for polymorphism (`<Button render={<Link to="/" />} />`), not `asChild`. Icons come from `lucide-react`. Class merging uses `cn` from `@/lib/utils`.
- **Accessibility:** never rely on colour alone (Have/Need, valid/invalid). Keyboard paths and aria-live announcements are required for editor actions.
- **Feature detection:** the app must work on insecure LAN origins (plain-HTTP Docker). Don't assume `crypto.subtle`, `crypto.randomUUID`, `navigator.storage` or `navigator.clipboard` exist.
- **Testing:** domain logic gets unit tests plus fast-check properties. Avoid snapshotting large objects; assert meaningful numbers. Golden BOM fixtures live in `fixtures/`.

## Repo facts

- The repo lives in OneDrive and the path has spaces, so quote paths. Files use LF line endings (`.gitattributes`).
- Node 24, npm 11, Docker 29 and `gh` are available locally. There is no Azure CLI.
