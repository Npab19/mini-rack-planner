# Domain model (`src/domain`)

Pure TypeScript: no React, DOM, Dexie, three or `import.meta.glob`. It is type-checked under the
WebWorker lib, so it runs in workers, Node scripts (`npm run bom`) and tests alike. Imports
inside the domain are relative. Every external input goes through zod (`schema/`).

## Units and coordinates

- Millimetres everywhere. Frame axes: X right, Y up (0 = bottom of U1), Z toward the viewer
  (0 = rail front face).
- Rack heights and positions are **integer sixths of a U** (1U = 6), so ½U and ⅓U are exact.
  `geometry.ts` has the constants (44.45 mm/U, 254 mm panels, 236.525 mm ear spacing, holes at
  6.35 / 22.225 / 38.1 mm per U) and helpers: `uToSixths`, `sixthsToMm`, `mmToSixthsCeil/Floor`,
  `panelFaceHeightMm`, `formatU` ("1½U", "⅔U"), `uNumberAt` (U label), `phaseOf` (start phase,
  y mod 6), `railHoleYsMm`.
- Sections stack bottom -> top. A placement's `y` is its bottom edge in sixths.

## Names in messages and labels

One helper per name, so the stack editor, checks, BOM and 3D labels read the same:
`deviceName` (brand + model, `schema/catalog.ts`), `sectionLabel` ("Section 2 (6U)", `recipe.ts`),
`placementName` (user label, else catalog name, else the stored copy, `frame.ts`) and
`placementLabel` ("Lenovo Tiny mount @U4", `bom.ts`). The BOM numbers its provenance by stack
position ("6U section #2", "Joint 3U #1 / 6U #2") because the as-built stack can skip planned
sections. Generated ids use the `ID_PREFIX` constants (`ids.ts`); `isCustomId` (`schema/common.ts`)
recognises the user's private entries.

## Catalog entries (`schema/catalog.ts`)

- `frame`, `item` (also `kind: 'extra'` for non-U accessories), `device` and `hardware`,
  discriminated on `kind` (`CatalogEntrySchema`). Ids are kebab-case and never change; the
  user's private entries use `custom:` ids and live in `plan.custom`.
- `source` holds a link and facts only; the app never fetches it. Curated frames/items need one,
  custom ones may omit it. `checkEntryIntegrity` (`schema/integrity.ts`) checks what zod cannot
  (unique local ids, print refs, option refs in conditions, units and scopes per kind).
- Read access goes through `CatalogLookup` (`createCatalogLookup(catalogBundle(entries))`).
  `withCustomEntries(catalog, plan.custom)` overlays a plan's own entries; it is idempotent.
- Model files are import-only: a MakerWorld 3MF/ZIP or any other STL/3MF the user drops. The
  domain never holds model bytes, only `AlignRecord`s (`schema/align.ts`) that map a file
  (matched by SHA-256 or geometry signature) onto a catalog part.

## Recipes (`recipe.ts`, `qty.ts`)

A recipe line counts a print group or a hardware id per **unit**:

| unit       | counted                                | quantity context (`QtyContext`)                   |
| ---------- | -------------------------------------- | ------------------------------------------------- |
| rack       | once, if there is at least 1 section   | whole stack                                       |
| top/bottom | once, if the cap is present            | whole stack                                       |
| section    | once per section                       | u = section height, `sectionCounts = { type: 1 }` |
| joint      | once per adjacent pair (`jointFilter`) | u = 0, the two neighbours, `joints = [pair]`      |
| item       | once per placed item / extra           | u = item height                                   |

- `Qty` is a number or `{ base, perU, perSection{type: n}, perSectionAny, perJoint, jointFilter }`;
  the terms add up. Nothing is rounded until the BOM aggregates a line.
- `when` conditions: `{option}`, `{stack}`, `{all}`, `{any}`, `{not}`. Stack facts always describe
  the whole stack (height, section types bottom -> top).
- Print groups `embeds` hardware (inserts, magnets): prints × perPrint, emitted as hardware lines
  with `role: 'embedded'`, `reusable: false` and `embeddedIn` pointing at the print line.
