# Catalog

The shared catalog: the rack frames, printed items, devices and hardware the planner knows about.
There is one JSON file per entry. The app bundles these files at build time and never fetches
anything; the links in them are shown as _Open page_ links only.

Your own parts don't belong here. The app keeps them in your plans and library with `custom:` ids.
To share one, use _Share with everyone_ in the app or open a catalog submission issue.

## Layout

| Path                   | Holds                                                                  |
| ---------------------- | ---------------------------------------------------------------------- |
| `frames/<id>.json`     | Rack frame systems (`"kind": "frame"`)                                 |
| `items/<id>.json`      | Printed mounts, panels and shelves (`"item"`), accessories (`"extra"`) |
| `devices/<id>.json`    | Equipment such as mini PCs, switches, drives and PDUs (`"device"`)     |
| `hardware/<id>.json`   | Screws, nuts, inserts, magnets and other bought parts (`"hardware"`)   |
| `alignments/<id>.json` | Curated records that map a designer's model file onto a 3D part        |
| `schema/*.schema.json` | JSON Schemas, generated from the app's zod schemas (don't edit)        |
| `ids.lock`             | Every published id (generated, append-only)                            |
| `replaced.json`        | Retired ids mapped to their replacements                               |

## Rules

1. **Facts and links only.** Sizes, U heights, plate names, part counts, grams, print times and
   hardware. No images, no copied description text and no model files (`.stl`, `.3mf`, `.step`,
   `.zip`, `.gcode`). Notes stay short (400 characters at most). Model files are import-only: each
   user drops the files they downloaded (a MakerWorld 3MF or ZIP, or any STL or 3MF) into the app,
   which matches them to an entry's `parts3d` by name hints and alignment records.
2. **Link the source.** `source.url` points at the page the facts come from. MakerWorld entries
   use the model link (`https://makerworld.com/en/models/<id>`) and set `modelId` to the number in
   it, plus `designer` as the page shows it.
3. **Copy the licence label exactly as the page shows it**, e.g. `"Standard Digital File License"`,
   `"BY-NC-SA"` or `"MakerWorld Exclusive License"`. Don't shorten, translate or "correct" it.
4. **Say how you checked.** `verified` holds `by`, `date` (YYYY-MM-DD) and `method`: `page`,
   `user-files` (your downloaded files or slicer), `calipers`, `vendor-spec` or `unverified`. An
   `unverified` entry needs a `note` that says what still needs checking.
5. **Ids never change.** Ids are kebab-case and equal the file name. Once merged, an id is never
   renamed or removed. This also applies to the ids inside an entry that saved plans refer to:
   section types, options and their choices, prints, 3D parts and slots. To retire an id, keep
   the entry or map the old id to its replacement in `replaced.json`.

## Conventions

- Millimetres everywhere. Item heights are in sixths of a U (`"heightSixths": 6` is 1U), so ½U
  and ⅓U are exact.
- Devices: `brand` and `model` are separate fields. `dims` are `w` × `d` × `h` as the device
  normally sits.
- Hardware ids name the part: `screw-m5x10-shcs`, `screw-m6x12-bhcs`, `nut-m6-nyloc`,
  `insert-m5x8x7`, `magnet-10x5`. Add `aliases` with the ways people write it (`"M5x10 SHCS"`) and
  typical `packSizes`.
- Prints use the plate names from the designer's profile or files, for example
  `[Print x4] - Magnetic frame - 6U`. Recipes, quantities and options are described in
  `src/domain/README.md`.

## Validate before you open a pull request

```sh
npm run validate-catalog             # checks everything, adds new ids to ids.lock, regenerates schema/
npm run validate-catalog -- --check  # CI mode: also fails if ids.lock or schema/ are out of date
```

Commit `ids.lock` and `schema/` together with your entries. If you rename an id that your own,
unmerged pull request added, delete its old lines from `ids.lock` by hand; ids that are already
merged need a `replaced.json` mapping instead.

The validator checks the schema (with no unknown fields), the folder and file name, unique ids,
that every referenced hardware, print, device, frame and 3D part exists, the rules above and the
published ids.

For editor hints in VS Code, map the generated schemas in your user or workspace settings:

```json
"json.schemas": [
  { "fileMatch": ["/catalog/frames/*.json"], "url": "./catalog/schema/frame.schema.json" },
  { "fileMatch": ["/catalog/items/*.json"], "url": "./catalog/schema/item.schema.json" },
  { "fileMatch": ["/catalog/devices/*.json"], "url": "./catalog/schema/device.schema.json" },
  { "fileMatch": ["/catalog/hardware/*.json"], "url": "./catalog/schema/hardware.schema.json" },
  { "fileMatch": ["/catalog/alignments/*.json"], "url": "./catalog/schema/alignment.schema.json" }
]
```

## Licence

The catalog data is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (see
`LICENSE`). The designs, files and pages it links to keep their own licences, shown in each
entry's `source.license`.
