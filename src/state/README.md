# App state (`src/state`)

Zustand 5 stores and React hooks over the data layer (`src/db`). Stores also work outside React
(`useXStore.getState()`), which the tests use.

## The open plan (`planStore.ts`)

`usePlanStore` is the app's store (`createPlanStore(deps)` makes more for tests). It holds one plan
loaded once from the database (not a live query) and edited in memory.

| State            | Meaning                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `planId`, `plan` | the open plan (`plan` null while idle, loading or failed)                        |
| `status`         | `idle` / `loading` / `ready` / `not-found` / `error` (`error` holds the message) |
| `rev`            | stored revision this copy is based on (the next save's compare-and-swap)         |
| `readOnly`       | made by a newer app version: never edited or saved                               |
| `warnings`       | migration notes, the read-only reason                                            |
| `conflict`       | `{ theirRev }` after another tab saved (`null` rev: deleted) the plan            |
| `saveState`      | `saved` / `dirty` / `saving` / `error`; `lastError`, `lastSavedAt`               |
| `copiedPlan`     | the plan `saveAsCopy()` last stored as a new plan (its edits are safe there)     |

| Action                                         | Behaviour                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `load(id)`                                     | flushes the current plan, loads, clears history and the selection; no-op if `id` is already open                   |
| `unload()`                                     | flushes, then closes (call on editor unmount)                                                                      |
| `edit((draft) => …)`                           | immer draft edit, one undo step; false when nothing changed or the plan is not editable                            |
| `applyOp((plan) => StackOpResult \| { plan })` | returns `{ applied, conflicts, error? }`; conflicts or an error leave the plan untouched; success is one undo step |
| `beginGesture()` / `endGesture()`              | pause history during a drag; the whole gesture becomes one step; autosave waits for the end                        |
| `cancelGesture()`                              | restores the plan from the gesture's start, no step                                                                |
| `undo()` / `redo()`                            | zundo; ignored during a gesture or on a read-only plan                                                             |
| `renamePlan(name)`                             | trimmed 1–200 characters, an undoable edit                                                                         |
| `flushSave()`                                  | saves now (waits for a save in flight); true when nothing is left unsaved                                          |
| `stashUnsaved()`                               | keeps a synchronous recovery copy of unsaved changes (page hide), or drops an old one when all is saved            |
| `reloadFromDb()`                               | re-reads the stored plan, dropping local changes and history (resolves a conflict)                                 |
| `saveAsCopy()`                                 | stores the in-memory plan (Have kept, same rack) under new ids; returns the new id to navigate to                  |

History: zundo with `partialize` = `{ plan }`, reference `equality`, limit 100. Selectors:
`useCanUndo()`, `useCanRedo()`, `canUndo(store?)`, `canRedo(store?)`.

Autosave: any change of `plan` within the open plan is saved `AUTOSAVE_DELAY_MS` (400 ms) after the
last one, one save at a time. Undo back to the stored version cancels the save. A
`PlanConflictError` (or another tab's `plan-saved`/`plan-deleted` notice) sets `conflict` and stops
autosaving until `reloadFromDb()` or `saveAsCopy()`. Read-only plans never save. `plan.rev` and
`plan.updatedAt` inside the store stay as loaded: the store's `rev` is authoritative and the
repository stamps both on save.

`installPlanPersistence({ registerBeforeReload, registerDbDrain })` (called once from main.tsx,
idempotent) flushes pending changes before an app reload (the update prompt's registry,
`beforeReload.ts`), before another tab's database upgrade closes the connection, and on
`visibilitychange` (hidden) and `pagehide`. A save started while the page unloads never finishes
(its IndexedDB transaction needs callbacks the dying page no longer runs), so on hide the store
first writes a synchronous recovery copy (`recovery.ts`, localStorage key `mrp-unsaved:<id>`):
the unsaved plan, the stored revision it is based on, and the plan a save in flight was writing.
The next `load` takes the copy once and applies it only if the stored revision still matches (or
is the in-flight save, with exactly that content), the same rule as the compare-and-swap; it then
saves through the usual autosave. A successful save, a reload from the database or a deleted plan
drops the copy. This is what makes "edit, then reload at once" keep the edit.

Editor contract: `load(planId)` when the route's plan changes, `unload()` on unmount, gestures
around drags, `applyOp` for domain stack/placement ops, `edit` for field edits. Edits made after a
conflict mark the plan unsaved (`saveState` `dirty`) but are never saved over the other version.
`hasStrandedEdits(state)` is true while such edits exist and no `saveAsCopy()` holds them
(`copiedPlan` is the plan the last copy stored): the editor then asks before leaving (React Router
`useBlocker`: stay, leave without them, or save as a copy and leave) and arms the browser's
"Leave site?" prompt.

## Catalog, settings, inventory

- `catalogStore.ts`: `useCatalog()` -> `{ lookup, revision, problems }` (bundled catalog + the
  user's library, followed with a Dexie liveQuery that also sees other tabs; `revision` bumps on
  every change). `getCatalog()` adds `catalogRev` (bundled hash), `library`, `libraryLoaded`.
  `lookupForPlan(lookup, plan)` layers the plan's own `custom` entries on top (memoized per lookup
  and `plan.custom`). `startLibrarySync()` / `stopLibrarySync()`.
- `settingsStore.ts`: `useSettings()` (defaults while loading), `useSettingsView()` ->
  `{ settings, loaded }`, `saveSettings(patch)` (a patch or a function of the stored settings,
  see `SettingsPatch` in `src/db/settingsRepo.ts`).
- `backupMeta.ts`: `useBackupMeta()` -> `{ meta, loaded }`, a live query over the backup metadata
  (last backup, nudge put off) from `src/db/backupMetaRepo.ts`.
- `inventoryStore.ts`: `useInventory()` (empty while loading), `useInventoryView()`,
  `setInventoryQty(key, n)`, `adjustInventory(key, delta)`, `replaceInventory(inventory)`.

Setters write through the repositories and the live queries bring the change back (in every tab).
Failed writes are reported to `dbStatus` and rethrown, so the caller can show a toast too.

## Derived values (`derived.ts`)

- `useBom()`: `computeBom(plan, lookupForPlan(…), settings, inventory)`, memoized; undefined
  without a plan. Components share the last result (same plan and catalog objects, same settings
  and inventory content), so the toolbar's summary and the BOM panel compute it once per edit.
- `useChecks()`: `runChecks(…)`, memoized and shared the same way; `[]` without a plan.
- `planStats(plan, lookup)` / `usePlanStats()`: `{ heightU, usedU, freeU, usedSixths, freeSixths,
sectionSummary ("3U + 6U · 9U"), haveCount, needCount }`. Used U is the union of placement
  heights within the stack (any face or bay). `sectionSummaryText(heightsU)` is the summary text
  on its own (plan cards build it from `PlanSummary.sectionHeightsU`).
- `usePlanLookup()`: the open plan's lookup (its custom entries included).

## Plans page (`planList.ts`)

`usePlanSummaries()` -> `{ plans, error }`: a live query over `listPlanSummaries` (`plans`
undefined while loading; `error` instead of crashing the page when storage is unavailable).

## Editor UI (`uiStore.ts`)

Not undoable: `recordingMode` per plan id (`setRecordingMode`, `useRecordingMode(planId)`,
`isRecording(planId)`; kept in sessionStorage so a reload mid-recording stays in Recording mode),
`selection` (`select`, `toggleSelected`, `clearSelection`; cleared when another plan loads), `zoom`
(`setZoom`, clamped to `ZOOM_MIN`..`ZOOM_MAX`), `face`, `panels` (`setPanelOpen`, `togglePanel`;
the editor uses `panels.bom` for its BOM drawer). The editor selects through
`selectInEditor` (`src/features/editor/selection.ts`), which also shows the Selection tab and
turns the rack to the part's face.

## Status and reloads

- `dbStatus.ts`: `useDbStatus(selector?)` -> `{ versionChange, blocked, storageFull, writeError,
conflict }`, fed by `src/db/events.ts` and the stores; `reportDbStatus(event)`,
  `clearDbStatus(kind)`, `getDbStatus()`.
- `beforeReload.ts`: `registerBeforeReload(hook)`, `runBeforeReload(timeoutMs?)` (never throws,
  gives up after 3 s) and `reloadApp()`. The update prompt ("New version available") calls
  `reloadApp()` instead of `location.reload()` so the autosave is flushed first.
- `src/components/status/StatusBanners.tsx`: rendered by `AppLayout` in `#app-status-slot`, the
  first child of `<main>` (loaded lazily: it reads the plan store, which builds zod schemas, see
  main.tsx). `dbStatus.ts` itself is imported by main.tsx, so it hears database events from the
  first open on. It shows: newer version in another tab (Reload), an older tab blocking the upgrade,
  plan changed / deleted in another tab (Reload, Save as a copy), read-only plan (Save an editable
  copy), storage full (link to `/settings#storage`), failed save (Try again). Alerts use
  `role="alert"`, the read-only note `role="status"`; results are announced with toasts. When a
  banner closes, focus moves to `<main>` (given `tabindex="-1"` if it has none).
