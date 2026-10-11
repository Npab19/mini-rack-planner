# Data layer (`src/db`)

IndexedDB through Dexie 4: the database, typed rows and plain async repository functions. No
React here; components read data through `src/state`. Every external input is validated (plans
through `migratePlan`, parts through the catalog schema, settings through `SettingsSchema`).

## Database (`db.ts`)

`getDb()` returns the lazily created `MrpDb` (name `"mrp"`, `DB_NAME`). Version 1 declares every
table the app will need, so later milestones add data instead of schema upgrades (an upgrade makes
every open tab of the older version reload). Binary data is never indexed.

| Table         | Key, indexes                   | Row             | Holds                                        |
| ------------- | ------------------------------ | --------------- | -------------------------------------------- |
| `plans`       | `&id, updatedAt, rackId, name` | `PlanRow`       | plan JSON + indexed copies, `rev`, `schema`  |
| `library`     | `&id, kind, updatedAt`         | `LibraryRow`    | custom catalog entries (`custom:` ids)       |
| `inventory`   | `&key`                         | `InventoryRow`  | loose spares by BOM line key                 |
| `settings`    | `&key`                         | `SettingsRow`   | global settings (key `"settings"`), metadata |
| `diagnostics` | `++seq, at`                    | `DiagnosticRow` | diagnostics ring buffer (200 entries)        |
| `modelFiles`  | `&sha256, addedAt, lastUsedAt` | `ModelFileRow`  | M7: dropped model file metadata              |
| `modelBytes`  | `&sha256`                      | `ModelBytesRow` | M7: the file's Blob                          |
| `meshCache`   | `&key, sha256, lastUsedAt`     | `MeshCacheRow`  | M7: parsed mesh buffers (LRU ~150 MB)        |
| `partModels`  | `&partKey, sha256`             | `PartModelRow`  | M7: catalog part -> model file + alignment   |

`PlanRow.rev` is the compare-and-swap revision and wins over `plan.rev`. `PlanRow.schema` above
`CURRENT_PLAN_SCHEMA` means a newer app wrote the plan: it opens read-only and is never overwritten.