- Roles: `assembly` (reusable), `rack-mount` (informational: the BOM derives rack screws per
  placement from `item.mount` × the frame's fastener), `embedded`.
- `expandFrameRecipe(frame, config)` / `expandItemRecipe(item, options, instanceId)` return one
  `ExpandedLine` per contribution with provenance; `sumByLineKey` totals them.
- Line keys (`ids.ts`) are persisted in inventory, so their format never changes:
  `print:<owner id>/<print id>` (the same print aggregates across sections and placements),
  `hw:<id>` or `hw:<id>@<cut mm>`, `device:<id>`.

## Option scopes

Options declare where they are edited: `rack | top | bottom | section | item`. Values resolve in
layers, lowest priority first: the option default, the rack value (`plan.frame.options`), then
the unit's own value (section, cap or placement options). Invalid or stale values are skipped.
Rack and joint lines see the rack layer only. `optionEffects` turns active options into geometry
changes such as `{ depthMm: 320 }`; `effectiveFrameSize(frame, plan.frame.options)` gives the
frame's depth and opening after them (placement, checks and 3D all use it).

## Target vs as-built

- **Target**: the plan as planned (`frameConfigFromPlan(plan.frame, frame)` plus all placements,
  devices and extras).
- **As-built**: what the user owns, from `have` snapshots captured on _Mark as Have_ (sections
  in stack order with their snapshot type, height and options; caps; placements, devices and
  extras with `have`; `retired`). The same expansion runs on a `FrameConfig` built from them.
- The BOM compares the two per line key (see `BomLine` in `api.ts`): what to install, spares,
  what to buy and the surplus. Snapshots freeze what was built, so later edits to the planned
  version never change it.

## Plans and migrations

`PlanSchema` is schema 1. Every plan from outside (Dexie, JSON import, share link) goes through
`migratePlan`, which runs the ordered `PLAN_MIGRATIONS` chain and then validates. A plan from a
newer app throws `PlanTooNewError`; open it read-only with `parseNewerPlanReadOnly`. A schema
change needs a version bump, a migration step and compat fixtures: `compat.test.ts` opens every
plan and share link in `fixtures/compat/v<n>/` and fails when `PlanSchema` no longer matches
`fixtures/compat/v<PLAN_SCHEMA_VERSION>/plan.schema.json`.

## File map

| File                              | Contents                                                                    |
| --------------------------------- | --------------------------------------------------------------------------- |
| `geometry.ts`                     | rack constants and unit conversions                                         |
| `schema/`                         | zod schemas + inferred types (catalog, plan, settings, align), integrity    |
| `ids.ts`                          | `newId` (no `randomUUID`: works on plain-HTTP LAN origins), line keys       |
| `qty.ts`                          | `evaluateQty`, `evaluateLength`, `evaluateCondition`                        |
| `recipe.ts`                       | option resolution and effects, `expandFrameRecipe`, `expandItemRecipe`      |
| `migrate.ts`                      | `migratePlan`, typed load errors                                            |
| `api.ts`                          | type-only contracts for the modules below                                   |
| `frame.ts`, `placement.ts`        | stack operations (`StackOpResult`), remap, hole phases, occupancy           |
| `bom.ts`, `checks.ts`, `power.ts` | `ComputeBom`, `RunChecks`, `PowerSummary`                                   |
| `share.ts`, `assembly.ts`         | share links (`ShareMode`), `Assemble` -> `PartInstance[]`                   |
| `build.ts`                        | Have/Need marks (placements, devices, caps, extras, sections), Finish build |
| `devices.ts`                      | devices in slots, the equipment tray, mount suggestions, U estimates,       |
|                                   | orientations (`deviceOrientationChoices`, `setDeviceOrientation`)           |
| `fit.ts`                          | "Fit it for me" (`fitItForMe`), device spots for the mount chooser          |
| `mountGenerator.ts`               | "Needs a mount?": suggested mount height, parametric generator settings     |
| `customParts.ts`                  | custom device/item/frame inputs and editors, `embedUsedCustomEntries`       |
| `extras.ts`                       | accessories (non-U extras): add, quantities, remove                         |
| `retired.ts`                      | removed-but-owned parts: reuse, keep as spare, discard                      |
| `partRole.ts`                     | part roles (compute, storage, network, power, neutral) for colour hints     |
