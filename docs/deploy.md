# Deploying Mini Rack Planner

Mini Rack Planner is a static single-page app: `npm run build` produces `dist/`, and any server
that sends the right headers can host it. Two targets are maintained here:

- **Docker** (nginx), for self-hosting on a homelab box or a Raspberry Pi.
- **Azure Static Web Apps, Free plan**, for the public site.

Both send the same security headers, generated from one file (see
[Security headers](#security-headers)).

## Docker

### The image

| Stage   | Base                                          | Notes                                                                  |
| ------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| build   | `node:24-alpine` on the build host's platform | `npm ci`, `npm run build`                                              |
| runtime | `nginxinc/nginx-unprivileged:1.30-alpine`     | Copy-only: `dist/` plus the nginx config. Runs as uid 101 on port 8080 |

Because the build stage always runs natively and the runtime stage only copies files, one build
serves linux/amd64, linux/arm64 and linux/arm/v7 without emulation.

Build arguments:

| Argument                              | Used for                                                         |
| ------------------------------------- | ---------------------------------------------------------------- |
| `GIT_SHA`                             | Shown on the About page (first 12 characters). Defaults to `dev` |
| `VERSION`, `SOURCE_URL`, `BUILD_DATE` | OCI labels. CI sets them through `docker/metadata-action`        |

```sh
docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t mini-rack-planner .
```

### Running it

```sh
docker run -d --name mini-rack-planner --restart unless-stopped \
  --read-only --tmpfs /tmp -p 8080:8080 mini-rack-planner
```

- `--read-only --tmpfs /tmp` is supported and recommended: nginx writes only its pid file and
  temporary files, all under `/tmp`.
- The container needs no Linux capabilities (`--cap-drop ALL` works) and has a health check:
  `docker inspect --format '{{.State.Health.Status}}' mini-rack-planner`.
- `docker-compose.yml` runs the same setup: `docker compose up -d --build`, or with the published
  image: `MRP_IMAGE=ghcr.io/npab19/mini-rack-planner:latest docker compose up -d --no-build --pull always`.

On Windows in Git Bash, prefix these commands with `MSYS_NO_PATHCONV=1`; otherwise `/tmp` is
rewritten into a Windows path.

### What nginx serves

| Path                                                                                 | Response                                               | Cache-Control                                          |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------ |
| `/assets/*` (hashed build output)                                                    | The file, or a plain-text **404** if it does not exist | `public, max-age=31536000, immutable` (not on the 404) |
| `/`, `/index.html` and client routes such as `/plan/abc`                             | The SPA shell (`index.html`)                           | `no-cache`                                             |
| Other files at the root (`/favicon.svg`, `/theme-init.js`, `/manifest.webmanifest`…) | The file, or a 404 (never the SPA shell)               | `no-cache`                                             |
| `/healthz`                                                                           | `ok` (not logged)                                      | `no-store`                                             |

A missing chunk is a real 404 so that a tab left open across a deploy fails cleanly instead of
running HTML as JavaScript. JavaScript, CSS, JSON, SVG, the web manifest and WebAssembly are
gzipped. Every response, errors included, carries the security headers.

### HTTPS behind a reverse proxy

Opened from another device as `http://<lan-ip>:8080`, the app is not in a secure context, so
browsers withhold persistent storage, the clipboard API and `crypto.subtle`. The app copes, but a
TLS-terminating reverse proxy gives the full experience. For example, with Caddy:

```
rack.example.com {
  reverse_proxy mini-rack-planner:8080
  header Strict-Transport-Security "max-age=63072000; includeSubDomains"
  header Cross-Origin-Opener-Policy "same-origin"
}
```

The container does not send HSTS or `Cross-Origin-Opener-Policy` itself because it speaks plain
HTTP (browsers ignore COOP there and log an error); add both at the proxy as above.

### Published images (GHCR)

`.github/workflows/docker-publish.yml` builds and pushes `ghcr.io/npab19/mini-rack-planner`
for linux/amd64, linux/arm64 and linux/arm/v7:

| Event          | Tags                     |
| -------------- | ------------------------ |
| Push to `main` | `edge`, `sha-<short>`    |
| Tag `vX.Y.Z`   | `X.Y.Z`, `X.Y`, `latest` |

Layers are cached in the GitHub Actions cache, never as registry cache images. After the first
publish, open the package on GitHub (_Packages_), and under _Package settings_ change its
visibility to **public** so that `docker pull` works without logging in.

## Azure Static Web Apps (Free)

### One-time setup

1. In the Azure portal, create a **Static Web App**. Plan: **Free**. Under deployment details pick
   source **Other**: this repository's workflow deploys, so Azure does not create one.
2. On the new resource, open _Overview > Manage deployment token_ and copy the token.
3. In GitHub, add it under _Settings > Secrets and variables > Actions_ as the repository secret
   `AZURE_STATIC_WEB_APPS_API_TOKEN`.

Until the secret exists, the workflow skips the deploy with a warning instead of failing.

### Environments

`.github/workflows/azure-swa.yml` builds with Node 24 (`npm ci`, `npm run build`) and uploads
the prebuilt `dist/` (`skip_app_build`), so the site is exactly what CI built.

| Event                                         | Environment                                 |
| --------------------------------------------- | ------------------------------------------- |
| Push to `main`                                | `staging` (a named preview environment)     |
| Tag `vX.Y.Z`                                  | Production                                  |
| Pull request from a branch of this repository | Its own preview, deleted when the PR closes |
| Pull request from a fork                      | Nothing (forks get no secrets)              |

The Free plan allows only a few preview environments at once (3 at the time of writing), and
`staging` uses one of them. If deploys start failing for that reason, close stale PRs or delete
old environments under _Environments_ in the portal. Both workflows can also be started by hand
on `main` or on a tag (_Actions > Run workflow_).

### Routing and the post-deploy check

`public/staticwebapp.config.json` (copied into `dist/`) excludes `/assets/*` and other static
files from the SPA fallback, caches `/assets/*` as immutable and declares the `.webmanifest` and
`.wasm` MIME types. Its `globalHeaders` section is generated by `npm run headers`.

After each deploy the workflow requests `/`, a deep link and the entry script, and fails unless
each carries exactly the `Content-Security-Policy` from the build plus
`X-Content-Type-Options: nosniff`, and unless `/assets/does-not-exist.js` is a 404.

## Releases

`.github/workflows/release-please.yml` keeps a release PR open that bumps `package.json` and
`CHANGELOG.md` from the Conventional Commit titles on `main`. Merging it creates the tag `vX.Y.Z`
and a GitHub release, which should publish the `X.Y.Z`, `X.Y` and `latest` images and deploy SWA
production.

- Tags pushed with the default `GITHUB_TOKEN` do not start other workflows. Add a fine-grained
  personal access token for this repository (_Contents_ and _Pull requests_: read and write) as
  the secret `RELEASE_PLEASE_TOKEN` and the release tag triggers both workflows. Without it, run
  _Docker image_ and _Azure Static Web Apps_ by hand on the new tag.
- With only `GITHUB_TOKEN`, release-please also needs _Settings > Actions > General > Allow GitHub
  Actions to create and approve pull requests_.

## Security headers

`scripts/headers.ts` is the single source of the Content-Security-Policy and the other security
headers. It generates:

- `nginx/security-headers.conf`, included by `nginx/default.conf` at server level. nginx 1.30's
  `add_header_inherit merge` keeps those headers on locations that add their own `Cache-Control`.
- the `globalHeaders` of `public/staticwebapp.config.json` for SWA, plus HSTS, since SWA is
  always HTTPS.
- the `vite preview` headers, so local E2E runs see the production policy.

After editing `scripts/headers.ts`, run `npm run headers` and commit the regenerated files. CI runs
`npm run headers -- --check` and fails on drift.

## Troubleshooting

- **`npm ci` fails with `EPERM` or `EBUSY` on Windows:** the checkout is in a OneDrive folder and
  sync is locking files. Pause OneDrive sync while installing.
- **`invalid mount path` or a wrong `/tmp` in Docker commands from Git Bash:** prefix them with
  `MSYS_NO_PATHCONV=1`, or use PowerShell.
- **The container stops right after starting with `--read-only`:** check `docker logs`; the run
  needs `--tmpfs /tmp`.
