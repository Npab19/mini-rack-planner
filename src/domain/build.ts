/**
 * Have/Need bookkeeping (M3a): mark parts of the plan as owned ("In my rack") or still to get,
 * and "Finish build".
 *
 * - Have captures what was built in a `Snapshot` stamped `at` (an ISO date-time); Need drops it.
 *   The as-built side of the BOM comes from these snapshots (bom.ts), so later edits to the
 *   planned version never change what is already built:
 *   - section: type, height and resolved rack/section options (`markSection` in frame.ts);
 *   - cap: every frame option as it resolves for that cap (`markCap`; the wizard and the sample
 *     capture caps the same way);
 *   - placement: its item and option values (`markPlacement`; resolved against the item's options
 *     when a catalog is passed, like the sample plan);
 *   - devices in slots and tray equipment carry a plain `have` flag, extras a `haveQty`.
 * - Marking something Have again re-captures it only when what it would capture differs (another
 *   type, item or option values); otherwise nothing changes.
 * - Pure and immutable: inputs are never mutated. Unknown ids and marks that change nothing return
 *   the very same plan object, so the store records no empty undo step.
 * - Inventory is global, not part of the plan: callers consume loose spares in the same action
 *   with `consumeInventory` (bom.ts), from the BOM before and after the mark.
 */
import { markSection, placementAnchor, placementsInSection } from './frame'
import { resolveOptionValues } from './recipe'
import { withCustomEntries, type CatalogLookup, type Frame, type Item } from './schema/catalog'
import type { OptionValues } from './schema/common'
import type { CapState, PlacedDevice, Placement, Plan, Snapshot } from './schema/plan'

type Cap = 'top' | 'bottom'

const CAPS: readonly Cap[] = ['top', 'bottom']

// ---------------------------------------------------------------------------------------------
// Placements and their devices

/**
 * Have captures a snapshot {at, itemId, options} (see `placementSnapshot`); Need clears it.
 * Devices on it are untouched. Pass the catalog to capture resolved option values.
 */
export function markPlacement(
  plan: Plan,
  placementId: string,
  have: boolean,
  at: string,
  catalog?: CatalogLookup,
): Plan {
  const lookup = planLookup(plan, catalog)
  return updatePlacement(plan, placementId, (placement) =>
    placementHave(placement, have, at, lookup),
  )
}

/** Owned flag for one device entry inside a placement. */
export function markPlacementDevice(
  plan: Plan,
  placementId: string,
  deviceEntryId: string,
  have: boolean,
): Plan {
  return updatePlacement(plan, placementId, (placement) =>
    devicesHave(placement, have, (device) => device.id === deviceEntryId),
  )
}

/** Owned flag for an entry of the "Equipment to fit" tray. */
export function markEquipment(plan: Plan, equipmentId: string, have: boolean): Plan {
  const index = plan.equipment.findIndex((entry) => entry.id === equipmentId)
  const entry = plan.equipment[index]
  if (entry === undefined || entry.have === have) return plan
  return { ...plan, equipment: plan.equipment.with(index, { ...entry, have }) }
}

/**
 * What Mark as Have captures for a placement: its item and option values. With the catalog the
 * values are resolved against the item's options (defaults included); without it (or for gear
 * placed directly, which has no item) they are the values chosen on the placement.
 */
export function placementSnapshot(
  placement: Placement,
  at: string,
  catalog?: CatalogLookup,
): Snapshot {
  const item = itemOf(catalog, placement.itemId)
  const options =
    item === undefined
      ? { ...placement.options }
      : resolveOptionValues(item.options, placement.options)
  return { at, itemId: placement.itemId, options }
}

function placementHave(
  placement: Placement,
  have: boolean,
  at: string,
  catalog: CatalogLookup | undefined,
): Placement {
  if (!have) return placementWithoutHave(placement)
  const built = placement.have
  if (built !== undefined && builtAsPlanned(placement, built, itemOf(catalog, placement.itemId))) {
    return placement
  }
  return { ...placement, have: placementSnapshot(placement, at, catalog) }
}

/**
 * Whether a Have snapshot still describes the placement: same item and same option values. With
 * the item, both sides are resolved against its options, so a snapshot of raw values and one of
 * resolved values compare equal. Without it only the placement's own values are compared (a
 * snapshot may hold resolved defaults besides them).
 */
function builtAsPlanned(placement: Placement, built: Snapshot, item: Item | undefined): boolean {
  if ((built.itemId ?? placement.itemId) !== placement.itemId) return false
  if (item !== undefined) {
    return sameOptions(
      resolveOptionValues(item.options, built.options),
      resolveOptionValues(item.options, placement.options),
    )
  }
  const chosen = placement.options ?? {}
  return Object.keys(chosen).every((key) => built.options[key] === chosen[key])
}

