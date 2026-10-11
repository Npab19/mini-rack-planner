# Fixtures

Plans and expected outputs for the domain tests, the BOM CLI and (later) the E2E suite. Everything
here is JSON written by hand or by the app's own code; model files never go in this folder.

| Path                       | What it is                                                              | Who writes it        |
| -------------------------- | ----------------------------------------------------------------------- | -------------------- |
| `plans/*.json`             | KWS Rack v2 golden plans: the user's 3U + 6U plus a new 3U, and [6, 6]  | by hand              |
| `expected/*.shopping.json` | The shopping list of each plan (`npm run bom -- <plan> --json`)         | the BOM CLI          |
| `compat/v<n>/`             | Plans, share links and the plan JSON Schema as schema `v<n>` wrote them | frozen, never edited |

- `src/domain/kws.data.test.ts` checks `expected/` against the BOM of each plan on the real
  catalog. After an intended change, regenerate one with
  `npm run -s bom -- fixtures/plans/<name>.json --json --out fixtures/expected/<name>.shopping.json`
  and review the diff: the KWS golden numbers (36 inserts, 16 M6×8, 24 M6×10, 40 nylocs and 16
  magnets for the +3U) must not move.
- `src/domain/compat.test.ts` opens every compat plan and share link on each build, and compares
  the current `PlanSchema` with `compat/v<PLAN_SCHEMA_VERSION>/plan.schema.json`. A schema change
  needs a version bump, a migration step and a new `compat/v<n>/` folder.
