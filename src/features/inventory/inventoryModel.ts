/**
 * What the On hand page shows, as plain functions of the catalog, the inventory (what is on hand,
 * by BOM line key) and the saved plans' bills of materials:
 * - every hardware part, grouped by category, with what you have of it and of each cut length;
 * - the other things on hand (printed parts, equipment, power bricks), named like the BOM names
 *   them;
 * - totals, search, and what each saved plan still needs of a part and buys after what is on hand.
 * The page only lays these out.
 */
import { tokenize } from '@/catalog/search'
import type { BomLine, BomResult, BomUnit } from '@/domain/api'
import { hardwareKey, parseLineKey } from '@/domain/ids'
import {
  deviceName,
  type CatalogLookup,
  type Hardware,
  type HardwareCategory,
} from '@/domain/schema/catalog'
import { isCustomId } from '@/domain/schema/common'
import type { Inventory } from '@/domain/schema/settings'

/** Hardware categories in the order the page lists them, with their headings. */
export const HARDWARE_GROUPS: ReadonlyArray<{ id: HardwareCategory; title: string }> = [
  { id: 'screw', title: 'Screws' },
  { id: 'nut', title: 'Nuts' },
  { id: 'insert', title: 'Heat-set inserts' },
  { id: 'cage-nut', title: 'Cage nuts' },
  { id: 't-nut', title: 'T-nuts' },
  { id: 'washer', title: 'Washers' },
  { id: 'magnet', title: 'Magnets' },
  { id: 'foot', title: 'Feet' },
  { id: 'standoff', title: 'Standoffs' },
  { id: 'extrusion', title: 'Extrusion' },
  { id: 'cable-tie', title: 'Cable ties' },
  { id: 'other', title: 'Other hardware' },
]

const GROUP_IDS = new Set<string>(HARDWARE_GROUPS.map((group) => group.id))

function groupIdOf(category: string | undefined): HardwareCategory {
  return category !== undefined && GROUP_IDS.has(category)
    ? (category as HardwareCategory)
    : 'other'
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

/** "1,200" in the user's locale. */
export function formatCount(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)
}

// ---------------------------------------------------------------------------------------------
// Saved plans

/** What one saved plan still needs of a line (before what is on hand) and what it buys. */
export interface PlanNeed {
  planId: string
  planName: string
  /** To install plus the spare % of hardware: the plan's "To get", before what is on hand. */
  toGet: number
  /** What the plan's shopping list buys after what is on hand, rounded up to packs. */
  buy: number
}

/** How the BOM names a line, for keys the catalog alone cannot name (a plan's own parts). */
export interface LineInfo {
  label: string
  kind: BomLine['kind']
  unit: BomUnit
  category?: string
}

export interface PlanBom {
  planId: string
  planName: string
  bom: BomResult
}

export interface PlanNeeds {
  /** Line key -> what each plan needs of it, in the order the plans were given. */
  byKey: ReadonlyMap<string, readonly PlanNeed[]>
  /** Line key -> how the plans' BOMs name it. */
  lines: ReadonlyMap<string, LineInfo>
}

/** What every plan's shopping list still needs per line (lines it fully owns are left out). */
export function planNeedsFrom(boms: readonly PlanBom[]): PlanNeeds {
  const byKey = new Map<string, PlanNeed[]>()
  const lines = new Map<string, LineInfo>()
  for (const { planId, planName, bom } of boms) {
    for (const line of bom.lines) {
      if (!lines.has(line.key)) {
        lines.set(line.key, {
          label: line.label,
          kind: line.kind,
          unit: line.unit,
          ...(line.category === undefined ? {} : { category: line.category }),
        })
      }
      const toGet = line.install + line.spare
      if (line.included === true || toGet <= 0) continue
      const needs = byKey.get(line.key) ?? []
      needs.push({ planId, planName, toGet, buy: line.buy })
      byKey.set(line.key, needs)
    }
  }
  return { byKey, lines }
}

export const NO_PLAN_NEEDS: PlanNeeds = { byKey: new Map(), lines: new Map() }

// ---------------------------------------------------------------------------------------------
// Naming any line key

export type OnHandKind = 'hardware' | 'print' | 'device' | 'brick' | 'unknown'

export interface KeyInfo {
  kind: OnHandKind
  label: string
  unit: BomUnit
  category?: string
}

