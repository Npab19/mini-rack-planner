/**
 * The palette's search and rows: catalog search (`createCatalogSearch`) over the plan's lookup
 * (bundled catalog + library + the plan's own entries), split into tabs (mounts & panels, devices,
 * the user's own parts), category chips and the "fits this frame" filter. Pure.
 */
import { entryName, type CatalogSearch } from '@/catalog/search'
import { formatU } from '@/domain/geometry'
import type { CatalogEntry, CatalogKind, Device, Item } from '@/domain/schema/catalog'
import { isCustomId, type Dims } from '@/domain/schema/common'
import type { DragSubject } from '../rack/dragSubject'

export type PaletteTab = 'mounts' | 'devices' | 'mine'

export const PALETTE_TABS: ReadonlyArray<{ id: PaletteTab; label: string }> = [
  { id: 'mounts', label: 'Mounts & panels' },
  { id: 'devices', label: 'Devices' },
  { id: 'mine', label: 'My parts' },
]

const TAB_KINDS: Record<PaletteTab, readonly CatalogKind[]> = {
  mounts: ['item', 'extra'],
  devices: ['device'],
  mine: ['item', 'extra', 'device'],
}

export type PaletteEntry = Item | Device

export interface PaletteRow {
  id: string
  entry: PaletteEntry
  kind: 'item' | 'extra' | 'device'
  name: string
  category: string
  /** "1U", "½U": items, and devices that mount by their own ears. */
  heightText?: string
  /** "179 × 183 × 34.5 mm" for devices. */
  sizeText?: string
  designer?: string
  license?: string
  url?: string
  unverified: boolean
  /** One of the user's own parts (`custom:` id). */
  custom: boolean
  /** Made for the plan's frame (its `compat.frames` lists it). */
  frameSpecific: boolean
  /** Goes on the rails: an item, or a device with `rackmount`. */
  placeable: boolean
}

export interface PaletteQuery {
  query: string
  tab: PaletteTab
  /** Selected category chips; none selected shows every category. */
  categories: readonly string[]
  /** "Fits this frame": hides items whose `compat.frames` leaves this frame out. */
  fitsFrameId?: string
}

function isPaletteEntry(entry: CatalogEntry): entry is PaletteEntry {
  return entry.kind === 'item' || entry.kind === 'extra' || entry.kind === 'device'
}

function inTab(entry: PaletteEntry, tab: PaletteTab): boolean {
  return TAB_KINDS[tab].includes(entry.kind) && (tab !== 'mine' || isCustomId(entry.id))
}

function mm(value: number): string {
  return String(Math.round(value * 10) / 10)
}

/** "179 × 183 × 34.5 mm" (width × depth × height). */
export function dimsText(dims: Dims): string {
  return `${mm(dims.w)} × ${mm(dims.d)} × ${mm(dims.h)} mm`
}

/** Whole labels where the rules below do not fit. */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  nas: 'NAS',
  ups: 'UPS',
  kvm: 'KVM',
  shelf: 'Shelves',
  power: 'Power',
  other: 'Other',
}

const ACRONYMS: Readonly<Record<string, string>> = {
  nas: 'NAS',
  pc: 'PC',
  sbc: 'SBC',
  pdu: 'PDU',
  ups: 'UPS',
  kvm: 'KVM',
  usb: 'USB',
  poe: 'PoE',
}

function plural(word: string): string {
  if (/(?:s|x|z|ch|sh)$/.test(word)) return `${word}es`
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`
  return `${word}s`
}

/** "mini-pc" -> "Mini PCs", "mount" -> "Mounts", "switch" -> "Switches", "nas-mount" -> "NAS mounts". */
export function categoryLabel(category: string): string {
  const known = CATEGORY_LABELS[category]
  if (known !== undefined) return known
  const words = category.split('-').filter((word) => word !== '')
  const last = words.length - 1
  const text = words
    .map((word, index) => {
      const acronym = ACRONYMS[word]
      if (index !== last) return acronym ?? word
      return acronym === undefined ? plural(word) : `${acronym}s`
    })
    .join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function toPaletteRow(entry: PaletteEntry, frameId: string | undefined): PaletteRow {
  const source = entry.source
  const base = {
    id: entry.id,
    entry,
    name: entryName(entry),
    category: entry.category,
    ...(source?.designer === undefined ? {} : { designer: source.designer }),
    ...(source?.license === undefined ? {} : { license: source.license }),
    ...(source?.url === undefined ? {} : { url: source.url }),
    unverified: entry.verified.method === 'unverified',
    custom: isCustomId(entry.id),
  }
  if (entry.kind === 'device') {
    const rackmount = entry.rackmount
    return {
      ...base,
      kind: 'device',
      ...(rackmount === undefined ? {} : { heightText: formatU(rackmount.heightSixths) }),
      sizeText: dimsText(entry.dims),
      frameSpecific: false,
      placeable: rackmount !== undefined,
    }
  }
  return {
    ...base,
    kind: entry.kind,
    ...(entry.kind === 'item' ? { heightText: formatU(entry.heightSixths) } : {}),
    frameSpecific: frameId !== undefined && (entry.compat?.frames ?? []).includes(frameId),
    placeable: entry.kind === 'item',
  }
}

/** Rows for a query, best match first (`createCatalogSearch` ranking). */
export function paletteRows(
  search: CatalogSearch,
  query: PaletteQuery,
  frameId: string | undefined,
): PaletteRow[] {
  const hits = search(query.query, {
    kind: TAB_KINDS[query.tab],
    ...(query.categories.length > 0 ? { category: query.categories } : {}),
    ...(query.fitsFrameId === undefined ? {} : { fitsFrameId: query.fitsFrameId }),
  })
  const rows: PaletteRow[] = []
  for (const { entry } of hits) {
    if (isPaletteEntry(entry) && inTab(entry, query.tab)) rows.push(toPaletteRow(entry, frameId))
  }
  return rows
}

/** Categories present in a tab, ordered by their label. */
export function tabCategories(entries: readonly CatalogEntry[], tab: PaletteTab): string[] {
  const categories = new Set<string>()
  for (const entry of entries) {
    if (isPaletteEntry(entry) && inTab(entry, tab)) categories.add(entry.category)
  }
  return [...categories].toSorted((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)))
}

/**
 * What dragging a row onto the rack carries: mounts, panels and devices (catalog or the user's
 * own); accessories take no rack space, so they are not dragged.
 */
export function dragSubjectOf(row: Pick<PaletteRow, 'kind' | 'id'>): DragSubject | null {
  if (row.kind === 'item') return { kind: 'item', itemId: row.id }
  if (row.kind === 'device') return { kind: 'device', deviceId: row.id }
  return null
}
