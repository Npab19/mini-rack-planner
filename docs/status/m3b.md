# Status after M3b: the full editor (2026-10-12)

M3b (issue #12) is built, integrated and green. Four parts were built in parallel and then wired
together:

- drag and drop, pointer moves, touch and pan/zoom;
- the mount chooser, _Needs a mount?_, _Fit it for me_ and the Equipment to fit tray;
- custom parts, the _Add a part_ wizard and My parts;
- inspector orientations, accessories, and removed-but-owned parts.

The plan's acceptance holds against the production Docker image:

- Drops land on the computed U at 50, 100 and 200 % zoom.
- A custom device survives export and import, even after it was deleted from My parts.
- Tap-to-place, long-press move and pinch work on a phone viewport.

## At a glance

| Check                                               | Result                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run typecheck` (app, worker, node, test)       | clean                                                                             |
| `npm run lint`                                      | clean (exit 0, nothing reported)                                                  |
| `npm run format` + `npm run format:check`           | clean                                                                             |
| `npm test`                                          | 135 files, **1646 tests passed**, 0 failed                                        |
| `npm run headers -- --check`                        | no drift                                                                          |
| `npm run validate-catalog -- --check`               | OK: 78 entries, revision `09f496ab95ef24`, 0 warnings                             |
| `npm run build` + `npm run check-budgets`           | initial JS 196.3 kB gzip of 300 kB; dnd-kit is its own lazy chunk (32.8 kB gzip)  |
| Docker image, `--read-only --tmpfs /tmp`, port 8080 | builds; `/healthz` ok                                                             |
| Playwright `prod-secure` + `prod-lan` + `mobile`    | **82 passed**, 4 skipped by design (header checks and the CSP self-test run once) |
| New M3b specs `--repeat-each=3` (all 3 projects)    | **90 of 90 passed**: no flaky waits                                               |

## M3b acceptance

| Acceptance                                        | Evidence                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drops land on the computed U at 50/100/200 % zoom | `editor.dnd.spec.ts`: a Shelf 2U dragged from the palette shows "Fits at U5–U6" and lands with `data-u-start` 5 at each zoom. "Which U" is read from the rendered U labels.                                                                                                              |
| Pointer moves                                     | The Lenovo mount is moved by pointer from U4 to U9. One Undo puts it back. Escape cancels a palette drag.                                                                                                                                                                                |
| Device → slot, drop on empty space                | A Raspberry Pi 5 dropped on a shelf goes into its slot. Dropped on empty space, it opens the chooser ("dropped at U7"). Picking "Shelf 1U at U7" places the shelf with the Pi in it, focused on the rack; one Undo removes both. A tray row dragged the same way leaves the tray.        |
| Fit it for me                                     | `editor.m3b.spec.ts`: a KWS 9U plan (3U + 6U) with two shelves and three MS-01/MS-A2 in the tray. Fit grows it to 12U ("Placed all 3 devices and added 3U at the top") with enclosures at U6, U8 and U10. One Undo restores 9U and the tray.                                             |
| Needs a mount?                                    | A custom 200 × 180 × 110 mm device from My parts shows the generator settings (Merkle: 202 / 112 / 182). "Create a custom mount sized for it" opens the mount editor filled in (3U, 202 × 112 inside). "Save and place" starts placing, and the mount lands at U5–U7 holding the device. |
| A custom device survives export/import            | A custom mini PC from My parts is dropped into a Shelf 1U, and the plan is exported. Deleting the part from My parts says the plan "keeps its own copy". Imported as a copy, the plan still shows the shelf holding it, with no "not in the catalog" check.                              |
| Mobile                                            | `editor.touch.mobile.spec.ts`: tap-to-place, a 400 ms long-press moves a part U9 → U7, pinch zooms more than 1.8×, a swipe pans without moving the part. `editor.m3b.mobile.spec.ts` (360 px): Needs a mount? and Fit it for me fit the screen with no sideways scroll.                  |
| Accessibility                                     | axe (serious, critical), light and dark: My parts (empty and with a part), every Add a part step (including a failed save), the mount chooser, Needs a mount? and the mount editor. None found.                                                                                          |

## What shipped

- **Drag and drop** (`src/features/editor/rack/`):
  - `RackDndProvider` wraps the palette, the tray and the rack. It loads dnd-kit lazily, and only from `lg` up.
  - `useRackDnd` handles the rack's own Pointer Events: moves, long-press, pinch, pan, and edge auto-scroll.
  - `dropTarget.ts` and `gesture.ts` are pure.
  - Ghosts carry `data-ghost-*` attributes, and a drag chip follows the pointer.
- **Mounts** (`mounts/`):
  - The chooser lists the device's own ears, catalog mounts and a generic shelf. Each option says whether it fits where the device was dropped, or where the nearest free spot is.
  - _Needs a mount?_ gives a suggested height and the settings for three parametric generators, with copy buttons. It can also create a custom mount.
  - Domain: `fit.ts` and `mountGenerator.ts`.
- **Equipment to fit** (`equipment/`): _Fit it for me_ (top or bottom, one undo step), draggable rows and the result note. A check on a tray entry focuses its row (`focusEquipment.ts`).
- **Custom parts** (`src/features/custom/`, `src/features/library/`, `src/domain/customParts.ts`):
  - The _Add a part_ wizard and the plain-language device, item and frame editors.
  - My parts: search, edit, duplicate, export as a catalog entry, _Share with everyone_, and delete with per-plan usage.
- **Inspector and extras** (`inspector/`, `extras/`, `retired/`):
  - An orientation picker for area slots.
  - Accessories with quantities.
  - Removed-but-owned parts: reuse, keep as spare, discard.
  - `CustomPartActions` in the palette.

## Integration pass (what changed)

**Wiring**

- `EditorPage`:
  - wraps `EditorLayout` in `RackDndProvider`, which encloses the palette, the tray and the rack;
  - renders `MountDialogs` once per plan;
  - registers the plan store's new op finisher (below).
- `AppLayout` renders `AddPartHost` for every page. The host builds no schema at load, so the CSP rule for statically imported modules holds. The dialog chunk loads on the first request.
- `LibraryPage` no longer renders its own host. Its test now renders the page with the shell's host.
- The palette uses `CustomPartActions` ("Add a part from a link or file" / "Create a custom part") in the no-results state and under the results, the My parts tab included. The palette engineer's separate "Add your own part…" button is gone, so there is one set of buttons.
  - The search text names the new part. A pasted link starts the wizard from that link.
  - What is saved joins the plan and goes on to be placed. In the Devices tab, a device without ears waits in Equipment to fit.
- `ChecksPanel` calls `focusEquipmentEntry` after selecting a check's target. A tray device's row takes focus, and the tray sheet opens first below `lg`. The inspector shows its Rack tab for a tray id; a unit test covers this.
- Router: the `dev/spike-dnd` route and `SpikeDndPage.tsx` are removed. `/dev/spike-worker` stays.

**Plans carry the parts of your own they use (portability)**

- `planStore.setOpFinisher(fn)` runs every applied `applyOp` result through `fn` in the same undo step. A throwing finisher is logged and ignored.
- The editor sets it to `embedUsedCustomEntries(plan, library)`. Any edit that starts using a My parts entry therefore copies it into `plan.custom`, together with the custom hardware it needs. This covers palette drops, click-to-place, Add at U…, the tray, the chooser and Fit. Leaving the editor clears it.
- `exportBackup` also embeds used library parts into exported plans that do not carry them yet. These are plans from before this change, or single-plan exports, which leave the library out. Plans that need nothing are exported exactly as stored.

**Needs a mount? → the new mount holds the device**

- `AddPartTarget.placeEquipmentId` (custom-parts request 3, the optional part): "Needs a mount?" from the tray passes the tray entry.
- After "Save and place", click-to-place starts with `{ kind: 'item', itemId, equipmentId }`, so the device goes into the new mount in the same step. If the entry is gone by then, the mount is placed on its own.

**Fix found by the E2E: joints without a dead zone**

- `checks.ts` warned "crosses the joint at Ux, where nothing can be fixed" for every part spanning a section joint, even on frames with no dead zone (KWS). `canPlace` allows those spots, so _Fit it for me_ (and anyone dragging) got a warning the placer itself does not apply.
- The check now needs a real dead zone (`deadY0 < deadY1`), as `canPlace` does. There is a unit test, and the existing dead-zone test still passes.

**E2E helpers**

- `e2e/rackPointer.ts` aims at the drawing with `getBoundingClientRect()` measured by the page, the same approach as PR #16. WebKit misplaces SVG `<text>` in `boundingBox()`.
- `editor.dnd.spec.ts` now uses it.
- PR #16's `rackPoint`/`arrowUntilChecked` changes to `e2e/editorHelpers.ts` are applied here unchanged, so merging `main` is clean.

**Docs**

- `docs/spikes/s2-dnd.md`: a note that the spike code and `dnd-check.ts` were removed, and which specs to re-run on dnd-kit upgrades.
- `src/domain/README.md`: the file map lists `fit.ts`, `mountGenerator.ts`, `customParts.ts`, `extras.ts`, `retired.ts` and the orientation helpers in `devices.ts`.
- `docs/status/m3a.md`: the known gaps point here.
- `README.md`: status and the M3b row.

## Engineer requests and how they were resolved

| From        | Request                                                                   | Resolution                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DnD 1       | `RackDndProvider` around the editor body, `MountDialogs`, Add a part host | Done (EditorPage; host in AppLayout).                                                                                                                            |
| DnD 2       | Keep `trayDrag.ts` exports stable                                         | Unchanged.                                                                                                                                                       |
| DnD 3       | Remove the `dev/spike-dnd` route and `SpikeDndPage.tsx`                   | Done.                                                                                                                                                            |
| DnD 4       | Note in `docs/spikes/s2-dnd.md`                                           | Done.                                                                                                                                                            |
| DnD 5       | Keep `data-testid="mount-chooser"` and its title                          | Kept; the specs use both.                                                                                                                                        |
| Mounts 1    | Render `MountDialogs` in ReadyEditor                                      | Done.                                                                                                                                                            |
| Mounts 2    | `focusEquipmentEntry` after selecting a check                             | Done, with a unit test.                                                                                                                                          |
| Mounts 3    | Accept the Needs-a-mount prefill; optional `placeEquipmentId`             | The prefill already worked; `placeEquipmentId` added (savePart, NeedsAMountDialog, tests).                                                                       |
| Mounts 4    | Selection tab and a tray-entry id                                         | Already handled (`resolveSelection` → none → Rack tab); unit test added.                                                                                         |
| Mounts 5    | Domain README: `fit.ts`, `mountGenerator.ts`                              | Done.                                                                                                                                                            |
| Mounts 6    | ½U steps in `estimateSixthsFromHeight`? (optional)                        | Not changed: open question for you (below).                                                                                                                      |
| Mounts 7    | E2E for Fit, chooser, Needs a mount at 360 px                             | Done (`editor.m3b.spec.ts`, `editor.m3b.mobile.spec.ts`). The chooser is reached only by dragging, which is not offered below `lg`, so it is covered on desktop. |
| Custom 1    | `AddPartHost` in AppLayout                                                | Done.                                                                                                                                                            |
| Custom 2    | Library parts placed from the palette embedded in the plan                | Done for every edit (op finisher) and at export.                                                                                                                 |
| Custom 3    | Domain README: `customParts.ts`                                           | Done.                                                                                                                                                            |
| Custom 4    | Custom ids on `PlanSummary` (optional)                                    | Not done: the delete dialog reads each plan; fine at today's plan counts.                                                                                        |
| Custom 5    | E2E: a custom device survives export/import (and share)                   | Export/import done. Share links have no UI until M4.                                                                                                             |
| Inspector 1 | `CustomPartActions` in the no-results state and the My parts tab          | Done; one set of buttons.                                                                                                                                        |
| Inspector 2 | `PlaceSource` `{ kind: 'retired' }` (optional)                            | Not done: the Reuse dialog covers it; a candidate for later.                                                                                                     |
| Inspector 3 | Accessory flag on `CustomItemInput`                                       | Not done (needs a form and domain change); open.                                                                                                                 |
| Inspector 4 | Domain README: `extras.ts`, `retired.ts`, orientation helpers             | Done.                                                                                                                                                            |
| Inspector 5 | M3a known gaps now covered                                                | Noted in `m3a.md`.                                                                                                                                               |
| Inspector 6 | Accessory catalog entries                                                 | For the catalog curators (you); none added.                                                                                                                      |

## E2E coverage (new)

| Spec                                 | Tests | What it proves                                                                                                                             |
| ------------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `editor.dnd.spec.ts`                 |     8 | palette drops at 50/100/200 %, Escape, pointer move + Undo, device → slot, drop on empty → chooser → placed, tray row drag                 |
| `editor.m3b.spec.ts`                 |     5 | Fit it for me (+3U, 3 placed, one undo); Needs a mount? → custom mount placed with the device; custom device export/import; axe light/dark |
| `editor.touch.mobile.spec.ts`        |     2 | tap-to-place + long-press move; pinch zoom + swipe pan                                                                                     |
| `editor.m3b.mobile.spec.ts` (360 px) |     2 | Needs a mount? and Fit it for me on a phone, no sideways scroll                                                                            |

Every test also fails on console errors, uncaught exceptions and CSP violations.

## Known gaps and open questions

- **Browsers.** Only Chromium was run locally. The new pointer helpers use the page's own measurements, as PR #16 does, so the nightly WebKit/Firefox jobs should aim correctly, but they have not been run. Long-press palette drags on tablets wide enough for the desktop layout are not covered by E2E.
- **Fit it for me:**
  - Packing is greedy: each device gets its own mount, shelves are not shared, and empty mounts already in the rack are not filled.
  - On a frame whose sections are all To get, growing uses Set height, which may re-plan the sections. A KWS 3U + 6U became 6U + 6U at 12U, which is cheaper by the designer table but not literally "3U added on top". The note still says "added 3U at the top".
- **Two U figures for unmounted devices.** The tray's estimate is in whole U; Needs a mount? suggests ½U steps. Should `estimateSixthsFromHeight` use ½U too?
- **The wizard's "Fit my equipment" goal** is still marked coming soon. M3b's _Fit it for me_ in the editor covers the need for now.
- **Custom parts.** Escape or the X closes a half-filled form without asking. The plain form cannot declare outlets or ports, or mount hole positions. The catalog has no 12-24 screws, no M3/M4/M5 cage nuts and no 10-32 nuts.
- **KellerLab and Merkle generator parameter names** were taken from the brief and never checked against the pages (the app and the tests make no network calls). They are worth a look by a person.
- **Keep as spare.** Undoing it with the toolbar Undo leaves the spares in the inventory, which is global and outside plan history (as with Finish build). The section's own Undo handles both.
- **Catalog data.** The MS-01/MS-A2 enclosure is 200 mm deep and so "needs support at the back" on a 260 mm KWS. This is a correct warning from the catalog data, not an integration issue.

## What I need from you

1. **Try it** on your rack: drag from the palette and the tray, Fit it for me, and add one of your own devices in My parts.
2. Decide on **½U estimates** for the tray (Mounts 6 above).
3. Check the **generator parameter names** (KellerLab, Merkle) against their MakerWorld pages.
4. Merge `main` into the branch (PR #16 and the 0.1.0 release). `e2e/editorHelpers.ts` already carries #16's changes, so it should merge cleanly.