**Another tab upgrades or deletes the database** (`versionchange`): `MrpDb` emits `version-change`,
runs the `registerDbDrain(fn)` hooks for up to 1.5 s (the plan store flushes its autosave there),
then closes with auto-open disabled. `isDbSuperseded()` turns true and nothing reopens the old
connection, so this tab never writes old-format data into the upgraded database; the status
banner asks for a reload. `blocked` (this tab's upgrade waits for an older tab) emits `blocked`;
every successful open emits `opened`.

## Retry and errors (`retry.ts`, `errors.ts`, `events.ts`)

Every repository call runs inside `withRetry((db) => …)`:

- a dropped connection (`DatabaseClosedError`, or a message matching "Connection to Indexed
  Database server lost", "database connection is closing", `UnknownError`) is reopened once and
  the operation retried once, then the error is rethrown. Keep operations idempotent: a single
  transaction is (a failed one never committed);
- a quota failure (`QuotaExceededError`, also when wrapped in an `AbortError`/`cause`) becomes a
  `StorageFullError` and a `storage-full` event.

Typed errors: `PlanNotFoundError`, `PlanConflictError { planId, theirRev }` (`theirRev` null: deleted),
`PlanReadOnlyError`, `StorageFullError`, `BackupFormatError { details }`, `LibraryEntryError
{ problems }`, plus `errorMessage(error)` for display. `onDbEvent(listener)` /
`emitDbEvent(event)` carry the connection events (`version-change`, `blocked`, `opened`,
`storage-full`); `src/state/dbStatus.ts` turns them into banner state.

## Plans (`plansRepo.ts`)

- `listPlanSummaries(lookup?)` -> `PlanSummary[]`, newest first: `id, rackId, name, frameId,
frameName?, heightU, sectionHeightsU, sectionCount, haveSectionCount, placementCount, haveCount,
needCount, updatedAt, readOnly`. Cheap (no zod), so a page of plan cards never reads whole plans.
  Section heights and the frame name come from the plan's own custom frame or the lookup, else
  from the sections' own or built heights; Have/To get are counted like `planStats`.
- `getPlan(id)` -> `LoadedPlan { plan, rev, readOnly, warnings }` through `migratePlan`; a newer
  schema is read with `parseNewerPlanReadOnly` and `readOnly: true`. Throws `PlanNotFoundError`.
- `createPlan(plan)`: validates, stores at rev 1 with `createdAt`/`updatedAt` now; returns the
  stored plan.
- `savePlan(plan, expectedRev)`: one rw transaction. The stored rev must equal `expectedRev`
  (else `PlanConflictError`) and the row must not be newer-schema (`PlanReadOnlyError`). Stamps
  rev + 1 and `updatedAt`; returns the new rev.
- `renamePlan(id, name, expectedRev?)`: the Plans page rename; bumps the rev (an editor that has
  the plan open then sees a conflict). Returns the new rev.
- `deletePlan(id)`.
- `duplicatePlan(id, { name?, resetHave, sameRack })`: new ids for the plan and every section,
  placement, device, equipment entry, extra and retired entry (`clonePlanWithNewIds`,
  `planCopy.ts`). `resetHave` clears every Have mark and drops retired parts. Default name
  "… (copy)".

Every write tells other tabs (`crossTab.ts`) and, after the first save, asks the browser to keep
the data (`requestPersistOnce`, `src/lib/storage.ts`). Helpers: `validatePlan`, `validPlanName`,
`planRow`, `readPlanRow`, `summarizePlanRow`, `nowIso`, `utcIso`, `MAX_PLAN_NAME_LENGTH`.

## Library, settings, inventory, diagnostics

- `libraryRepo.ts`: `listLibrary()` -> `{ entries, problems }` (rows this version cannot read are
  reported, never deleted), `getLibraryEntry(id)`, `putLibraryEntry(entry)` (schema, `custom:` id
  and `checkEntryIntegrity`, else `LibraryEntryError`), `deleteLibraryEntry(id)`,
  `validateLibraryEntry(input)`.
- `settingsRepo.ts`: `getSettings()` (defaults filled; a damaged field falls back alone),
  `updateSettings(patch)` (top-level merge in one transaction; throws on invalid values). The
  patch can be a function of the stored settings (`SettingsPatch`), run inside the transaction:
  use it to change one entry of a record such as `sparePct`, so quick edits (or two tabs) never
  undo each other. `replaceSettings(settings)`, `parseSettings(value)`.
- `backupMetaRepo.ts`: when this browser last exported a full backup and when the backup nudge
  was put off (`getBackupMeta`, `recordBackup`, `dismissBackupNudge`, `parseBackupMeta`). Stored
  in the settings table under its own key (`BACKUP_META_KEY`), so backups never carry it and an
  import never overwrites it.
- `inventoryRepo.ts`: `getInventory()`, `setQty(key, n)` (0 removes), `adjust(key, delta)` (one
  transaction, never below 0, returns the new quantity), `replaceAll(inventory)`.
- `diagnosticsRepo.ts`: persistence for `src/lib/diagnostics`.
  `createDiagnosticsSink(cap?)` implements its `DiagnosticsSink` (main.tsx wires it, best effort:
  without IndexedDB the entries stay in memory); `appendDiagnostic(entry, cap?)` keeps the newest
  `cap` rows (default `MAX_DIAGNOSTICS`, 200: every tab appends while the store shows its newest
  100), `listDiagnostics()` oldest first, `clearDiagnostics()`.

## Backups (`backup.ts`)

`BackupFileSchema`: `{ format: "mini-rack-planner-backup", version: 1, app: { version, sha },
exportedAt, plans: unknown[], library: CatalogEntry[], settings?, inventory? }`. Model files are
never included (import-only policy).

- `exportBackup({ planIds?, includeSettings, includeLibrary? })`: one read transaction; plans as
  stored (newer-schema documents untouched). The library defaults to included when exporting all
  plans. `serializeBackup(file)` and `backupFileName(date)` (local date, like the user's calendar)
  for downloads.
- `parseBackupText(text)` / `readBackupFile(blob)`: refuse input over `MAX_BACKUP_BYTES` (20 MB)
  before reading or parsing, strip a byte order mark, map bad JSON to `BackupFormatError`.
- `importBackup(json, mode)` -> `ImportResult { mode, added, updated, skipped, removed, planIds,
renamedIds, library: { added, updated, skipped }, settingsImported, inventoryImported, errors,
warnings }`. Validates everything first, then writes in one transaction:
  - `merge`: upsert by id; a stored plan is replaced only by a newer `updatedAt`. Parts with a
    clashing id keep the local version (with a warning). Settings/inventory from the file are
    applied (inventory per key).
  - `replace`: clears plans and library (settings/inventory only when the file has them), then
    inserts. Refused with `BackupFormatError` when any entry is invalid.
  - `copy`: new ids for every plan and everything in it, Have reset; plans that shared a rack
    still share one; names get "(copy)" when the name exists. Parts merge; settings/inventory
    are not imported.
  - A bare plan object (single-plan file) imports like a backup holding it. Unknown formats and
    newer backup versions throw `BackupFormatError`.
  - Overwritten plans get a revision above the stored one, so an open editor sees a conflict
    instead of saving over the import. Plans from a newer app are stored untouched (read-only).
  - Inside the import transaction every `await` is a Dexie promise: awaiting a native promise (an
    async helper) can lose Dexie's transaction zone, and the next write then runs outside the
    transaction, which commits early (`PrematureCommitError`) with only part of the file written.
    The helpers only plan rows; `writeImport` does the reads and writes.

## Cross-tab notices (`crossTab.ts`)

`publishCrossTab({ type: 'plan-saved', id, rev } | { type: 'plan-deleted', id })` and
`subscribeCrossTab(listener)` over `BroadcastChannel("mrp")`, with `TAB_ID` added and checked (a
tab never hears itself) and incoming data validated (`parseCrossTabMessage`). Without
BroadcastChannel it is a no-op (`isCrossTabSupported()`); the revision CAS still catches conflicts.

## Tests

DB tests start with `import 'fake-indexeddb/auto'` and call `await resetDbForTests()` in
`beforeEach`. fake-indexeddb schedules work with `setImmediate`, so fake only timers you need:
`vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })` (or `['Date']`).