/** "2020 aluminium extrusion (…), cut to 133.35 mm", like the BOM's cut-to-length lines. */
export function cutLabel(name: string, cutLengthMm: number): string {
  return `${name}, cut to ${cutLengthMm} mm`
}

function hardwareInfo(hardwareId: string, cutLengthMm: number | undefined, catalog: CatalogLookup) {
  const hardware = catalog.hardware(hardwareId)
  const name = hardware?.name ?? hardwareId
  return {
    label: cutLengthMm === undefined ? name : cutLabel(name, cutLengthMm),
    unit: cutLengthMm === undefined && hardware?.unit === 'mm' ? ('mm' as const) : ('pcs' as const),
    category: hardware?.category,
    known: hardware !== undefined,
  }
}

/**
 * How the BOM names the line behind an inventory key: hardware by name (and cut length), a print
 * by its print group ("Lenovo Tiny mount 1U: Mount" for an item's own prints), a device by brand
 * and model, a power brick by the device it powers. Unknown ids fall back to the plans' names,
 * then to the id itself.
 */
export function keyInfo(key: string, catalog: CatalogLookup, lines?: PlanNeeds['lines']): KeyInfo {
  const parsed = parseLineKey(key)
  const fromPlans = lines?.get(key)
  switch (parsed?.kind) {
    case 'hardware': {
      const info = hardwareInfo(parsed.hardwareId, parsed.cutLengthMm, catalog)
      if (!info.known && fromPlans !== undefined) return { ...fromPlans, kind: 'hardware' }
      return {
        kind: 'hardware',
        label: info.label,
        unit: info.unit,
        ...(info.category === undefined ? {} : { category: info.category }),
      }
    }
    case 'print': {
      const owner = catalog.frame(parsed.ownerId) ?? catalog.item(parsed.ownerId)
      const group = owner?.prints.find((print) => print.id === parsed.printId)
      if (group === undefined && fromPlans !== undefined) {
        return { kind: 'print', label: fromPlans.label, unit: 'plates' }
      }
      const base = group?.label ?? parsed.printId
      const isItem = owner !== undefined && owner.kind !== 'frame'
      const label =
        owner === undefined
          ? `${parsed.ownerId}: ${base}`
          : isItem && owner.name !== base
            ? `${owner.name}: ${base}`
            : base
      return { kind: 'print', label, unit: 'plates' }
    }
    case 'device': {
      const brick = parsed.deviceId.endsWith('/brick')
      const deviceId = brick ? parsed.deviceId.slice(0, -'/brick'.length) : parsed.deviceId
      const device = catalog.device(deviceId)
      if (device === undefined && fromPlans !== undefined) {
        return { kind: brick ? 'brick' : 'device', label: fromPlans.label, unit: 'pcs' }
      }
      const name = device === undefined ? deviceId : deviceName(device)
      return brick
        ? { kind: 'brick', label: `Power brick for ${name}`, unit: 'pcs' }
        : { kind: 'device', label: name, unit: 'pcs' }
    }
    default:
      return { kind: 'unknown', label: fromPlans?.label ?? key, unit: fromPlans?.unit ?? 'pcs' }
  }
}

/** "1 plate", "20 pcs", "1200 mm". */
export function quantityWithUnit(qty: number, unit: BomUnit, locale?: string): string {
  const count = formatCount(qty, locale)
  if (unit === 'plates') return `${count} ${qty === 1 ? 'plate' : 'plates'}`
  return `${count} ${unit}`
}

// ---------------------------------------------------------------------------------------------
// Hardware rows

export interface HardwareRow {
  /** The inventory key (`hw:<id>` or `hw:<id>@<cut length>`). */
  key: string
  hardwareId: string
  label: string
  /** pcs, or mm for stock sold by length (cut pieces are pcs). */
  unit: 'pcs' | 'mm'
  qty: number
  group: HardwareCategory
  cutLengthMm?: number
  /** One line under the name: packs, or what kind of stock it is. */
  details: string
  /** One of the user's own parts (My parts). */
  custom: boolean
  /** Not in the catalog or My parts (an old id, or a part only a plan carries). */
  unknown: boolean
  plans: readonly PlanNeed[]
  /** Words the search matches against (name, aliases, category, id, cut length). */
  tokens: readonly string[]
}

export interface HardwareGroup {
  id: HardwareCategory
  title: string
  rows: HardwareRow[]
}

