# Mini Rack Planner

Plan 3D-printed 10" homelab racks in your browser. Lay out your equipment to scale in 2D and 3D,
see which printed parts, filament, fasteners and gear a plan needs, and get a **"what I still
need" shopping list** when you extend a rack you already built. Save ideas, compare them and
share them as links.

The first supported frame is the KWS Rack v2 from MakerWorld; a generic 10" rack and custom
frames follow. The app is a static site: run it from one Docker image or on Azure Static Web
Apps (Free).

> **Status:** v0.1 is out and the full editor (M3b) is built. The foundations (M0), the rack and
> BOM engine (M1), persistence with the app shell (M2), the minimal editor (M3a) and the full
> editor (M3b) are in: record the rack you have, plan an extension by drag and drop or with the
> keyboard, let _Fit it for me_ place your equipment, add your own devices, mounts and frames,
> and get the shopping list of what to print and buy. Sharing and comparing ideas come next (M4).
> See [Features](#features-by-milestone), [docs/status/m0-m1.md](docs/status/m0-m1.md),
> [docs/status/m2.md](docs/status/m2.md), [docs/status/m3a.md](docs/status/m3a.md) and
> [docs/status/m3b.md](docs/status/m3b.md).

## A first plan (v0.1)

1. **Record my rack and plan an upgrade**: pick the frame and the sections you have built.
2. In _Recording what you have_, add your mounts from **Parts**: **Place**, then click the spot on
   the rack (or **Add at U…** to pick the U from a list). Add the devices in each mount from the
   inspector. Everything you add now is marked _In my rack_. Then **Done, start planning**.
3. Plan the change: the inspector's **Rack** tab sets the height (at the top or the bottom) and
   reorders sections; new parts are marked _To get_.
4. Open the **BOM**: the _Shopping list_ says what to print and buy, with the sum behind every
   line (_Why_). Tick _Got it_ as parts arrive, **Finish build** when it is built, or export a CSV.

On a computer you can also drag parts from **Parts**, or devices from **Equipment to fit**, onto
the rack, and drag placed parts to move them; a device dropped on empty space asks which mount to
use. **Fit it for me** places everything waiting in Equipment to fit and grows the rack if needed.
A part the catalog lacks can be added under **My parts** (or from the Parts panel); it travels
with every plan that uses it.

Everything works with the keyboard too (`?` lists the keys; `F6` moves between panels). On a
phone the panels open as sheets: tap **Place**, then tap the rack; long-press a part to move it
and pinch to zoom.

## Privacy: everything stays in your browser

- Plans, custom parts and model files are stored in your browser (IndexedDB). There are no
  accounts, no backend and no analytics.
- The app makes no network requests to other sites. It never contacts MakerWorld.
- Model files are **import-only**. You download them from the designer's page and add them in the
  app: a MakerWorld 3MF or ZIP, or any STL/3MF (Printables, Thingiverse, your own CAD). They are
  read locally and never uploaded, exported or re-hosted.
- Backups are JSON: plans, custom parts, alignments and file fingerprints. Add the same model files
  again after a restore and they relink automatically (matched by SHA-256).
- A strict Content-Security-Policy (no inline scripts, no third-party hosts) is enforced by both
  the Docker image and Azure Static Web Apps.

## Features by milestone

| Milestone                   | What you get                                                                             | Status             |
| --------------------------- | ---------------------------------------------------------------------------------------- | ------------------ |
| M0 Foundations              | App shell, Docker image, Azure SWA hosting, CI/CD, security headers                      | Built              |
| M1 Domain and BOM           | Rack and BOM engine, KWS Rack v2 catalog entry, `npm run bom -- <plan.json>`             | Built              |
| M2 Persistence              | Plans saved in the browser, new-plan wizard, JSON import/export, settings, diagnostics   | Built              |
| M3a Minimal editor (v0.1)   | 2D rack editor, Have/Need, BOM drawer, shopping list, CSV                                | Built (v0.1 ready) |
| M3b Full editor             | Drag and drop, touch, _Fit it for me_, custom devices and parts                          | Built              |
| M4 Share and compare (v0.2) | Share links, read-only viewer, compare ideas, Markdown/SVG/PNG export                    | Planned            |
| M5 File import helpers      | Add a part from a MakerWorld 3MF/ZIP or a plain STL: print rows, U and depth suggestions | Planned            |
| M6 3D view                  | Lazy-loaded 3D view of the plan with accurate proxies                                    | Planned            |
| M7 Real models (v1.0)       | Your downloaded printed parts in 3D, relinked automatically after a restore              | Planned            |

## Quick start (development)

Requires Node 24 (npm 11). Docker is needed only for the end-to-end tests.

```sh
npm ci
npm run dev          # http://localhost:5173
```

| Command                              | What it does                                                                |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `npm run build`                      | Type-check (`tsc -b`) and build `dist/`                                     |
| `npm run preview`                    | Serve `dist/` on http://localhost:4173 with the production security headers |
| `npm test`                           | Unit and property tests (Vitest)                                            |
| `npm run typecheck` / `npm run lint` | TypeScript project references / oxlint                                      |
| `npm run e2e`                        | Playwright against a running production build (see below)                   |
| `npm run check-budgets`              | Bundle-size budgets on `dist/` (run after a build)                          |
| `npm run headers`                    | Regenerate the nginx and SWA header files from `scripts/headers.ts`         |
| `npm run validate-catalog`           | Check the catalog files                                                     |
| `npm run bom -- <plan.json>`         | Shopping list of a plan file (`--full`, `--json`, `--spares`)               |

> **OneDrive tip:** if the repository lives in a OneDrive folder and `npm ci` fails with `EPERM`
> or `EBUSY`, pause OneDrive sync while it runs (sync locks files in `node_modules`).

### End-to-end tests

The suite runs against the production container, the same way CI does:

```sh
docker build --build-arg GIT_SHA=local -t mini-rack-planner:dev .
docker run -d --rm --name mrp --read-only --tmpfs /tmp -p 8080:8080 mini-rack-planner:dev
npx playwright install chromium          # once
npm run e2e                              # projects prod-secure, prod-lan and mobile
docker stop mrp
```

Every test fails on console errors, uncaught exceptions and CSP violations. `prod-lan` opens
the same server as `http://lan.test:8080`, which is not a secure context, like a phone on your
LAN. For a quicker loop, run `npm run build && npm run preview`, then
`BASE_URL=http://localhost:4173 npm run e2e -- --project=prod-secure` (`vite preview` cannot
serve the `lan.test` name, and it answers unknown files with `index.html`, so the nginx-only
checks are skipped there).

> **Windows, Git Bash:** prefix Docker commands with `MSYS_NO_PATHCONV=1`; otherwise Git Bash
> rewrites `--tmpfs /tmp` into a Windows path. PowerShell needs nothing extra.

## Run it with Docker

```sh
docker build -t mini-rack-planner .
docker run -d --name mini-rack-planner --restart unless-stopped \
  --read-only --tmpfs /tmp -p 8080:8080 mini-rack-planner
```

Then open http://localhost:8080. Or use Compose, which builds this checkout with the same
hardening (read-only root filesystem, no capabilities, health check):

```sh
docker compose up -d --build
```

Published images: `ghcr.io/npab19/mini-rack-planner` for linux/amd64,
linux/arm64 and linux/arm/v7 (Raspberry Pi).

| Tag                      | Built from              |
| ------------------------ | ----------------------- |
| `latest`, `X.Y.Z`, `X.Y` | Release tags (`vX.Y.Z`) |
| `edge`, `sha-<short>`    | Every push to `main`    |

The image is nginx (unprivileged, port 8080) serving static files; `GET /healthz` answers `ok`.
Details, including HTTPS behind a reverse proxy: [docs/deploy.md](docs/deploy.md).

## Hosting on Azure Static Web Apps (Free)

1. In the Azure portal, create a Static Web App on the **Free** plan with deployment source
   **Other** (GitHub Actions in this repo do the deploying).
2. Copy its **deployment token** (_Manage deployment token_) into the repository secret
   `AZURE_STATIC_WEB_APPS_API_TOKEN`.
3. Pushes to `main` deploy to the `staging` environment, release tags `vX.Y.Z` deploy to
   production, and pull requests from this repository get a preview that is removed when the
   PR closes. Each deployment is checked for the security headers.

More in [docs/deploy.md](docs/deploy.md).

## LAN and secure contexts

Opening the Docker app from another device as `http://192.168.x.x:8080` works, but plain HTTP
on a LAN address is not a _secure context_. Browsers then switch off `crypto.subtle`,
`crypto.randomUUID`, `navigator.storage` (persistent storage) and the clipboard API. The app does
not depend on them and falls back where it can. For the full experience, put the container
behind an HTTPS reverse proxy (Caddy, Traefik, nginx) or use it on the same machine through
`http://localhost:8080`.

Browser storage is per origin: plans saved at `http://192.168.1.10:8080` are not visible at
`https://rack.example.com`. Move them with JSON export and import.

## MakerWorld and model files

- **Never scraped.** The app, its scripts and its tests never contact MakerWorld; its terms
  forbid robots and scrapers. Catalog entries are entered and checked by people.
- **Links and facts only.** A catalog entry stores the designer's page link, the designer's name,
  the licence label exactly as shown, and facts such as U height, part counts, grams and hardware.
  No images, no copied descriptions, no files.
- **Your files stay yours.** You download models yourself and add them in the app (import only).
  Respect each designer's licence; the app never redistributes model files.
- **Never in the repository.** `.stl`, `.3mf`, `.step`, `.zip` and `.gcode` files are ignored, and
  CI fails if one is committed. Tests generate their fixtures in code.

## Contributing

Issues, pull requests and catalog submissions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
for the workflow (GitHub Flow, Conventional Commits) and the catalog rules.

## Licences

- Code: [MIT](LICENSE).
- Catalog data (`catalog/`): [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- The printed designs the catalog links to stay under their designers' own licences.
