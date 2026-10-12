# Status after M3a: v0.1 is ready (2026-10-11)

M3a (the minimal editor, issue #8) is built, integrated and green, and v0.1 is ready to tag once
you have signed it off. You can record the rack you have (frame, sections, mounts and the devices
in them, all _In my rack_), plan an extension from the Rack tab, and read the shopping list in the
bill of materials. For your KWS Rack v2 (3U at the bottom, 6U above, both built) plus one new 3U,
the editor shows exactly the signed-off golden list, with the mouse only and with the keyboard
only, on `localhost` and on a plain-HTTP LAN origin, against the production Docker image.

## At a glance

| Check                                            | Result                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `npm run typecheck` (app, worker, node, test)    | clean                                                                                   |
| `npm run lint`                                   | 0 warnings, 0 errors (395 files, 165 rules)                                             |
| `npm run format` + `npm run format:check`        | clean                                                                                   |
| `npm test`                                       | 111 files, **1370 tests passed**, 0 failed (358 of them in the M3a areas)               |
| `npm run headers -- --check`                     | no drift                                                                                |
| `npm run validate-catalog -- --check`            | OK: 78 entries, revision `09f496ab95ef24`, 0 warnings                                   |
| `npm run build` + `npm run check-budgets`        | initial JS 197.7 kB gzip of 300 kB; the editor is a lazy chunk (73.4 kB gzip)           |
| Docker image, read-only, port 8080               | builds; `/healthz` ok                                                                   |
| Playwright `prod-secure` + `prod-lan` + `mobile` | 52 passed, 4 skipped by design (header checks and the CSP self-test run once)           |
| Editor specs `--repeat-each=3` (all 3 projects)  | 36 of 36 passed: no flaky waits                                                         |
| Rack with 40 placements (production build)       | a keyboard move is painted within 2 frames (33 ms, measured with 2 rAFs); no long tasks |

Unit tests in the M3a areas: `src/features/editor` 261 (rack 101, the page, shortcuts and
selection 36, inspector 34, BOM 26, toolbar 19, palette 13, equipment 13, checks 10, layout 9),
the domain's `build.ts` and `devices.ts` 85, the CSV writer 11, and the shared BOM and checks in
`src/state` 1. Unchanged: the rest of `src/domain` 456, the model parser 192, `src/catalog` 54,
`src/db` 46, the rest of `src/state` 34, and the M2 features.

## The golden shopping list

The E2E reads the line keys and numbers from `fixtures/expected/kws-3-6-plus3-top.shopping.json`
(the BOM CLI's output; a test also checks that file still holds the signed-off numbers) and
asserts them on the BOM rows (`data-install`, `data-need`, `data-spare` of `bom-line-<key>`):

| Line                              | To install / to get | Buy (packs) |
| --------------------------------- | ------------------: | ----------- |
| 3U leg plate (4 legs), PETG 214 g |                   1 | 1 plate     |
| Frame connectors, PETG 68 g       |                   1 | 1 plate     |
| M5 heat-set insert (M5x8x7)       |                  36 | 50 (1 × 50) |
| M6×8 socket head cap screw        |                  16 | 25 (1 × 25) |
| M6×10 socket head cap screw       |                  24 | 25 (1 × 25) |
| M6 nyloc nut                      |                  40 | 50 (1 × 50) |
| Round neodymium magnet 10×5 mm    |                  16 | 20 (1 × 20) |

Exactly 7 lines, 2 of them prints (no once-per-rack parts: the caps are In my rack), spares 0.
With the default filament prices the header chip reads "To get: 7 lines · ~$6.20 · 282 g · 12 h".
`npm run bom -- fixtures/plans/kws-3-6-plus3-top.json` prints the same list.

## M3a acceptance

| Acceptance                                             | Evidence                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rebuild the real 3U + 6U (Have) with your gear         | E2E (mouse only): Settings spares to 0; the wizard's Record flow (KWS v2, preset 3U + 6U, both In my rack, "I'll plan it myself"); in Recording mode Lenovo Tiny mount at U4 with the M720q from the inspector, the two-drive rack at U6 with two 3.5" drives, the KWS power-supplies shelf at U8–U9; each placement and device is In my rack (`data-have`, accessible names). |
| Add the 3U at the top, then the bottom                 | E2E: Rack tab, Set height 12U at the top: a new 3U To get on top, and the golden list. "Move down" twice: the 3U is at the bottom, the list is unchanged, and every placement's `data-u-start` went up by 3 (U7, U9, U11).                                                                                                                                                     |
| Keyboard only and mouse only                           | Two E2E tests. Keyboard: Tab into the palette, search, ↓ into the results, Tab to Add at U…, arrows to the U, Enter; F6 to the inspector, Tab to Add device, search, ↓, Enter; F6 and Tab to "Done, start planning"; the Rack tab through the tab list, the height typed into Set height, Apply; B opens the BOM with the golden list.                                         |
| The shopping list equals the golden output             | Both E2E tests assert the 7 golden lines and numbers (table above).                                                                                                                                                                                                                                                                                                            |
| Second cycle (Got it → Finish build → next 3U) correct | E2E: Got it on all 7 lines ("Nothing to get"), Finish build (the dialog lists only Section 1 (3U)), the shopping list is empty, then 15U at the top: the same 7 lines and numbers again, because Finish build used up the spares.                                                                                                                                              |
| CSV                                                    | E2E: Export CSV is a download that starts with the UTF-8 BOM (EF BB BF), uses CRLF, and has `Hardware to buy,M5 heat-set insert (M5x8x7),insert,36,0,50,pcs,…`.                                                                                                                                                                                                                |
| Accessibility                                          | axe (serious, critical): none in the recorded editor with a selection, with the BOM open, and on the sample with a selection and the BOM open in light and dark; in both desktop projects. The M2 axe test still covers the editor too.                                                                                                                                        |
| Phones                                                 | `mobile` project: the editor and the BOM sheet do not scroll sideways, the BOM sheet shows the shopping list, and tap-to-place from the Parts sheet lands on the tapped U and shows the part in the Inspector sheet.                                                                                                                                                           |

## What shipped

- **Rack** (`src/features/editor/rack`): the to-scale SVG (44.45 mm per U, rails, holes, U
  labels), section bands with In my rack / To get (icon, words, solid vs hatched) and + handles,
  placements with their devices and a "To get" tag, click-to-place with a ✓/✗ ghost and its reason,
  keyboard placing (↑/↓, Shift 5, ←/→ halves, Enter; Shift+Enter keeps placing), roving focus over
  parts (↑/↓ move the selected part, Alt moves without selecting, Delete with Undo, Ctrl+D),
  Ctrl+wheel zoom, Fit, "Add at U…", the "Rack contents" list for screen readers, Front/Rear.
- **Palette** (`palette`): search, Mounts & panels / Devices / My parts, category chips, "Fits
  this frame", Place, Add at U…, add devices to Equipment to fit, links to the designer's page.
- **Inspector** (`inspector`): placement (In my rack / To get, label, Move to U…, devices per slot
  with fit and Remove, Add device, options, facts, Duplicate, Add another at U…, Delete with
  retire), section (mark, mark everything in it, move, split, merge, remove or retire, options),
  several things at once, and the Rack tab (frame facts, the stack editor, Set height, frame
  options and the top and bottom).
- **BOM drawer** (`bom`): Shopping list / Full BOM / Leftovers, prints, hardware and equipment,
  packs, the "Why" sum with where every unit comes from, Got it, Finish build (with Undo and "Start
  the next idea from here"), CSV export.
- **Checks** (`checks`): errors, warnings and notes with icons and words, each selecting its part,
  and the power summary.
- **Equipment to fit** (`equipment`): devices waiting for a place, the space they need ("Needs ~4U
  · rack 9U, 9U free"), mount suggestions that start placing, and growing the rack by the
  shortfall.
- **Shell** (`EditorPage`, `layout`, `toolbar`): the toolbar (name, save state, Undo/Redo, zoom,
  Fit, Front/Rear, Checks and BOM summaries, keyboard help), Recording and placing banners,
  columns from `lg` up and sheets below, panel error boundaries, the global shortcuts and the
  shared live region.
- **Domain** (`src/domain/build.ts`, `devices.ts`): Have/Need marks with snapshots, Mark
  everything in a section, Finish build; the tray, device slots (fixed and area packing), mount
  suggestions and U estimates.

## Integration pass (what changed)

The engineers' reports were not part of this hand-off, so their "requests" lists could not be
read; the items below are what wiring the panels together turned up and fixed.

**Placing, selection and Add at U…**

- One placement per click: placing ends after a successful click or Enter, and the new part is
  selected, so the inspector shows it (before, placing went on and the ✗ ghost hid the new part).
  Shift-click and Shift+Enter keep placing; a device from the tray always goes in once. From the
  keyboard, focus moves to the new part, so the arrow keys move it.
- "Add at U…" is one dialog, the rack's, reached from the palette row, the placing banner and the
  inspector's new "Add another at U…": `requestAddAtU(source?)` now says what to add, so the
  palette no longer starts placing behind the dialog. Below `lg` an open sheet closes first. After
  placing, focus returns to the opener, or goes to the new part when the opener is gone.
- `selectInEditor` (`src/features/editor/selection.ts`) is the one way to select from the rack,
  its contents list, the inspector's lists, the checks and new parts: the inspector shows its
  Selection tab, the rack turns to the face the part is on (front or rear) and scrolls it into
  view.
- The rack's + handles use the Rack tab's insert and its conflict dialog (one dialog and one
  wording instead of two); a new section is selected.

**Consistency**

- One In my rack / To get toggle (`src/components/common/HaveNeedToggle.tsx`) for the inspector,
  the tray and the wizard; the wizard's "To get" now has the dashed outline instead of a solid fill.
- The BOM's "Why" says "In my rack" (was "In your rack") and its rows say "To get" (was "Need").
- Placing and adding sections in Recording mode says ", marked In my rack", like the inspector.
- The inspector uses the rack's position wording ("U3" for a 1½U part, not "U3–U4").
- Building something uses up the loose spares ticked as Got it, as Mark as In my rack does: placing
  and duplicating in Recording mode, the tray's In my rack toggle and its "Add 3U". In Recording
  mode the tray's "Add 3U" also marks the new section In my rack, like Set height.

**Panels working together**

- The slot's "Add device" offers devices waiting in Equipment to fit first (they keep In my rack
  / To get and leave the tray); its options have plain accessible names.
- F6 / Shift+F6 move between the toolbar, Parts, Equipment, the rack, the inspector, Checks and
  the BOM; listed in the keyboard help. While something is being placed, F6 to the rack lands on
  the drawing, where the arrow keys move the ghost; the tray's "Place on …" now focuses the drawing
  like the palette's Place.
- The palette announces through the shell's live region, which outlives its sheet on phones.
- The BOM and the checks are computed once per edit for the toolbar badges and the panels
  together (`src/state/derived.ts`, `checks/useEditorIssues.ts`).
- Contrast: the selected check's "Selected" label (4.3:1 on its tint) is full contrast now.
- Leftovers: the rack's own conflict dialog, its insert helper and the equipment tray's copy of
  the Have/Need toggle are gone; stale "placeholder"/"stub" comments updated.

## E2E coverage

| Spec                                         | What it proves                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `editor.spec.ts`: the golden fixture         | `kws-3-6-plus3-top.shopping.json` still holds 1 / 1 / 36 / 16 / 24 / 40 / 16                     |
| `editor.spec.ts`: mouse only                 | steps 1–9 above, plus Fit and selecting from the Checks panel                                    |
| `editor.spec.ts`: keyboard only              | steps 3–5 with the keyboard: Tab, arrows, Enter, F6, B                                           |
| `editor.spec.ts`: the sample, light and dark | axe with a selection and the BOM open                                                            |
| `editor.mobile.spec.ts`: the BOM sheet       | no sideways scrolling, the shopping list in the sheet                                            |
| `editor.mobile.spec.ts`: tap to place        | Parts sheet → Place → the sheet closes → tap U9 → placed, selected, shown in the Inspector sheet |
| `plans.spec.ts` (M2, updated)                | the recorded plan's stack is read from the Rack tab now (`stack-row-*`, `data-have`)             |

Every test also fails on console errors, uncaught exceptions and CSP violations.

## Known gaps for M3b

> **Update (M3b):** pointer editing, Fit it for me, Needs a mount?, custom parts, area-slot
> orientations, extras and retired parts, and checks on tray entries are now covered; see
> [m3b.md](m3b.md). The wizard's "Fit my equipment" goal is still to come.

- **Pointer editing**: no drag from the palette (dnd-kit), no dragging placed parts, no long-press
  or pinch on touch, no drop-on-empty mount chooser; keyboard moves, Move to U… and Add at U… cover
  it for now.
- **Fit it for me**, the **Needs a mount?** helper and the wizard's "Fit my equipment" goal.
- **Custom parts**: the custom device, item and frame editors and the manual "Add a part" wizard.
- **Area slots**: devices are packed left to right; choosing an orientation or a position in the
  slot is not offered yet.
- **Extras and retired parts**: there is no list to edit accessory quantities (the catalog has no
  accessories yet) or to reuse, keep or discard retired parts (they show as leftovers).
- **Checks on tray entries** (an unknown device in Equipment to fit) select nothing visible.
- **F6** works in Playwright's Chromium; check it by hand in desktop browsers, where the browser
  may claim the key in some setups (Tab always works).
- Several panels still keep their own polite live region besides the shell's (rack, inspector,
  Add at U…); they are separate on purpose (a panel's region goes with the panel), but on a phone
  an announcement from inside a sheet can be cut when the sheet closes.

## What I need from you

1. **Sign-off on v0.1**: record your real 3U + 6U with your gear, add the 3U at the top and then
   move it to the bottom, and compare the shopping list with what you bought last time. Then merge
   the PR and tag `v0.1.0`.
2. **F6**: press F6 a few times in the editor in your desktop browser and tell me whether focus
   moves between the panels.
3. Everything in [m2.md](m2.md#what-i-need-from-you) and
   [m0-m1.md](m0-m1.md#what-i-need-from-you) still stands.
