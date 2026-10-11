# Contributing to Mini Rack Planner

Thanks for helping. This project uses **GitHub Flow**: `main` is always deployable, every change
starts as an issue and lands through a squash-merged pull request.

```
issue  ->  feature/<#>-slug  ->  PR (CI + review)  ->  squash-merge to main  ->  deploy
main --auto--> staging        vX.Y.Z tag --> production
```

## Workflow

1. **Open an issue** with one of the forms: Feature, Bug, Chore or Catalog submission. No quick
   fixes straight to `main`.
2. **Branch from an up-to-date `main`**, named `<type>/<issue#>-<short-slug>`:

   | Prefix     | Use for                                              |
   | ---------- | ---------------------------------------------------- |
   | `feature/` | New capability or enhancement                        |
   | `bug/`     | Something broken                                     |
   | `chore/`   | Tooling, dependencies, CI, refactoring, catalog data |
   | `docs/`    | Documentation only                                   |

   ```sh
   gh issue develop 12 --name feature/12-bom-drawer --base main --checkout
   # or: git switch main && git pull --ff-only && git switch -c feature/12-bom-drawer
   ```

3. **Keep it small.** One issue, one branch, one PR. Split unrelated work into its own issue.
4. **Open a PR** that fills in the template and says `Closes #12`. CI must be green: `build`
   (type-check, tests, build, budgets) and `e2e` (the Docker image under Playwright).
5. **Squash-merge.** The PR title becomes the commit on `main`, so write it as a Conventional
   Commit. The branch is deleted after merge.

## Commit messages and PR titles

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): imperative summary`.

- Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`,
  `revert`.
- Scopes are optional, for example `domain`, `bom`, `editor`, `viewer3d`, `catalog`, `docker`, `ci`.
- Breaking changes: `feat(share)!: …` or a `BREAKING CHANGE:` footer.

release-please reads these titles to write `CHANGELOG.md` and pick the next version: `feat`
bumps the minor version and `fix` the patch version. Before 1.0, breaking changes bump the minor
version too.

```
feat(editor): move a placement with the arrow keys
fix(bom): round hardware up once per aggregated line
chore(deps): bump vite to 8.3.5
```

## Before you open a PR

```sh
npm run typecheck
npm run lint
npm test
npm run build && npm run check-budgets
npm run headers -- --check        # only if you touched scripts/headers.ts
npm run validate-catalog          # only if you touched catalog/
```

Run the end-to-end suite against the container as described in the
[README](README.md#end-to-end-tests).

## Ground rules

- **No network calls.** The app, scripts and tests never contact MakerWorld or any other external
  host. Everything works offline from the static build.
- **No model files in the repository** (`.stl`, `.3mf`, `.step`, `.zip`, `.gcode`). Generate test
  fixtures in code; real files are read only from `MRP_LOCAL_MODELS=<dir>` outside the repository.
- **Dependencies are pinned.** Ask in the issue before adding or upgrading one. React stays below
  19.4 until `@react-three/fiber` widens its peer range.
- **Architecture boundaries** are linted: `src/domain` is pure TypeScript (no React, Dexie, three or
  `@/` imports), and `three`, `@react-three/*` and `meshoptimizer` live only in
  `src/features/viewer3d` and `src/workers`, so they stay out of the initial bundle.
- **Accessibility:** never rely on colour alone, give every editor action a keyboard path, and keep
  axe clean.
- **Insecure origins:** the app must work on plain-HTTP LAN Docker, so do not assume
  `crypto.subtle`, `crypto.randomUUID`, `navigator.storage` or `navigator.clipboard`.

## Catalog contributions

The shared catalog (`catalog/`) describes rack frames, printed parts, devices and hardware. It is
published under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); by contributing an
entry you agree to license it that way.

- **One JSON file per entry** under `catalog/{frames,items,devices,hardware,alignments}`. The file
  name is the entry id in kebab-case.
- **Links and facts only.** Store the designer's page in `source.url`, the designer's name and the
  licence label exactly as the page shows them, and facts: sizes in millimetres, U height, part
  counts, grams and print time, hardware. **No images, no copied description text, no model
  files**, no screenshots.
- **Verified metadata.** Every entry records `verified` (who, when and how): calipers on a print,
  grams from Bambu Studio or OrcaSlicer, the designer's hardware table. Values you could not check
  stay out or are marked unverified.
- **Ids are permanent.** Never rename or remove an id. To retire one, keep the entry or map the old
  id to its replacement in `catalog/replaced.json`; `validate-catalog` checks this against
  `ids.lock`.
- **Enter data by hand** from public pages or your own downloads. Never script MakerWorld (its
  terms forbid robots and scrapers), and do not copy other projects' lists.
- Run `npm run validate-catalog` before you open the PR. Entries that are not ready for a PR can go
  in a **Catalog submission** issue instead.

## Repository setup (maintainers)

```sh
gh label create feature --color 1D76DB --description "New capability or enhancement" --force
gh label create bug     --color D73A4A --description "Something isn't working"        --force
gh label create chore   --color FBCA04 --description "Maintenance, tooling, CI, deps" --force
gh label create docs    --color 0E8A16 --description "Documentation"                  --force
gh label create catalog --color 5319E7 --description "Catalog data submission"        --force

gh repo edit --enable-squash-merge --enable-merge-commit=false \
  --enable-rebase-merge=false --delete-branch-on-merge
```

After CI has run once, protect `main` and require the `build` and `e2e` checks. Confirm the
owner in `.github/CODEOWNERS` before you require code-owner reviews. Deployment secrets are
described in [docs/deploy.md](docs/deploy.md).