function placementWithoutHave(placement: Placement): Placement {
  if (placement.have === undefined) return placement
  const copy = { ...placement }
  delete copy.have
  return copy
}

/** Sets `have` on the devices `which` picks (all by default); the same placement if none change. */
function devicesHave(
  placement: Placement,
  have: boolean,
  which: (device: PlacedDevice) => boolean = () => true,
): Placement {
  const devices = mapSame(placement.devices, (device) =>
    device.have === have || !which(device) ? device : { ...device, have },
  )
  return devices === placement.devices ? placement : { ...placement, devices }
}

/** Replaces one placement; the same plan when it is missing or `update` changes nothing. */
function updatePlacement(
  plan: Plan,
  placementId: string,
  update: (placement: Placement) => Placement,
): Plan {
  const index = plan.placements.findIndex((placement) => placement.id === placementId)
  const placement = plan.placements[index]
  if (placement === undefined) return plan
  const updated = update(placement)
  return updated === placement
    ? plan
    : { ...plan, placements: plan.placements.with(index, updated) }
}

// ---------------------------------------------------------------------------------------------
// Caps and extras

/**
 * What Mark as Have captures for a cap: every frame option as it resolves for that cap now
 * (default, then the rack's value, then the cap's own), as the wizard and the sample capture it.
 */
export function capSnapshot(plan: Plan, frame: Frame, cap: Cap, at: string): Snapshot {
  return {
    at,
    options: resolveOptionValues(frame.options, plan.frame.options, plan.frame.caps[cap].options),
  }
}

/** Top/bottom assembly (once-per-rack parts). Have captures the cap's resolved options. */
export function markCap(plan: Plan, frame: Frame, cap: Cap, have: boolean, at: string): Plan {
  if (cap !== 'top' && cap !== 'bottom') return plan
  const state = plan.frame.caps[cap]
  const updated = have ? capWithHave(plan, frame, cap, at) : capWithoutHave(state)
  if (updated === state) return plan
  const caps =
    cap === 'top' ? { ...plan.frame.caps, top: updated } : { ...plan.frame.caps, bottom: updated }
  return { ...plan, frame: { ...plan.frame, caps } }
}

function capWithHave(plan: Plan, frame: Frame, cap: Cap, at: string): CapState {
  const state = plan.frame.caps[cap]
  const snapshot = capSnapshot(plan, frame, cap, at)
  if (state.have !== undefined && sameOptions(state.have.options, snapshot.options)) return state
  return { ...state, have: snapshot }
}

function capWithoutHave(state: CapState): CapState {
  if (state.have === undefined) return state
  const copy = { ...state }
  delete copy.have
  return copy
}

/**
 * How many of an extra the user owns, clamped to 0..qty and rounded down (a part is owned only
 * when it is complete). NaN leaves the plan as it is.
 */
export function markExtra(plan: Plan, extraId: string, haveQty: number): Plan {
  if (Number.isNaN(haveQty)) return plan
  const index = plan.extras.findIndex((extra) => extra.id === extraId)
  const extra = plan.extras[index]
  if (extra === undefined) return plan
  const owned = Math.min(extra.qty, Math.max(0, Math.floor(haveQty)))
  if (owned === extra.haveQty) return plan
  return { ...plan, extras: plan.extras.with(index, { ...extra, haveQty: owned }) }
}

// ---------------------------------------------------------------------------------------------
// Sections

/**
 * Placements anchored in a section: their bottom edge sits on it (`placementAnchor`) and they are
 * at least partly mounted on it (`placementsInSection`). Every placement inside the rack belongs to
 * exactly one section this way; one entirely outside the stack belongs to none. Heights come from
 * the catalog when given, else from the placements' stored copies.
 */
export function placementsAnchoredIn(
  plan: Plan,
  frame: Frame,
  sectionId: string,
  catalog?: CatalogLookup,
): Placement[] {
  return placementsInSection(plan, frame, sectionId, catalog).filter(
    (placement) => placementAnchor(plan, frame, placement)?.sectionId === sectionId,
  )
}

/**
 * "Mark everything in this section as Have / Need": the section (`markSection`), every placement
 * anchored in it (`placementsAnchoredIn`) and every device on those placements.
 *
 * Caps: when marking Have while neither cap has a snapshot yet, both caps are marked Have too. A
 * rack physically has its top and bottom as soon as any section of it is built, and the first
 * section the user records would otherwise leave the once-per-rack cap parts on the shopping list.
 * Once either cap has a snapshot (the user set them on purpose) they are left alone, and marking
 * Need never touches them.
 *
 * Unknown section ids, or a section type the frame does not have, leave the plan as it is. Pass
 * the catalog for exact placement heights and resolved placement options.
 */
