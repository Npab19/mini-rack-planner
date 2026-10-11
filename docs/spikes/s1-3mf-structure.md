# Spike S1: 3MF / STL structure of the KWS files

**Status:** the parser core is built and tested on synthetic packages. The results from the real KWS v2
downloads are **TODO**: they need the user's files, which never enter the repository.

S1 answers how MakerWorld / Bambu Studio package the KWS v2 parts, so M7 (ingest worker, linking, auto-align)
can be designed on facts instead of guesses. It also delivers the DOM-free parsing core that M7, the Node
scripts and the tests share.

## What was built

Everything lives in `src/lib/shared/model/`. It is DOM-free and Node-free, so the same code runs in a
module worker, in Node scripts (`tsx`) and in Vitest. Only `scripts/model-structure.ts` reads files from disk.

| Module                       | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zip.ts`                     | Random-access ZIP reader over a `RandomAccessSource` (`bytesSource`, `blobSource`, a Node file handle). Reads the end record (with ZIP64) and the central directory, then inflates only the entries asked for, in 64 KiB deflate steps (fflate `Inflate`). Handles UTF-8 names (with or without the flag), the Info-ZIP Unicode Path field (0x7075, CRC-checked), a CP437 fallback, and bytes prepended to the archive. Checks the CRC-32 of every entry. |
| `xml.ts`                     | `tokenizeXml` / `parseXml`: a small string tokenizer for `.rels` and `.config` parts. `ModelXmlScanner`: a streaming byte-level scanner for `3D/*.model` parts. `<vertex>` and `<triangle>` go straight from bytes to numbers (attribute order free, unknown attributes like `paint_color` skipped, exponent notation, any chunk boundary). Every other element is decoded and handed to a handler.                                                       |
| `opc.ts`                     | Part names: resolving relationship targets and `p:path` to ZIP entries, with fallbacks (URI-decoded, case-insensitive, unique `_<id>.model` suffix in the same folder).                                                                                                                                                                                                                                                                                   |
| `modelPart.ts`               | One model part streamed into records: objects (mesh or components), build items, metadata, unit. Converts to millimetres.                                                                                                                                                                                                                                                                                                                                 |
| `bambu.ts`                   | `Metadata/model_settings.config` (object/part names, part subtypes, plates, instances, assembly view), `Metadata/slice_info.config` (time, grams, filaments per plate) and the print tags in plate names.                                                                                                                                                                                                                                                 |
| `prusa.ts`                   | `Metadata/Slic3r_PE_model.config`: PrusaSlicer volume triangle ranges, so modifiers merged into a mesh can be left out.                                                                                                                                                                                                                                                                                                                                   |
| `threemf.ts`                 | `parseStructure` (facts, no geometry kept) and `parseMeshes` (one mesh per root object).                                                                                                                                                                                                                                                                                                                                                                  |
| `stl.ts`                     | Binary STL (size rule `84 + 50n`) and ASCII STL (byte-level; several `solid` blocks become groups), welded into an indexed mesh.                                                                                                                                                                                                                                                                                                                          |
| `mesh.ts`, `transform.ts`    | Bounds, quantized vertex welding, transformed appends with winding fix, area and volume, islands (connected pieces, cavities), 3MF affine transforms.                                                                                                                                                                                                                                                                                                     |
| `hash.ts`                    | Incremental SHA-256 (hash-wasm, loaded lazily), file hashing, the `g1` geometry key and the geometry signature.                                                                                                                                                                                                                                                                                                                                           |
| `report.ts`, `reportText.ts` | Facts-only structure reports (JSON and text), shared by the CLI and later by the in-app "Report a problem" flow.                                                                                                                                                                                                                                                                                                                                          |
| `testing/*`                  | Builders for synthetic fixtures: meshes, binary/ASCII STL, Bambu/Orca/Prusa/core 3MF packages (fflate `zipSync`) and a low-level ZIP writer for hostile archives.                                                                                                                                                                                                                                                                                         |

## Design

### Data flow

```
File / Blob / fs handle ──► RandomAccessSource ──► openZip (end record, central directory)
   ──► _rels/.rels StartPart ──► root model part (streamed through ModelXmlScanner)
   ──► sub-model parts on demand, via component p:path ──► model_settings / slice_info / Slic3r_PE configs
   ──► parseStructure (facts)  |  parseMeshes (geometry, transferable typed arrays)
```

`parseStructure` also reads the parts that the root part's own relationships declare
(`3D/_rels/3dmodel.model.rels`), so parts nothing references still show up, and missing ones are warned
about. Only `3D/**/*.model`, `*.rels` and the three config files are ever inflated. A 3MF is never unzipped
whole, and `parseMeshes(source, { objectIds })` inflates only the model parts those objects reach.

### Reference frame

`parseMeshes` returns one mesh per **root object** (the objects that build items place), in its
**object-local frame**:

- component transforms are applied (composed through nested components);
- the build-item transform is **not** applied. It is returned separately in `buildItems` (with
  `toColumnMajor4x4` for three.js), so the plate listing can still show where each instance sits;
- coordinates and translations are converted to millimetres from the part's `unit`
  (micron, millimeter, centimeter, inch, foot, meter);
- when a composed transform mirrors (determinant < 0) the triangle winding is reversed, so normals stay
  outward. A mirroring build-item transform is the consumer's to handle (`determinant()`).

The `g1` key and the signature are computed in this frame.

### Objects are addressed by (model part, object id)

Object ids are unique only within one model part. Bambu and Orca reuse id 1 in every
`3D/Objects/*.model` part, so lookups never use a flat id map. Components without `p:path` refer to their
own part. Part names are resolved in this order: exact, URI-decoded (`Leg%206U_2.model`), case-insensitive
(OPC names are case-insensitive), and finally the only entry in the same folder with the same `_<id>.model`
suffix (OrcaSlicer's `<name>_<id>.model` with a name mangled differently). Case-insensitive and suffix matches
are reported as warnings, and missing parts too. Component cycles and nesting deeper than
`maxComponentDepth` are rejected.

### What counts as printed geometry

- 3MF object `type` must be `model` or `solidsupport`; `support`, `surface` and `other` are skipped.
- Bambu/Orca: for a root object's components, the part subtype in `model_settings.config` must be
  `normal_part`. `modifier_part`, `negative_part`, `support_blocker` and `support_enforcer` are skipped.
  The part id is the component's object id.
- PrusaSlicer: triangle ranges of volumes other than `ModelPart` (from `Slic3r_PE_model.config`) are cut
  out of the object's mesh, and the unused vertices are dropped.

Skipped triangles are counted (`skippedTriangleCount`). `parseStructure` reports every component as
`included` or skipped, with its subtype.

### Plates and print tags

Plates come from `model_settings.config`: id, name, and instances (`object_id` + `instance_id`).
`instance_id` is resolved to a build item as "the n-th build item of that object, in build order"
(`buildItemIndex`). Plate names are parsed for MakerWorld tags: `[Print x4]`, `[Print 4x]`, `(Print ×4)`,
`[x4]` and `[4x]` give `copies`, and `[Optional]` gives `optional`. `cleanName` is the name without tags and
separators (`"[Print x4] - Magnetic frame - 6U"` → 4 copies, `"Magnetic frame - 6U"`).

### Metadata

Root-model metadata is kept as key/value pairs (`Title`, `Designer`, `DesignerUserId`, `License`, `Origin`,
`ProfileTitle`, `Application`...). Keys matching `/description/i` are dropped at parse time and only listed
in `omittedMetadataKeys`: the catalog stores facts and links, never copied descriptions.
`producer` comes from `Application` (`bambu-studio`, `orca-slicer`, `prusa-slicer`, `other`).

### Limits (zip bombs and runaway files)

All caps live in `ModelLimits` (`DEFAULT_LIMITS`) and end in a typed `LimitExceededError`
(`code: 'limit-exceeded'`, `limit`, `actual`, `max`):

| Cap                                | Default     | Checked                                                                    |
| ---------------------------------- | ----------- | -------------------------------------------------------------------------- |
| `maxEntries`                       | 10,000      | declared count, before the central directory is read                       |
| `maxEntryInflatedBytes`            | 1 GiB       | declared size, before inflating                                            |
| `maxTotalInflatedBytes`            | 2 GiB       | declared and actual, across the archive                                    |
| `declared-size`                    | n/a         | actual output past the entry's declared size (lying headers) stops at once |
| `maxTriangles` / `maxVertices`     | 20 M / 30 M | while scanning, across all parts                                           |
| `maxXmlTokenBytes` / `maxXmlDepth` | 8 MiB / 256 | scanner carry-over and nesting                                             |
| `maxComponentDepth`                | 32          | component trees                                                            |

Inflation runs in 64 KiB input steps, so one step yields at most ~66 MiB, even for a bomb.
Overlapping entries (several central records pointing at one payload) hit the total cap. Other failures
have their own codes: `not-a-zip`, `zip-corrupt` (signatures, sizes, CRC, bad deflate), `zip-unsupported`
(multi-disk, compression other than stored/deflate), `zip-encrypted`, `xml-malformed`, `invalid-3mf`,
`invalid-stl`. DOCTYPE declarations are skipped and custom entities never expanded.

### Hashing and fingerprints

- `sha256OfSource` streams a file through hash-wasm in 4 MiB chunks. hash-wasm is imported lazily on first
  use, so it stays out of the initial bundle, and keys match on HTTPS and on plain-HTTP LAN origins
  (no `crypto.subtle` needed).
- `geometryKeyG1` (`g1:<sha256>`): vertices quantized to 0.01 mm (int32) relative to the min corner of the
  referenced vertices, each triangle rotated so its smallest vertex is first (winding kept), triangles
  sorted lexicographically, then SHA-256. It is the same for one mesh read from binary STL, ASCII STL or 3MF
  (tested), and ignores vertex order, triangle order, corner rotation, translation and unused vertices.
  It changes with rotation and mirroring. A mirrored copy re-triangulates its faces, so even a symmetric box
  gets a different key.
- `geometrySignature`: `{ tri, areaMm2, volMm3, extMm (sorted) }`, rounded to 0.01. Rotation and mirroring
  leave it unchanged, which makes it the candidate filter when g1 keys differ.

### Performance (Node 24, this machine)

From `perf.test.ts`, on a generated 500,000-triangle grid (31.5 MiB of model XML, 4.2 MiB zipped):
`parseMeshes` 551 ms, `parseStructure` 481 ms, `geometryKeyG1` 199 ms. A 500,000-triangle binary STL
parses and welds in 59 ms. The test asserts under 8 s, to stay stable on busy CI runners.

## Running the dump on your files

The structure dump reads files only. It contacts nothing (no MakerWorld, no network) and writes nothing.

1. Download the KWS v2 files from MakerWorld yourself (print-profile 3MF and/or STL/ZIP). Put them in a
   folder **outside the repository**, for example `C:\Users\<you>\MiniRackModels\KWS v2\`.
   `.gitignore` blocks model extensions, but don't rely on it: model files must never be committed.
2. Run, from the repository root (PowerShell):

   ```powershell
   $env:MRP_LOCAL_MODELS = "C:\Users\<you>\MiniRackModels"
   npx tsx scripts/model-structure.ts                        # every .3mf / .stl / .zip under the folder
   npx tsx scripts/model-structure.ts "C:\Users\<you>\MiniRackModels\KWS v2\leg-6u.3mf"
   npx tsx scripts/model-structure.ts --json > "$env:TEMP\kws-structure.json"
   ```

   Options: `--json` (machine-readable), `--no-geometry` (skip bounds, islands, signature and g1, which is
   faster), `--metadata-keys-only` (hide metadata values such as the designer's name).

3. Paste the text output, or the facts from it, into the results table below. The output is facts only:
   ZIP entry names and sizes, metadata keys and values (descriptions omitted), objects (names, types,
   triangle counts, bounds), components (part, subtype, included or skipped, transform summary), build items,
   plates with print tags and instances, the assembly view, slice info, and per root object: triangle and
   vertex counts, size, bounds, islands (solid or cavity, size, position, volume), signature and g1 key.
   **It never prints vertices or description text.**

Exit code: 0 when every file was read, 1 when a file failed (the report shows the error code and, for ZIPs,
the entry listing), 2 for usage errors. A `.zip` of STLs is described entry by entry, and 3MFs inside it too.

## Questions S1 must answer

For each downloaded KWS v2 file:

1. **Objects or merged islands per plate.** Is the 3U leg plate (4 legs, ~214 g) four objects, four instances
   of one object, or one object with four islands? Is each 6U `[Print x4]` plate one leg? This decides whether
   M7 splits islands into separate parts. _Look at:_ plates → instances, root objects → components,
   `islands:` per mesh.
2. **Identical or mirrored legs.** Are left and right parts the same mesh placed with a mirroring transform,
   separate mirrored meshes, or identical? _Look at:_ `MIRRORED` on components and build items, and g1 versus
   signature across objects (equal signature with a different g1 means a mirrored or rotated copy).
3. **Sliced or not.** Does the profile 3MF include `slice_info.config` (grams and time per plate)? If not,
   grams come from the designer's page or from slicing in Bambu Studio. _Look at:_ `slice info:`.
4. **Units.** Millimetres expected. _Look at:_ the `3MF:` line (`unit ... (x1 to mm)`).
5. **Transforms.** Component transforms (volume placement), build-item transforms (plate positions,
   rotations about Z) and the assembly view (`assemble_item`), and whether the assembly view gives usable
   rack poses for M7's curated alignment. _Look at:_ `->` component lines, `build items:`, `assembly view:`.
6. **Where the 7 base magnets sit.** If the magnets are embedded (pause at height), their voids are enclosed
   shells: they show up as `cavity` islands with their size (about 10 x 10 x 5 mm) and position. If they
   are open pockets, they are not separate islands, so note that and locate them in Bambu Studio instead.
7. Also record: producer and version, part subtypes present (modifiers?), the plate names as written (tag
   variants the parser must keep handling), `faceCount` against counted triangles, and file size against
   triangle count (performance budget).

## Results (TODO: fill in from the real files)

| File                                                                 | Producer / version | Unit | Plates → tags | Root objects (parts) | Islands per object | Mirrored? | Sliced? | Notes |
| -------------------------------------------------------------------- | ------------------ | ---- | ------------- | -------------------- | ------------------ | --------- | ------- | ----- |
| TODO: 6U leg                                                         |                    |      |               |                      |                    |           |         |       |
| TODO: 3U leg plate                                                   |                    |      |               |                      |                    |           |         |       |
| TODO: frame connectors                                               |                    |      |               |                      |                    |           |         |       |
| TODO: top handle / flat top                                          |                    |      |               |                      |                    |           |         |       |
| TODO: top / bottom connectors                                        |                    |      |               |                      |                    |           |         |       |
| TODO: base legs (7 magnets)                                          |                    |      |               |                      |                    |           |         |       |
| TODO: optional parts (stoppers, grills, fan tops, 320 mm connectors) |                    |      |               |                      |                    |           |         |       |

**Decisions to record here once the table is filled:** split islands or not (question 1); mirrored-leg
matching (question 2, g1 against signature); whether `slice_info` can feed print rows (question 3); whether
the assembly view seeds the KWS frame alignment (question 5); the magnet positions for the catalog
(question 6).

## Assumptions to confirm on the real files

- Bambu part id = the component's object id (true for Bambu Studio's writer; the dump shows `subtype` on each
  component line, so a mismatch would appear as `no subtype`).
- `instance_id` = the n-th build item of that object, in build order (`(item n)` next to each plate instance).
- OrcaSlicer part naming and `p:path` encoding: the dump warns whenever a fallback was needed.

## Known limits

- ZIP: stored and deflate only (Deflate64, bzip2, LZMA and zstd are rejected as `zip-unsupported`; MakerWorld
  uses deflate). No encryption, no multi-disk archives.
- 3MF extensions that are ignored: materials and colours, multi-material painting attributes, beam lattice,
  slices. Production-extension UUIDs are not used.
- STL has no unit, so millimetres are assumed. Welding uses a 1e-4 mm grid, so two vertices on either side of
  a cell boundary stay apart; exact duplicates, which is what STL exporters write, always weld.
- `parseMeshes` keeps every mesh of the root part in memory while it assembles. Sub-model parts are read only
  when the requested objects reach them.
