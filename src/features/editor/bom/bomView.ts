/**
 * What the BOM drawer shows, as plain functions of the BOM result: which lines each tab lists,
 * the "Got it" rule, quantities and packs as text, the header summary, what Finish build changes
 * and the CSV file name. The drawer component only lays these out.
 */
import type { BomLine, BomLineKind, BomResult } from '@/domain/api'
import {
  packRound,
  placementLabel,
  resolvePlacedEntry,
  surplusLines,
  type PackCount,
} from '@/domain/bom'
import { parseLineKey } from '@/domain/ids'
import { sectionHeightU, sectionLabel } from '@/domain/recipe'
import { deviceName, type CatalogLookup, type Frame } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import type { Settings } from '@/domain/schema/settings'
import { formatPrintTime, type BomCsvMode } from '@/lib/csv'
import { localDateStamp } from '@/lib/date'
import { slugify } from '@/features/plans/format'

export type BomTab = 'shopping' | 'full' | 'leftovers'
export const BOM_TABS: readonly BomTab[] = ['shopping', 'full', 'leftovers']

export function isBomTab(value: unknown): value is BomTab {
  return typeof value === 'string' && (BOM_TABS as readonly string[]).includes(value)
}

export const KIND_ORDER: readonly BomLineKind[] = ['print', 'hardware', 'device']

export const GROUP_TITLES: Record<BomTab, Record<BomLineKind, string>> = {
  shopping: { print: 'Prints to make', hardware: 'Hardware to buy', device: 'Equipment' },
  full: { print: 'Printed parts', hardware: 'Hardware', device: 'Equipment' },
  leftovers: { print: 'Printed parts', hardware: 'Hardware', device: 'Equipment' },
}

/** Finish build turns To get into In my rack, so its buttons wear the solid In my rack colour. */
export const FINISH_BUILD_CLASSES =
  'bg-have text-have-foreground hover:bg-have/85 focus-visible:border-have-border focus-visible:ring-have/40'

// ---------------------------------------------------------------------------------------------
// Lines per tab

/**
 * "Got it": spares already cover what this line still needs. `need` is 0 while there is
 * something to install only when the inventory covers it (install + spare − inventory ≤ 0).
 */
export function isGotIt(line: BomLine): boolean {
  return line.included !== true && line.install > 0 && line.need === 0
}

/** The shopping list: what to buy, plus the lines ticked as Got it (so they can be unticked). */
export function shoppingRows(result: BomResult): BomLine[] {
  return result.lines.filter((line) => line.included !== true && (line.buy > 0 || isGotIt(line)))
}

/** Lines with something to buy: the "To get: N lines" count. */
export function toGetCount(result: BomResult): number {
  return result.lines.filter((line) => line.included !== true && line.buy > 0).length
}

export function linesForTab(result: BomResult, tab: BomTab): BomLine[] {
  switch (tab) {
    case 'shopping':
      return shoppingRows(result)
    case 'full':
      return result.lines
    case 'leftovers':
      return surplusLines(result)
  }
}

export interface LineGroup {
  kind: BomLineKind
  lines: BomLine[]
}

/** Prints, hardware, equipment (empty groups left out); the BOM's own order within each. */
export function groupByKind(lines: readonly BomLine[]): LineGroup[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    lines: lines.filter((line) => line.kind === kind),
  })).filter((group) => group.lines.length > 0)
}

// ---------------------------------------------------------------------------------------------
// Got it

/** Ticking adds what is still missing, so the spares then hold install + spare. */
export function gotItAddQty(line: BomLine): number {
  return Math.max(0, line.need)
}

/** Unticking takes back at most what ticking put in (install + spare). */
export function gotItRemoveQty(line: BomLine, inventoryQty: number): number {
  return Math.max(0, Math.min(inventoryQty, line.install + line.spare))
}

// ---------------------------------------------------------------------------------------------
// Quantities as text

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

/** "1 pack of 50", "2 packs of 50 + 1 pack of 25". */
export function formatPacks(packs: readonly PackCount[]): string {
  return packs.map((pack) => `${plural(pack.count, 'pack')} of ${pack.size}`).join(' + ')
}

/**
 * The designer's plate name for a print line ("[Optional] - Magnetic frame - 3U"), the name to look
 * for in the slicer; undefined when it is the same as the line's label or unknown.
 */