export function markSectionContents(
  plan: Plan,
  frame: Frame,
  sectionId: string,
  have: boolean,
  at: string,
  catalog?: CatalogLookup,
): Plan {
  const marked = markSection(plan, sectionId, have, at, frame)
  if (marked.error !== undefined) return plan
  const lookup = planLookup(plan, catalog)
  const anchored = new Set(
    placementsAnchoredIn(plan, frame, sectionId, lookup).map((placement) => placement.id),
  )
  let next = marked.plan
  if (anchored.size > 0) {
    const placements = mapSame(next.placements, (placement) =>
      anchored.has(placement.id)
        ? devicesHave(placementHave(placement, have, at, lookup), have)
        : placement,
    )
    if (placements !== next.placements) next = { ...next, placements }
  }
  const { top, bottom } = next.frame.caps
  if (have && top.have === undefined && bottom.have === undefined) {
    for (const cap of CAPS) next = markCap(next, frame, cap, true, at)
  }
  return next
}

// ---------------------------------------------------------------------------------------------
// Finish build

export interface FinishBuildResult {
  plan: Plan
  /** How many sections, caps, placements, devices, equipment entries and extras changed. */
  changed: number
}

/**
 * "Finish build": everything still Need becomes Have, with snapshots stamped `at`:
 * - sections bottom -> top via `markSection` (a section of a type the frame does not have stays
 *   as it is);
 * - both caps, when the stack has at least one section (an empty stack has no caps to own);
 * - placements (`markPlacement`, resolved with `catalog` when given), the devices in them and the
 *   "Equipment to fit" entries;
 * - extras get haveQty = qty (owning more than that is kept).
 * What is already Have but planned differently since (another type, item or option values) is
 * re-captured as planned, so the shopping list is empty afterwards. `changed` counts every
 * section, cap, placement, device, equipment entry and extra that changed; 0 returns the same
 * plan object.
 */
export function finishBuild(
  plan: Plan,
  frame: Frame,
  at: string,
  catalog?: CatalogLookup,
): FinishBuildResult {
  const lookup = planLookup(plan, catalog)
  let next = plan
  let changed = 0
  for (const section of plan.frame.sections) {
    const result = markSection(next, section.id, true, at, frame)
    if (result.error === undefined && result.plan !== next) {
      next = result.plan
      changed += 1
    }
  }
  if (next.frame.sections.length > 0) {
    for (const cap of CAPS) {
      const marked = markCap(next, frame, cap, true, at)
      if (marked !== next) {
        next = marked
        changed += 1
      }
    }
  }
  const placements = mapSame(next.placements, (placement) => {
    const owned = placementHave(placement, true, at, lookup)
    const withDevices = devicesHave(owned, true)
    changed += (owned === placement ? 0 : 1) + countChanged(owned.devices, withDevices.devices)
    return withDevices
  })
  const equipment = mapSame(next.equipment, (entry) => {
    if (entry.have) return entry
    changed += 1
    return { ...entry, have: true }
  })
  const extras = mapSame(next.extras, (extra) => {
    if (extra.haveQty >= extra.qty) return extra
    changed += 1
    return { ...extra, haveQty: extra.qty }
  })
  if (changed === 0) return { plan, changed }
  return { plan: { ...next, placements, equipment, extras }, changed }
}

// ---------------------------------------------------------------------------------------------
// Helpers

function planLookup(plan: Plan, catalog: CatalogLookup | undefined): CatalogLookup | undefined {
  return catalog === undefined ? undefined : withCustomEntries(catalog, plan.custom)
}

/** The catalog item a placement holds (undefined without a catalog, for gear and unknown ids). */
function itemOf(catalog: CatalogLookup | undefined, itemId: string): Item | undefined {
  const item = catalog?.item(itemId)
  return item?.kind === 'item' ? item : undefined
}

/** Equal option values (a key missing on one side differs from any value on the other). */
function sameOptions(a: Readonly<OptionValues>, b: Readonly<OptionValues>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

/** `items.map(update)`, or `items` itself when no element changed (keeps references stable). */
function mapSame<T>(items: T[], update: (item: T) => T): T[] {
  let changed = false
  const mapped = items.map((item) => {
    const updated = update(item)
    if (updated !== item) changed = true
    return updated
  })
  return changed ? mapped : items
}

function countChanged<T>(before: readonly T[], after: readonly T[]): number {
  return after.filter((item, index) => item !== before[index]).length
}