/** Words plus their letter and digit runs, so "m5x8x7" is found by "m5" and "8". */
function searchTokens(texts: readonly string[]): string[] {
  const words = texts.flatMap((text) => tokenize(text))
  const parts = words.flatMap((word) => word.match(/\p{L}+|\p{N}+/gu) ?? [])
  return [...new Set([...words, ...parts])]
}

function packText(packSizes: readonly number[] | undefined, locale?: string): string | undefined {
  const sizes = [...new Set(packSizes ?? [])].toSorted((a, b) => a - b)
  if (sizes.length === 0) return undefined
  const list = new Intl.ListFormat(locale ?? 'en', { type: 'disjunction' }).format(
    sizes.map((size) => formatCount(size, locale)),
  )
  return `Packs of ${list}`
}

function rowDetails(
  hardware: Hardware | undefined,
  cutLengthMm: number | undefined,
  locale?: string,
): string {
  if (hardware === undefined) return 'Not in the catalog'
  if (cutLengthMm !== undefined) return 'Cut pieces, counted one by one'
  if (hardware.unit === 'mm') return 'Uncut stock, by length'
  return packText(hardware.packSizes, locale) ?? 'Sold one by one'
}

function titleOf(group: HardwareCategory): string {
  return HARDWARE_GROUPS.find((entry) => entry.id === group)?.title ?? 'Other hardware'
}

export interface HardwareGroupsInput {
  /** Every hardware part the app knows: the catalog and My parts. */
  hardware: readonly Hardware[]
  inventory: Inventory
  needs: PlanNeeds
  locale?: string
}

/**
 * Every hardware part as a row (one per cut length on hand or needed by a plan, too), plus rows
 * for hardware keys on hand or needed that no catalog entry describes. Groups follow
 * `HARDWARE_GROUPS`; rows go by name (numbers in order: M3×6 before M3×10), cut lengths after
 * their stock. Empty groups are left out.
 */
export function hardwareGroups(input: HardwareGroupsInput): HardwareGroup[] {
  const { inventory, needs, locale } = input
  const byId = new Map(input.hardware.map((hardware) => [hardware.id, hardware]))
  const keys = new Set(input.hardware.map((hardware) => hardwareKey(hardware.id)))
  for (const key of [...Object.keys(inventory), ...needs.byKey.keys()]) {
    if (parseLineKey(key)?.kind === 'hardware') keys.add(key)
  }

  const rows: Array<HardwareRow & { sortName: string }> = []
  for (const key of keys) {
    const parsed = parseLineKey(key)
    if (parsed?.kind !== 'hardware') continue
    const hardware = byId.get(parsed.hardwareId)
    const fromPlans = needs.lines.get(key)
    const name = hardware?.name ?? fromPlans?.label ?? parsed.hardwareId
    const cut = parsed.cutLengthMm
    const label = hardware !== undefined && cut !== undefined ? cutLabel(name, cut) : name
    const unit: 'pcs' | 'mm' =
      cut === undefined && (hardware?.unit ?? fromPlans?.unit) === 'mm' ? 'mm' : 'pcs'
    const group = groupIdOf(hardware?.category ?? fromPlans?.category)
    rows.push({
      key,
      hardwareId: parsed.hardwareId,
      label,
      unit,
      qty: inventory[key] ?? 0,
      group,
      ...(cut === undefined ? {} : { cutLengthMm: cut }),
      details: rowDetails(hardware, cut, locale),
      custom: isCustomId(parsed.hardwareId),
      unknown: hardware === undefined,
      plans: needs.byKey.get(key) ?? [],
      tokens: searchTokens([
        label,
        ...(hardware?.aliases ?? []),
        titleOf(group),
        group,
        parsed.hardwareId,
      ]),
      sortName: hardware?.name ?? name,
    })
  }

  return HARDWARE_GROUPS.map(({ id, title }) => ({
    id,
    title,
    rows: rows
      .filter((row) => row.group === id)
      .toSorted(
        (a, b) =>
          collator.compare(a.sortName, b.sortName) ||
          (a.cutLengthMm ?? -1) - (b.cutLengthMm ?? -1) ||
          collator.compare(a.key, b.key),
      )
      .map(({ sortName: _sortName, ...row }) => row),
  })).filter((group) => group.rows.length > 0)
}