export function printPlate(line: BomLine, catalog: CatalogLookup): string | undefined {
  if (line.kind !== 'print') return undefined
  const parsed = parseLineKey(line.key)
  if (parsed?.kind !== 'print') return undefined
  const owner = catalog.frame(parsed.ownerId) ?? catalog.item(parsed.ownerId)
  const plate = owner?.prints.find((print) => print.id === parsed.printId)?.plate
  return plate === undefined || line.label.endsWith(plate) ? undefined : plate
}

/** The packs `computeBom` rounded a hardware line's need to (none for cut pieces or no packs). */
export function linePacks(line: BomLine, catalog: CatalogLookup, settings: Settings): PackCount[] {
  if (line.kind !== 'hardware' || line.cutLengthMm !== undefined || line.need <= 0) return []
  const rounded = packRound(
    line.need,
    catalog.hardware(line.refId)?.packSizes,
    settings.packPrices[line.refId],
  )
  // Only describe packs that add up to what the BOM says to buy.
  return rounded.buy === line.buy ? rounded.packs : []
}

/** "50 (1 pack of 50)", or just the number without packs. */
export function buyText(line: BomLine, packs: readonly PackCount[]): string {
  return packs.length === 0 ? String(line.buy) : `${line.buy} (${formatPacks(packs)})`
}

/** What the build needs, spares apart so the designer's numbers stay visible: "36 + 4 spare". */
export function neededText(line: BomLine): string {
  return line.spare > 0 ? `${line.install} + ${line.spare} spare` : String(line.install)
}

/** "1 plate", "2 plates", "36 pcs", "1200 mm". */
export function quantityText(count: number, unit: BomLine['unit']): string {
  if (unit === 'plates') return plural(count, 'plate')
  return unit === 'mm' ? `${count} mm` : `${count} pcs`
}

export function formatGrams(grams: number, locale?: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(grams))} g`
}

/** "8 h 48 min", "45 min" (also "0 min", unlike the CSV's empty cell). */
export function formatDuration(minutes: number): string {
  return formatPrintTime(minutes) || '0 min'
}

/** "8.8 h", "12 h": one decimal below ten hours. */
export function formatHours(minutes: number, locale?: string): string {
  const hours = minutes / 60
  const digits = hours < 10 ? 1 : 0
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(hours)} h`
}

