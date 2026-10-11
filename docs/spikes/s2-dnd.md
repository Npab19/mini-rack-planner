# Spike S2: drag and drop onto the to-scale SVG rack

**Decision: keep `@dnd-kit/react` 0.5.0, but only for palette → rack drops, behind `useRackDnd`.** Placed items move with plain Pointer Events and `setPointerCapture`. Keyboard moves and tap-to-place are our own code. The target U always comes from the pointer through `svg.getScreenCTM().inverse()` and pure snapping, never from dnd-kit collision shapes. All 93 checks pass at 50/100/200 % zoom with two different pan/zoom techniques, on touch, on the dev server and on a production build under the production CSP. The recommended contract is in [The `useRackDnd` contract for M3b](#the-userackdnd-contract-for-m3b).

- Date: 2026-10-11.
- Environment: Chromium 156.0.8078.4 (Playwright 1.64.0, headless), Vite 8.3.4 with Rolldown 1.2.13, React 19.3.0 (StrictMode in dev), `@dnd-kit/react` 0.5.0 (with `@dnd-kit/dom`, `abstract`, `collision`, `geometry` and `state` at 0.5.0), Tailwind 4.3.3, Node 24.20.0, Windows 11.
- Scope: the 2D editor's palette drops, moves, keyboard, touch and zoom/pan (M3b). Model files are not involved. A palette entry can be a catalog item or a part the user imported from an STL/3MF (from MakerWorld or anywhere else); the drag contract does not care which.

## What was built

- **`/dev/spike-dnd`** (`src/features/dev/SpikeDndPage.tsx` and `src/features/dev/spike-dnd/**`):
  - A 254 mm × 12U rack (1U = 44.45 mm) drawn in a millimetre viewBox, with U labels, rails and ear holes 236.525 mm apart at 6.35 / 22.225 / 38.1 mm in each U.
  - A palette of three items (1U, 2U, ½U). Each is a shadcn `Toggle` (Base UI `<button aria-pressed>`) registered as a dnd-kit draggable. A `DragOverlay` shows the carried item.
  - **One droppable** for the front face: the clipping viewport element around the SVG.
  - Zoom 50 / 100 / 200 % (100 % = 1.5 px per mm, so 1U = 66.7 px). Pan with buttons, the wheel or a background drag.
  - Two interchangeable pan/zoom techniques: a **viewBox camera** (the SVG fills the viewport and only the viewBox changes) and a **CSS transform** (`translate() scale()` on a wrapper around a fixed-size SVG).
  - An in-SVG ghost: green dashed with ✓ and "Fits at U5–U6", or red hatched with ✗ and the reason ("Blocked: Overlaps 1U patch panel at U8"). The hatch, icon and text mean colour is never the only cue.
  - Overlaps and out-of-rack positions are refused. Nothing is committed until the gesture ends.
  - Placed items move with Pointer Events and `setPointerCapture`, using the same snapping and ghost. On touch, a 250 ms long-press starts the drag and a swipe pans instead.
  - Keyboard: a focused item moves with ↑/↓ (1U) and Shift+↑/↓ (5U), and Delete removes it. Every result is announced in an `aria-live` region. An "Add item at U" form gives a keyboard path for placing.
  - Tap-to-select then tap a U to place (mouse users get a hover preview of the same ghost).
  - Probes exposed as `data-*` attributes: dnd-kit writes to SVG nodes (MutationObserver), the injected-style cascade, and whether dnd-kit's drop target agreed with our own hit test. `?probe=svg-default|svg-guarded` adds an SVG node registered as a dnd-kit draggable, to measure the Feedback pitfall.
- **`rackModel.ts`**: pure geometry, snapping and occupancy checks in integer sixths of a U, with 17 unit tests (`rackModel.test.ts`). It mirrors what `src/domain` will own and is inlined because the domain is being written at the same time.
- **`scripts/spikes/dnd-check.ts`**: the end-to-end check described below.

## How it was verified

- **Oracle.** "Which U" is taken from the rendered `U<n>` label's bounding box, never from the app's maths. A separate probe found the label centre equals the CTM-mapped row centre to within 0.0001 px at all three zooms.
- **Servers.**
  - Dev: the script starts Vite on `127.0.0.1:5181` with its own optimizer cache and no file watcher. The server sends the production CSP plus two dev-only allowances (`'unsafe-inline'` scripts for the React refresh preamble and `ws://127.0.0.1:5181` for the Vite client).
  - Production: `VITE_SPIKES=1 vite build` into a temporary directory, then `vite preview`, which sends the exact production headers from `scripts/headers.ts`. The script ran against it with `DND_CHECK_URL`.
- **Desktop scenarios** (1280 × 1000; each technique × each zoom; every scenario first pans right and down with the buttons):
  1. Ghost sweep: one palette drag of the 2U item over every U at the row centre and at ±30 % of the row, checking the ghost's U and ✓/✗ against the seeded layout, then Escape. At 200 % the hidden rows were brought into view by wheel-panning **during** the drag.
  2. The acceptance drop: the 2U item from the palette to the U5 row, `steps: 15`, then `data-u-start` on the placed item.
  3. A pointer move of the placed item from U5 to U9 (the U you grab stays under the pointer).
  4. Keyboard: ↑, Shift+↓, ↑, ↑ (blocked by the 1U at U8), Delete, plus the `aria-live` text.
  5. dnd-kit writes to SVG nodes, dnd-kit target agreement, injected-style cascade, console errors and CSP violations.
- **Touch scenarios** (412 × 915, DPR 2.625, `hasTouch` and `isMobile`, 100 %; both techniques): tap-to-select, tap-to-place (including both halves of a U for the ½U item), a blocked tap, a long-press drag of a placed item and a quick swipe over an item, all through CDP touch events. A long-press drag from the palette exercises dnd-kit's touch path.
- **Pitfall probe**: drag an SVG `<rect>` registered as a dnd-kit draggable (no overlay, SVG drawn at 4 px per user unit) with the default Feedback and with `feedback: 'none'`.

## Results

### Desktop: identical for both techniques, on dev and on the production build

| Zoom  | U row (px) | Ghost sweep | Palette drop 2U → U5 | Drop point   | Pointer move U5 → U9 | Keyboard ↑ ⇧↓ ↑ ↑ Del          | dnd-kit target agreed | dnd-kit writes to SVG | Console errors / CSP |
| ----- | ---------- | ----------- | -------------------- | ------------ | -------------------- | ------------------------------ | --------------------- | --------------------- | -------------------- |
| 50 %  | 33.3       | 36/36       | U5                   | 27.00 sixths | U9                   | 10, 5, 6, 6 (blocked), removed | 1/1                   | 0                     | 0                    |
| 100 % | 66.7       | 36/36       | U5                   | 27.00 sixths | U9                   | 10, 5, 6, 6 (blocked), removed | 1/1                   | 0                     | 0                    |
| 200 % | 133.3      | 36/36       | U5                   | 27.00 sixths | U9                   | 10, 5, 6, 6 (blocked), removed | 1/1                   | 0                     | 0                    |

- 27.00 sixths is the exact centre of U5 (sixths 24 to 30), so the drops landed on the aimed point with no offset at any zoom.
- The blocked keyboard move announced "Can't move 2U mini PC shelf up: overlaps 1U patch panel at U8." and the removal announced "Removed 2U mini PC shelf from U6–U7."
- Escape during a palette drag cancelled it, and nothing was added.
- Run time: about 44 s on the dev server and 39 s on the production preview, for 93 checks plus 19 observations.

### Touch: all pass for both techniques

| Check                                                          | Result                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Tap selects the palette item                                   | `aria-pressed="true"`                                             |
| Tap the lower, then the upper half of U3 with the ½U item      | placed at U3 and U3.5                                             |
| Tap U8 (occupied) with the 2U item                             | ✗ ghost "overlap" stays on screen, nothing placed, selection kept |
| Tap U4                                                         | placed at U4                                                      |
| Long-press (400 ms) and drag from U4 to U9                     | moved to U9                                                       |
| Quick swipe starting on the item                               | item stays at U9 and the view pans                                |
| dnd-kit long-press drag of the 1U item from the palette to U11 | placed at U11                                                     |
| Console errors / CSP violations                                | 0                                                                 |

### Pitfall probe: an SVG node as a dnd-kit draggable

| Feedback | `data-dnd-dragging` | Nodes                                             | Node movement for a 40, −20 px pointer move | Size                   |
| -------- | ------------------- | ------------------------------------------------- | ------------------------------------------- | ---------------------- |
| default  | `true`              | 2 (a placeholder clone was inserted into the SVG) | 158, −79 px                                 | 79 × 79 → 314 × 314 px |
| `'none'` | absent              | 1                                                 | 0, 0                                        | unchanged              |

The default Feedback applies `translate`, `width` and `height` in CSS px. On an SVG element those are read as user units, so at 4 px per unit the node moved and grew about 4×.

### Bundle

- The spike chunk is 141 KB minified, 47 KB gzip. It is lazy, so nothing here is in the initial bundle.
- dnd-kit (`react`, `dom`, `abstract`, `geometry`, `state`, `collision`) plus `@preact/signals-core` is about 96 KB minified, 31 KB gzip of that chunk.

## dnd-kit 0.5 APIs used (exact names)

- **`@dnd-kit/react`**
  - `DragDropProvider` props: `sensors`, `plugins`, `onDragStart`, `onDragMove`, `onDragEnd`.
  - `DragOverlay` props: `dropAnimation={null}` (no fly-back to the palette), `className`, and children as a function `(source) => ReactNode`.
  - `useDraggable({ id, type, data })` returns `{ ref, isDragSource }`.
  - `useDroppable({ id, accept, collisionDetector })` returns `{ ref, isDropTarget }`.
  - `useDragDropMonitor({ onDragStart, onDragMove })` (style probe only).
  - `PointerSensor.configure({ activationConstraints })`.
  - Event types `DragStartEvent`, `DragMoveEvent`, `DragEndEvent`.
- **`@dnd-kit/dom`** (`@dnd-kit/react` re-exports only `PointerSensor`, `KeyboardSensor` and the event types)
  - `Feedback.configure({ feedback, dropAnimation })`, where `feedback` is `'default' | 'move' | 'clone' | 'none'` or a function `(source, manager) => …` of those.
  - Per draggable: `useDraggable({ plugins: [Feedback.configure({ feedback: 'none' })] })`. Options are read with `source.pluginConfig(Feedback)`.
  - `Accessibility`, removed from the plugin list.
  - `PointerActivationConstraints.Delay({ value, tolerance })` and `PointerActivationConstraints.Distance({ value })`.
  - Types `DragDropManagerInput` (for typing `plugins` and `sensors`) and `Draggable`.
- **`@dnd-kit/collision`**: `pointerIntersection`.
- **Event fields used**: `event.to` and `event.nativeEvent` on dragmove; `event.nativeEvent`, `event.canceled` and `event.operation.target` on dragend; `event.operation.source` on dragstart.
- **Defaults worth knowing**:
  - `plugins` takes an array (which replaces the defaults) or a function `(defaults) => plugins`. The defaults are `[Accessibility, AutoScroller, Cursor, Feedback, PreventSelection]`. The manager always adds `ScrollListener`, `Scroller` and `StyleInjector`. The registry de-duplicates by constructor, and the later entry's options win.
  - `sensors` defaults to `[PointerSensor, KeyboardSensor]`.
  - The default pointer activation is:
    - mouse on a handle: immediate;
    - touch: `Delay` 250 ms with 5 px tolerance;
    - text inputs: `Delay` 200 ms;
    - otherwise: `Delay` 200 ms with 10 px tolerance, **or** `Distance` 5 px.

The spike's configuration (`src/features/dev/spike-dnd/dndConfig.ts`):

```ts
export const PALETTE_SENSORS: DragDropManagerInput['sensors'] = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === 'touch'
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 5 })],
  }),
]

export function feedbackFor(source: Draggable): 'none' | 'default' {
  return source.element instanceof SVGElement ? 'none' : 'default'
}

// A module constant: the provider re-applies plugins whenever this value changes identity.
export const PALETTE_PLUGINS: DragDropManagerInput['plugins'] = (defaults) => [
  ...defaults.filter((plugin) => plugin !== Accessibility && plugin !== Feedback),
  Feedback.configure({ feedback: feedbackFor, dropAnimation: null }),
]

// The face viewport: useDroppable({ id: 'face:front', accept: 'palette-item',
//   collisionDetector: pointerIntersection })
```

## Pitfalls

1. **Feedback restyles the drag source, which breaks SVG.** It sets `data-dnd-dragging`, its CSS then sets `position: fixed`, `translate`, `width` and `height`, and it inserts a placeholder clone. On an SVG node that moved the node 4× too far and blew it up 4×, as measured above.
   - With a `DragOverlay` mounted, Feedback styles the overlay instead of the source (`feedbackElement = overlay ?? element`), so the HTML palette path was always safe.
   - The `feedbackFor` guard covers any SVG draggable without an overlay.
   - Measured: zero dnd-kit writes to SVG nodes in every drag.
2. **`dragmove` fires before the position updates.** While the event is dispatched, `event.operation.position.current` still holds the previous point; `DragActions.move` updates it in a microtask afterwards. Use `event.to` (from the pointer sensor) or `event.nativeEvent`.
3. **The drop point can lag the release by a frame.** The pointer sensor coalesces moves with `requestAnimationFrame` and drops the pending move on pointerup. `dragend`'s `nativeEvent` is the pointerup, so its `clientX`/`clientY` are the exact release point.
4. **The idle `DragOverlay` wrapper is part of the layout.** `DragOverlay` always renders its `<div data-dnd-overlay>`, which is empty while idle. It leaves the flow only when Feedback marks it as dragging (`position: fixed`, popover top layer).
   - Placed as a flex item with `p-0.5` in a `gap-3` column, starting a drag freed 16 px of layout. The viewBox camera re-centred, and the drawing shifted 8 px mid-gesture.
   - Every drop then landed 8.0 px above the aimed point: 28.44 / 27.72 / 27.36 sixths at 50 / 100 / 200 % instead of 27.00.
   - Fix: mount it in an out-of-flow wrapper (`absolute`, or a portal). After the fix, all drops landed at 27.00.
   - The CTM-at-event-time maths followed the shift correctly. Any geometry cached at drag start would have been 8 px off.
5. **Droppable shapes ignore clipping.** dnd-kit measures droppables with `getBoundingClientRect`, which ignores `overflow: hidden`. An SVG `<rect>` panned half out of view would still claim drops over the palette next to it. So the droppable is the clipping viewport, and the hit test also requires the pointer to be inside the viewport's rect.
6. **The Accessibility plugin fights our markup.**
   - On every draggable it rewrites `aria-pressed` and `aria-grabbed` to the drag state, which clobbers the palette's selected state. It also rewrites `aria-disabled`.
   - It adds `aria-roledescription="draggable"` and `aria-describedby` instructions for Space-bar dragging, which describe the KeyboardSensor we do not use.
   - The plugin is removed, and our own live region announces results.
7. **The KeyboardSensor competes with buttons.** Space or Enter on a palette button would start a keyboard drag instead of pressing the button. It is not registered. Keyboard placement is "select, then Add at U", and placed items use ↑/↓.
8. **The default mouse activation includes a 200 ms hold.** A slow click starts a drag and swallows the click. Mouse uses `Distance` 5 px only, so click-to-select is reliable.
9. **AutoScroller scrolls the document near viewport edges during a drag.** It moved the probe page by 18 px in an early run. Our maths is unaffected because it reads the CTM at event time, but a fixed-height editor layout avoids the surprise.
10. **Touch settings and one guard.**
    - The face sets `touch-action: none`, because the editor pans itself; otherwise the browser takes over a swipe and sends `pointercancel`. It also sets `-webkit-touch-callout: none` and suppresses `contextmenu` for long-press menus, which CDP touch does not exercise.
    - A touch pointer fires `pointerleave` on every lift, so a blocked tap's ✗ ghost must not be cleared on `pointerleave` for touch.
    - dnd-kit's palette long-press worked with the default `touch-action` on the buttons. After activation the sensor calls `preventDefault` on `touchmove`, so the page did not take over the gesture.
11. **Test harness: Chrome's local network access check.** A document fulfilled through Playwright `route.fulfill` has no loopback address space, so Chrome blocked the dev WebSocket to `127.0.0.1` (`net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`). The script sets the dev CSP with Vite `server.headers` instead. CDP touch state is per CDP session, so one gesture needs one session.

Design notes from building it (not measured):

- Render placed items in a stable DOM order. Moving the focused node, for example by sorting by U, blurs it in the middle of a keyboard move.
- SVG needs a drawn focus ring (`group-focus-visible:` on a `<rect>`) with at least 3:1 contrast.

## Was `@layer dnd-kit, base, components, utilities;` needed?

**No.** It was not added to `src/index.css`.

- dnd-kit's `StyleInjector` **prepends** its `<style>` to `<head>`, and re-prepends it if it is removed. So `@layer dnd-kit` is the first declared layer, which makes it the lowest. This holds in dev (Vite `<style>` tags) and in production (a `<link>`).
- Measured during drags, in dev and in production:
  - dnd-kit's style is first in `<head>`;
  - the overlay's Tailwind `p-0.5` computes to `2px`, so utilities beat the dnd-kit layer;
  - the overlay's `overflow` is `visible`, so dnd-kit's reset beats the UA `[popover]` style;
  - the overlay is in the top layer.
- Only dnd-kit's popover reset is inside `@layer dnd-kit`, so the statement can only ever affect that rule. The positioning rules it injects are unlayered and mostly `!important` (position, top/left, translate, transform, transition, pointer-events). We never need to override them.
- If the line is added anyway as insurance, use **`@layer dnd-kit, theme, base, components, utilities;`** as the first line of `src/index.css`. Do not use the plan's version without `theme`:
  - Compiled with Tailwind 4.3.3, the plan's line is followed by Tailwind's own `@layer theme, base, components, utilities;`.
  - That declares `theme` last, which makes it the **highest**-priority layer.
  - Both variants were compiled to confirm this.
- CSP: the injected `<style>` needs `style-src 'unsafe-inline'` (already in the production CSP) or a nonce through `StyleInjector.configure({ nonce })`. Feedback's inline custom properties are set through the CSSOM (`style.setProperty`), which CSP does not restrict. The production run had zero violations.

## Decision

| Option                                                   | Verdict               |
| -------------------------------------------------------- | --------------------- |
| **A. Keep `@dnd-kit/react` 0.5 for palette → rack only** | **Chosen.**           |
| B. Plain Pointer Events everywhere                       | Kept as the fallback. |
| C. Fall back to `@dnd-kit/core`                          | Not needed.           |

**Why A:**

- It passed every check: three zooms, two pan/zoom techniques, touch, and the production CSP.
- It provides the overlay in the top layer, activation constraints (a touch long-press versus a palette scroll), Escape-to-cancel, auto-scroll, the grabbing cursor, selection prevention and a droppable per face.
- The cost is about 31 KB gzip in the lazy editor chunk.
- The precise parts (U from the pointer, snapping, checks, ghost) are our own code anyway.

**Risks of A, and how they are contained:**

- 0.x API churn. All dnd-kit specifics sit in two files: the config constants and `useRackDnd`'s `providerProps`.
- The internals we rely on are `event.to`, `event.nativeEvent`, `Feedback` option names and the overlay's always-mounted wrapper. Re-run `scripts/spikes/dnd-check.ts` on every dnd-kit bump.

**Why B is only the fallback:** placed items already use the Pointer Events path. Doing palette drags the same way would mean re-implementing the overlay positioning and the touch activation for no measured gain. If dnd-kit 0.x breaks, the palette can switch to that path without changing the `useRackDnd` contract.

**Why not C:** it was not tried; it is not installed, and adding it needs approval. Nothing in the spike needed it. Switching would swap a working adapter for another dependency with a different API.

## The `useRackDnd` contract for M3b

The spike's prototype is `src/features/dev/spike-dnd/useRackDnd.ts`. M3b generalises it to both faces, catalog or custom subjects, and domain rules:

```ts
// src/features/editor/rack/useRackDnd.ts
import type { DragEndEvent, DragMoveEvent, DragStartEvent } from '@dnd-kit/react'
import type { KeyboardEvent, MouseEvent, PointerEvent, RefObject } from 'react'
import type { Sixths } from '@/domain/geometry'
import type { Verdict } from '@/domain/placement' // { ok: true } | { ok: false; code; message; conflictIds? }

export type RackFace = 'front' | 'rear'

/** What a gesture carries: a palette entry (catalog or custom part) or an existing placement. */
export type DragSubject =
  | { kind: 'item'; itemId: string; heightSixths: Sixths }
  | { kind: 'placement'; placementId: string; heightSixths: Sixths }

/** One command = one planStore commit = one undo step. Never issued mid-gesture. */
export type RackCommand =
  | { type: 'add'; itemId: string; face: RackFace; y: Sixths }
  | { type: 'move'; placementId: string; face: RackFace; y: Sixths }
  | { type: 'remove'; placementId: string }

export interface RackGhost {
  subject: DragSubject
  face: RackFace
  y: Sixths
  verdict: Verdict
  origin: 'palette' | 'move' | 'tap' | 'keyboard'
}

export interface RackFaceRefs {
  /** The clipping viewport: the face's dnd-kit droppable and the hit-test bounds. */
  viewport: RefObject<HTMLElement | null>
  /** Root <svg> of the face drawing (mm viewBox). Its CTM maps client px to mm. */
  svg: RefObject<SVGSVGElement | null>
}

export interface UseRackDndOptions {
  faces: Partial<Record<RackFace, RackFaceRefs>>
  /** Palette draggable data → subject. Returns null for anything that is not a palette entry. */
  subjectOf: (data: Record<string, unknown>) => DragSubject | null
  /**
   * Pure domain: snapped start for a pointer position. `grabOffset` (sixths from the item's
   * bottom) keeps the grabbed U under the pointer; 0 for palette drops, so the U under the
   * pointer becomes the item's bottom. Hole-aware phases live here.
   */
  snap: (subject: DragSubject, face: RackFace, pointerSixths: number, grabOffset: Sixths) => Sixths
  /** Pure domain: occupancy and the other placement checks for one candidate. */
  check: (subject: DragSubject, face: RackFace, y: Sixths) => Verdict
  commit: (command: RackCommand) => void
  announce: (message: string) => void
  /** Background drags and touch swipes. The camera belongs to useRackView. */
  onPan: (face: RackFace, dx: number, dy: number) => void
  /** Changes whenever a face's drawing moves on screen (pan, zoom, resize). */
  viewKey: string
  longPressMs?: number // default 250
}

export interface UseRackDndResult {
  ghost: RackGhost | null
  movingPlacementId: string | null
  /** Tap-to-place selection (the primary path on touch). */
  armed: DragSubject | null
  arm: (subject: DragSubject | null) => void
  /** Spread on <DragDropProvider> together with RACK_DND_SENSORS and RACK_DND_PLUGINS. */
  providerProps: {
    onDragStart: (event: DragStartEvent) => void
    onDragMove: (event: DragMoveEvent) => void
    onDragEnd: (event: DragEndEvent) => void
  }
  /** Spread on each face viewport (which also takes the face's useDroppable ref). */
  faceProps: (face: RackFace) => {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void
    onPointerMove: (event: PointerEvent<HTMLElement>) => void
    onPointerUp: (event: PointerEvent<HTMLElement>) => void
    onPointerCancel: (event: PointerEvent<HTMLElement>) => void
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void
    onPointerLeave: (event: PointerEvent<HTMLElement>) => void
    onContextMenu: (event: MouseEvent<HTMLElement>) => void
  }
  /** Spread on each placed item's <g>: focusability, role, data id and the arrow/Delete keys. */
  placementProps: (placementId: string) => {
    tabIndex: 0
    role: 'button'
    'aria-roledescription': string
    'data-placement-id': string
    onKeyDown: (event: KeyboardEvent<SVGGElement>) => void
  }
  /** "Add at U…": the same checks, commit and announcements as a drop. */
  addAt: (subject: DragSubject, face: RackFace, y: Sixths) => boolean
  /** Cancels any gesture in progress (also bound to Escape). */
  cancel: () => void
}
```

Wiring:

```tsx
<DragDropProvider sensors={RACK_DND_SENSORS} plugins={RACK_DND_PLUGINS} {...dnd.providerProps}>
  <Palette />
  {/* useDraggable({ id, type: PALETTE_TYPE, data: { itemId } }) per entry */}
  <RackFaceView face="front" {...dnd.faceProps('front')} />
  {/* viewport: useDroppable({ id: 'face:front', accept: PALETTE_TYPE, collisionDetector: pointerIntersection }) */}
  <div className="absolute">
    {/* out of flow, outside any transform */}
    <DragOverlay dropAnimation={null}>{(source) => <PaletteChip source={source} />}</DragOverlay>
  </div>
</DragDropProvider>
```

Responsibilities:

- **It owns every gesture on the faces:**
  - palette drags (through dnd-kit events);
  - placed-item moves (Pointer Events with capture on the viewport, a 4 px mouse slop, a 250 ms touch long-press, and a swipe that becomes `onPan`);
  - tap-to-place;
  - keyboard moves and deletion (↑/↓ 1U, Shift 5U, Delete);
  - Escape and `pointercancel`;
  - clearing timers on unmount.
- **Geometry is read only at event time.** It maps client points through `face.svg.getScreenCTM().inverse()` and requires the point to be inside `face.viewport`'s rect. It never caches matrices or rects across a gesture. It never uses dnd-kit shapes for the position.
  - For palette drops it uses `event.to` while moving and `event.nativeEvent` on dragend.
  - dnd-kit's `operation.target` only picks the face, with its own hit test as the fallback.
- **It delegates every rule to pure domain functions** (`snap`, `check`), so drag, tap, keyboard and "Add at U…" give identical results and messages.
- **It writes nothing until a gesture ends.** The ghost is local state, so planStore history needs no pausing. Each successful gesture makes exactly one `commit`. Blocked gestures commit nothing and announce the reason.
- **It does not own the camera.** `useRackView` owns zoom, pan, wheel and (later) pinch. `useRackDnd` only receives `onPan` and `viewKey`, and refreshes the ghost when the drawing moves under a still pointer.
- **It does not render.** Face components draw `ghost` (✓/✗, icon, reason text, hatch). The hook supplies the props for the items, the faces and the provider.
- **It announces** drop, move and removal results and blocked reasons through the app's live region. dnd-kit's Accessibility plugin stays off.
- **Configuration lives in one place.** `RACK_DND_SENSORS` and `RACK_DND_PLUGINS` are module constants: the provider re-applies them on identity change. They hold the `PointerSensor` constraints, the `Feedback` guard (`'none'` for SVG, `dropAnimation: null`), no `Accessibility` and no `KeyboardSensor`.
- **It keeps the test hooks** the E2E specs rely on: `data-u-label`, `data-placement-id` (`data-placed-id` in the spike), `data-u-start`, `data-ghost-u-start` and `data-ghost-valid`.

## Not covered and open questions

- **Only Chromium was measured.** WebKit and Firefox are not installed here, so the plan's nightly projects should run the same scenarios. Whether their `getScreenCTM()` includes CSS transforms on HTML ancestors was not checked. The viewBox camera puts no CSS transform around the SVG at all, so M3b should use it.
- **Pinch zoom** (two pointers) is not implemented; the face ignores non-primary pointers. In M3b, a second pointer must cancel a pending long-press or item drag and hand over to `useRackView`.
- **Phone layout.** At 100 % on a 412 px phone the U-label column is clipped. M3b needs a fit-to-width zoom.
- **Screen readers.** Only the live-region text was asserted. NVDA and VoiceOver were not tried.
- **Not built:** half-bay (left/right) placement (x is ignored), the rear face (a second droppable, `face:rear`), and the drop-on-empty-space mount chooser. The contract leaves room for all three: `snap` can take x, `faces` is a record, and `onDragEnd` can open the chooser instead of committing.

## Reproduce

```sh
npx vitest run src/features/dev/spike-dnd/rackModel.test.ts
npx tsx scripts/spikes/dnd-check.ts                                  # dev server on 5181, exit 1 on failure
DND_CHECK_SCREENSHOTS=<dir> npx tsx scripts/spikes/dnd-check.ts      # plus screenshots
VITE_SPIKES=1 npx vite build --outDir <tmp>/dist-spike --emptyOutDir
npx vite preview --outDir <tmp>/dist-spike --port 5184 --strictPort --host 127.0.0.1
DND_CHECK_URL=http://127.0.0.1:5184 npx tsx scripts/spikes/dnd-check.ts   # production CSP
```

## Requests for other owners

- **Dependencies (needs approval):** declare `@dnd-kit/dom@0.5.0` and `@dnd-kit/collision@0.5.0` as direct, pinned dependencies. Both are already installed at exactly that version, through `@dnd-kit/react`. The adapter imports them directly (`Feedback`, `Accessibility`, `PointerActivationConstraints`, `pointerIntersection`), and `@dnd-kit/react` does not re-export them.
- **`src/index.css` (optional):** `@layer dnd-kit, theme, base, components, utilities;` as the first line, as insurance only (see above).
- **Router:** in dev, every page load logs "No `HydrateFallback` element provided to render during initial hydration".
- **App shell:** on a 412 px wide phone the header's brand and nav wrap onto several lines.