/** Every query word starts one of the row's words. An empty query matches everything. */
export function matchesQuery(tokens: readonly string[], query: string): boolean {
  return tokenize(query).every((word) => tokens.some((token) => token.startsWith(word)))
}

export interface RowFilter {
  query: string
  /** Only rows with something on hand (plus `keep`). */
  onlyOnHand: boolean
  /** Keys that stay listed even at 0: rows changed since the filter was set, so they never jump away. */
  keep?: ReadonlySet<string>
}

export function filterGroups(groups: readonly HardwareGroup[], filter: RowFilter): HardwareGroup[] {
  return groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter(
        (row) =>
          (!filter.onlyOnHand || row.qty > 0 || (filter.keep?.has(row.key) ?? false)) &&
          matchesQuery(row.tokens, filter.query),
      ),
    }))
    .filter((group) => group.rows.length > 0)
}

export function rowCount(groups: readonly HardwareGroup[]): number {
  return groups.reduce((total, group) => total + group.rows.length, 0)
}

// ---------------------------------------------------------------------------------------------
// Totals

export interface OnHandTotals {
  /** Hardware keys with something on hand. */
  kinds: number
  /** Pieces of hardware counted one by one (cut pieces included). */
  pieces: number
  /** Uncut stock sold by length, in mm. */
  mm: number
  /** Printed parts, equipment and power bricks on hand (keys). */
  other: number
}

export function onHandTotals(inventory: Inventory, catalog: CatalogLookup): OnHandTotals {
  const totals: OnHandTotals = { kinds: 0, pieces: 0, mm: 0, other: 0 }
  for (const [key, qty] of Object.entries(inventory)) {
    if (!(qty > 0)) continue
    const parsed = parseLineKey(key)
    if (parsed?.kind !== 'hardware') {
      totals.other += 1
      continue
    }
    totals.kinds += 1
    const stock =
      parsed.cutLengthMm === undefined && catalog.hardware(parsed.hardwareId)?.unit === 'mm'
    if (stock) totals.mm += qty
    else totals.pieces += qty
  }
  return totals
}

/** "12 kinds, 340 pieces", plus ", 1,200 mm of stock" when there is uncut stock. */
export function totalsText(totals: OnHandTotals, locale?: string): string {
  const parts = [
    plural(totals.kinds, 'kind'),
    `${formatCount(totals.pieces, locale)} ${totals.pieces === 1 ? 'piece' : 'pieces'}`,
  ]
  if (totals.mm > 0) parts.push(`${formatCount(totals.mm, locale)} mm of stock`)
  return parts.join(', ')
}

// ---------------------------------------------------------------------------------------------
// Other things on hand

export interface OtherRow {
  key: string
  kind: Exclude<OnHandKind, 'hardware'>
  /** "Printed part", "Equipment", "Power brick", "Other". */
  kindLabel: string
  label: string
  unit: BomUnit
  qty: number
}

const KIND_LABELS: Record<OtherRow['kind'], string> = {
  print: 'Printed part',
  device: 'Equipment',
  brick: 'Power brick',
  unknown: 'Other',
}

const KIND_ORDER: Record<OtherRow['kind'], number> = { print: 0, device: 1, brick: 2, unknown: 3 }

/**
 * Printed parts, equipment and power bricks on hand (anything that is not hardware), plus the
 * keys in `keep` (changed on this visit, so a row set to 0 stays until the user leaves). Grouped
 * by kind, then by name.
 */
export function otherRows(
  inventory: Inventory,
  catalog: CatalogLookup,
  lines?: PlanNeeds['lines'],
  keep: ReadonlySet<string> = new Set(),
): OtherRow[] {
  const keys = new Set([
    ...Object.keys(inventory).filter((key) => (inventory[key] ?? 0) > 0),
    ...[...keep].filter((key) => parseLineKey(key)?.kind !== 'hardware'),
  ])
  const rows: OtherRow[] = []
  for (const key of keys) {
    const info = keyInfo(key, catalog, lines)
    if (info.kind === 'hardware') continue
    rows.push({
      key,
      kind: info.kind,
      kindLabel: KIND_LABELS[info.kind],
      label: info.label,
      unit: info.unit,
      qty: inventory[key] ?? 0,
    })
  }
  return rows.toSorted(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      collator.compare(a.label, b.label) ||
      collator.compare(a.key, b.key),
  )
}