/** "$42.10" in the user's currency; whole units from 100 up. Falls back for unknown codes. */
export function formatCost(value: number, currency: string, locale?: string): string {
  try {
    const whole = value >= 100 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}
    return new Intl.NumberFormat(locale, { style: 'currency', currency, ...whole }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency}`
  }
}

export interface BomSummary {
  /** Lines with something to buy. */
  lines: number
  /** Formatted, approximate; absent when no price is known. */
  cost?: string
  grams: number
  minutes: number
}

export function bomSummary(result: BomResult, settings: Settings, locale?: string): BomSummary {
  const grams = Object.values(result.totals.needGramsByMaterial).reduce((sum, g) => sum + g, 0)
  const { cost } = result.totals
  return {
    lines: toGetCount(result),
    ...(cost !== undefined && cost > 0
      ? { cost: formatCost(cost, settings.currency, locale) }
      : {}),
    grams,
    minutes: result.totals.needMinutes,
  }
}

/** "To get: 7 lines · ~$4.71 · 282 g · 11.8 h", or "Nothing to get". */
export function summaryText(summary: BomSummary, locale?: string): string {
  if (summary.lines === 0) return 'Nothing to get'
  const parts = [`To get: ${plural(summary.lines, 'line')}`]
  if (summary.cost !== undefined) parts.push(`~${summary.cost}`)
  if (summary.grams > 0) parts.push(formatGrams(summary.grams, locale))
  if (summary.minutes > 0) parts.push(formatHours(summary.minutes, locale))
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------------------------
// Provenance

export interface ProvenanceView {
  planned: Array<{ label: string; qty: number; detail?: string }>
  owned: Array<{ label: string; qty: number; detail?: string }>
  notes: Array<{ label: string; detail?: string }>
}

const OWNED_PREFIX = 'Owned: '

/** Provenance split into what the plan uses, what is in the rack, and notes (no quantity). */
export function provenanceView(line: BomLine): ProvenanceView {
  const view: ProvenanceView = { planned: [], owned: [], notes: [] }
  for (const entry of line.provenance) {
    const detail = entry.detail
    if (entry.qty === 0) {
      view.notes.push({ label: entry.label, ...(detail ? { detail } : {}) })
    } else if (detail?.startsWith(OWNED_PREFIX)) {
      const rest = detail.slice(OWNED_PREFIX.length)
      view.owned.push({ label: entry.label, qty: entry.qty, ...(rest ? { detail: rest } : {}) })
    } else {
      view.planned.push({ label: entry.label, qty: entry.qty, ...(detail ? { detail } : {}) })
    }
  }
  return view
}

// ---------------------------------------------------------------------------------------------
// Finish build

export type PendingGroupId = 'sections' | 'caps' | 'placements' | 'devices' | 'equipment' | 'extras'

export interface PendingItem {
  label: string
  /** Already owned, but planned differently since: Finish build captures it as planned. */
  rebuilt: boolean
}

export interface PendingGroup {
  id: PendingGroupId
  title: string
  items: PendingItem[]
}

/**
 * What Finish build changes, read from the plan before and after `finishBuild`: it keeps every
 * object it leaves alone, so a new object is a change. Things To get become In my rack; owned
 * things planned differently since are re-captured as planned ("rebuilt"). Grouped for the dialog;
 * the item count equals `finishBuild`'s `changed`.
 */
export function finishBuildChanges(
  before: Plan,
  after: Plan,
  frame: Frame | undefined,
  catalog: CatalogLookup,
): PendingGroup[] {
  const afterSections = new Map(after.frame.sections.map((section) => [section.id, section]))
  const sections = before.frame.sections.flatMap((section, index): PendingItem[] => {
    if (afterSections.get(section.id) === section) return []
    const heightU = sectionHeightU(frame, section.typeId, section.heightU)
    return [{ label: sectionLabel(index, heightU), rebuilt: section.have !== undefined }]
  })
  const caps = (['bottom', 'top'] as const).flatMap((cap): PendingItem[] => {
    const state = before.frame.caps[cap]
    if (after.frame.caps[cap] === state) return []
    return [{ label: cap === 'top' ? 'Top' : 'Bottom', rebuilt: state.have !== undefined }]
  })
  const afterPlacements = new Map(after.placements.map((placement) => [placement.id, placement]))
  const placements: PendingItem[] = []
  const devices: PendingItem[] = []
  for (const placement of before.placements) {
    const next = afterPlacements.get(placement.id)
    if (next === undefined || next === placement) continue
    const label = placementLabel(placement, resolvePlacedEntry(catalog, placement.itemId))
    if (next.have !== placement.have) {
      placements.push({ label, rebuilt: placement.have !== undefined })
    }
    const nextDevices = new Map(next.devices.map((device) => [device.id, device]))
    for (const placed of placement.devices) {
      const changed = nextDevices.get(placed.id)
      if (changed === undefined || changed === placed) continue
      const device = catalog.device(placed.deviceId)
      devices.push({
        label: `${device ? deviceName(device) : placed.deviceId} in ${label}`,
        rebuilt: placed.have,
      })
    }
  }
  const afterEquipment = new Map(after.equipment.map((entry) => [entry.id, entry]))
  const equipment = before.equipment.flatMap((entry): PendingItem[] => {
    const next = afterEquipment.get(entry.id)
    if (next === undefined || next === entry) return []
    const device = catalog.device(entry.deviceId)
    return [{ label: device ? deviceName(device) : entry.deviceId, rebuilt: entry.have }]
  })
  const afterExtras = new Map(after.extras.map((extra) => [extra.id, extra]))
  const extras = before.extras.flatMap((extra): PendingItem[] => {
    const next = afterExtras.get(extra.id)
    if (next === undefined || next === extra) return []
    const name = catalog.item(extra.itemId)?.name ?? extra.itemId
    const more = next.haveQty - extra.haveQty
    return [{ label: more > 0 ? `${name} × ${more}` : name, rebuilt: false }]
  })
  const groups: PendingGroup[] = [
    { id: 'sections', title: 'Sections', items: sections },
    { id: 'caps', title: 'Top and bottom', items: caps },
    { id: 'placements', title: 'Mounts and panels', items: placements },
    { id: 'devices', title: 'Devices in mounts', items: devices },
    { id: 'equipment', title: 'Equipment to fit', items: equipment },
    { id: 'extras', title: 'Extras', items: extras },
  ]
  return groups.filter((group) => group.items.length > 0)
}

export function pendingCount(groups: readonly PendingGroup[]): number {
  return groups.reduce((total, group) => total + group.items.length, 0)
}

// ---------------------------------------------------------------------------------------------
// Export

/** "garage-rack-shopping-list-2026-10-11.csv" / "garage-rack-bom-2026-10-11.csv". */
export function bomCsvFileName(planName: string, mode: BomCsvMode, date: Date): string {
  const what = mode === 'shopping' ? 'shopping-list' : 'bom'
  return `${slugify(planName)}-${what}-${localDateStamp(date)}.csv`
}
