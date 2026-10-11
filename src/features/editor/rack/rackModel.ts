/**
 * What the rack view draws, derived from the plan. Pure; the component memoizes it.
 *
 * Placement views do not depend on the layout (the drawing's size), so a view can be reused as
 * long as its placement object and the catalog stay the same (`PlacementViewCache`): immer keeps
 * untouched placements identical, so an edit recomputes only what it changed.
 */
import { placementHeightSixths, placementName, sectionSpans, stackJoints } from '@/domain/frame'
import { formatU, uToSixths } from '@/domain/geometry'
import {
  DEVICE_GAP_MM,
  fitDeviceInSlot,
  orientedDims,
  packAreaSlot,
  resolvePlaceable,
  type PackedDevice,
  type Placeable,
} from '@/domain/placement'
import {
  deviceName,
  type CatalogLookup,
  type Frame,
  type RenderStyle,
  type Slot,
} from '@/domain/schema/catalog'
import type { Face } from '@/domain/schema/common'
import type { PlacedDevice, Placement, PlacementBay, Plan } from '@/domain/schema/plan'
import { HAVE_TEXT, NEED_TEXT } from '@/components/common/HaveNeed'
import { positionText, rangeText, uSpan } from './labels'

/** How a placement is drawn: its catalog render style, or a labelled placeholder. */
export type DrawStyle = RenderStyle | 'unknown'

export interface DeviceView {
  /** The placed device entry's id. */
  id: string
  deviceId: string
  name: string
  have: boolean
  known: boolean
  /** Left edge from the placement's opening origin, in mm. */
  xMm: number
  /** Bottom edge from the placement's bottom, in mm. */
  yMm: number
  /** True front size (width and height in its orientation). */
  wMm: number
  hMm: number
}

export interface PlacementView {
  id: string
  placement: Placement
  name: string
  /** The catalog knows its item (or ear-mounted device). */
  known: boolean
  style: DrawStyle
  /** Catalog tint (hex), drawn subtly. */
  color?: string
  y: number
  heightSixths: number
  face: Face
  bay: PlacementBay
  have: boolean
  uStart: number
  uEnd: number
  /** "U4" / "U4–U5" / "U3 + ½U". */
  position: string
  devices: DeviceView[]
  /** Ear-hole centres from its bottom (mm), when the catalog knows them. */
  holeOffsetsMm: readonly number[]
}

function styleOf(placeable: Placeable | undefined, catalog: CatalogLookup): DrawStyle {
  if (placeable === undefined) return 'unknown'
  if (placeable.source === 'rackmount') return 'device'
  const style = catalog.item(placeable.id)?.render?.style
  if (style !== undefined) return style
  return placeable.slots.length > 0 ? 'tray' : 'blank'
}

export function placementView(placement: Placement, catalog: CatalogLookup): PlacementView {
  const placeable = resolvePlaceable(catalog, placement.itemId)
  const item = catalog.item(placement.itemId)
  const heightSixths = placementHeightSixths(placement, catalog)
  const { start, end } = uSpan(placement.y, heightSixths)
  const color = item?.render?.color
  return {
    id: placement.id,
    placement,
    name: placementName(placement, catalog),
    known: placeable !== undefined,
    style: styleOf(placeable, catalog),
    ...(color === undefined ? {} : { color }),
    y: placement.y,
    heightSixths,
    face: placement.face,
    bay: placement.bay,
    have: placement.have !== undefined,
    uStart: start,
    uEnd: end,
    position: positionText(placement.y, heightSixths),
    devices: placeable === undefined ? [] : deviceViews(placement, placeable, catalog),
    holeOffsetsMm: placeable?.mount.holeOffsetsMm ?? [],
  }
}

/** Devices at their true front size in their slots (area slots auto-pack where no x is stored). */
function deviceViews(
  placement: Placement,
  placeable: Placeable,
  catalog: CatalogLookup,
): DeviceView[] {
  const views: DeviceView[] = []
  for (const slot of placeable.slots) {
    const placed = placement.devices.filter((device) => device.slotId === slot.id)
    if (placed.length === 0) continue
    const packed = packedPositions(placed, slot, catalog)
    for (const device of placed)
      views.push(deviceView(device, slot, packed.get(device.id), catalog))
  }
  return views
}

function packedPositions(
  placed: readonly PlacedDevice[],
  slot: Slot,
  catalog: CatalogLookup,
): Map<string, PackedDevice> {
  if (slot.kind !== 'area' || placed.every((device) => device.xMm !== undefined)) return new Map()
  const items = placed.flatMap((device) => {
    const entry = catalog.device(device.deviceId)
    return entry === undefined
      ? []
      : [
          {
            id: device.id,
            device: entry,
            ...(device.orientation === undefined ? {} : { orientation: device.orientation }),
          },
        ]
  })
  const result = packAreaSlot(items, slot, DEVICE_GAP_MM)
  return new Map(result.positions.map((position) => [position.id, position]))
}

/** Placeholder size for a device the catalog does not know. */
const UNKNOWN_DEVICE_MM = { w: 60, h: 20 }

function deviceView(
  device: PlacedDevice,
  slot: Slot,
  packed: PackedDevice | undefined,
  catalog: CatalogLookup,
): DeviceView {
  const entry = catalog.device(device.deviceId)
  if (entry === undefined) {
    return {
      id: device.id,
      deviceId: device.deviceId,
      name: device.deviceId,
      have: device.have,
      known: false,
      xMm: slot.layout.xMm + (device.xMm ?? 0),
      yMm: slot.layout.yMm,
      wMm: Math.min(slot.maxW, UNKNOWN_DEVICE_MM.w),
      hMm: Math.min(slot.maxH ?? UNKNOWN_DEVICE_MM.h, UNKNOWN_DEVICE_MM.h),
    }
  }
  const orientation =
    device.orientation ?? packed?.orientation ?? fitDeviceInSlot(entry, slot).orientation ?? 'flat'
  const size = orientedDims(entry.dims, orientation)
  return {
    id: device.id,
    deviceId: entry.id,
    name: deviceName(entry),
    have: device.have,
    known: true,
    xMm: slot.layout.xMm + (device.xMm ?? packed?.xMm ?? 0),
    yMm: slot.layout.yMm,
    wMm: size.w,
    hMm: size.h,
  }
}

/** Views per catalog lookup (a new lookup can rename or resize anything), then per placement. */
const viewCache = new WeakMap<CatalogLookup, WeakMap<Placement, PlacementView>>()

/**
 * Views for every placement, reusing the earlier view of an unchanged placement object (immer
 * keeps untouched placements identical), so an edit only recomputes what it changed and the
 * memoized shapes of the others do not redraw. Weak maps: nothing outlives its plan or catalog.
 */
export function placementViews(
  placements: readonly Placement[],
  catalog: CatalogLookup,
): PlacementView[] {
  let views = viewCache.get(catalog)
  if (views === undefined) {
    views = new WeakMap()
    viewCache.set(catalog, views)
  }
  const cache = views
  return placements.map((placement) => {
    let view = cache.get(placement)
    if (view === undefined) {
      view = placementView(placement, catalog)
      cache.set(placement, view)
    }
    return view
  })
}

// ---------------------------------------------------------------------------------------------
// Sections

export interface SectionView {
  id: string
  /** 0 = bottom. */
  index: number
  /** "6U section" (the frame's type label), or "Rack 12U" for a type with a height range. */
  label: string
  /** "Section 2 (6U)", as the domain's messages call it. */
  ordinalLabel: string
  startSixths: number
  endSixths: number
  heightU: number
  have: boolean
  uStart: number
  uEnd: number
}

export function sectionViews(plan: Plan, frame: Frame): SectionView[] {
  return sectionSpans(plan, frame).map((span) => {
    const type = frame.sectionTypes.find((candidate) => candidate.id === span.typeId)
    const height = formatU(uToSixths(span.heightU))
    const label =
      type === undefined
        ? `${height} section`
        : typeof type.heightU === 'number'
          ? type.label
          : `${type.label} ${height}`
    const { start, end } = uSpan(span.startSixths, span.endSixths - span.startSixths)
    return {
      id: span.sectionId,
      index: span.index,
      label,
      ordinalLabel: `Section ${span.index + 1} (${height})`,
      startSixths: span.startSixths,
      endSixths: span.endSixths,
      heightU: span.heightU,
      have: span.have,
      uStart: start,
      uEnd: end,
    }
  })
}

export interface JointView {
  ySixths: number
  lowerId: string
  upperId: string
  /** Dead zone [deadY0, deadY1) in sixths; empty when the frame has none. */
  deadY0: number
  deadY1: number
}

export function jointViews(plan: Plan, frame: Frame): JointView[] {
  return stackJoints(plan, frame)
}

/** Where a + handle inserts: the index in the stack and how to say it. */
export interface InsertGap {
  /** `insertSection` index: 0 = below everything, sections.length = on top. */
  index: number
  ySixths: number
  where: 'top' | 'bottom' | 'between'
  /** Accessible name of the handle, e.g. "Add a section on top". */
  label: string
  /** Menu group heading, e.g. "Between Section 1 (3U) and Section 2 (6U)". */
  heading: string
  /** Where, in a sentence: "on top", "at the bottom", "between Section 1 (3U) and …". */
  phrase: string
}

export function insertGaps(sections: readonly SectionView[]): InsertGap[] {
  const top = sections.at(-1)
  const gaps: InsertGap[] = [
    {
      index: sections.length,
      ySixths: top?.endSixths ?? 0,
      where: 'top',
      label: 'Add a section on top',
      heading: 'Top of the rack',
      phrase: 'on top',
    },
  ]
  for (let index = sections.length - 1; index >= 1; index--) {
    const lower = sections[index - 1]
    const upper = sections[index]
    if (lower === undefined || upper === undefined) continue
    const between = `${lower.ordinalLabel} and ${upper.ordinalLabel}`
    gaps.push({
      index,
      ySixths: upper.startSixths,
      where: 'between',
      label: `Add a section between ${between}`,
      heading: `Between ${between}`,
      phrase: `between ${between}`,
    })
  }
  if (sections.length > 0) {
    gaps.push({
      index: 0,
      ySixths: 0,
      where: 'bottom',
      label: 'Add a section at the bottom',
      heading: 'Bottom of the rack',
      phrase: 'at the bottom',
    })
  }
  return gaps
}

export interface SectionChoice {
  typeId: string
  heightU: number
  /** "3U", or "Rails 2U" for a type with a height range. */
  label: string
}

/** The section types a handle offers: fixed heights as is, range types at their minimum. */
export function sectionChoices(frame: Frame): SectionChoice[] {
  return frame.sectionTypes.map((type) =>
    typeof type.heightU === 'number'
      ? { typeId: type.id, heightU: type.heightU, label: formatU(uToSixths(type.heightU)) }
      : {
          typeId: type.id,
          heightU: type.heightU.min,
          label: `${type.label} ${formatU(uToSixths(type.heightU.min))}`,
        },
  )
}

/** "Add 3U above" (top), "Add 3U below" (bottom), "Add 3U here" (between sections). */
export function insertItemText(gap: Pick<InsertGap, 'where'>, choice: SectionChoice): string {
  const word = gap.where === 'top' ? 'above' : gap.where === 'bottom' ? 'below' : 'here'
  return `Add ${choice.label} ${word}`
}

// ---------------------------------------------------------------------------------------------
// The "Rack contents" list

export interface ContentsGroup {
  /** Undefined for placements outside the stack. */
  section?: SectionView
  /** Top to bottom. */
  placements: PlacementView[]
}

/** Sections top to bottom with the placements whose bottom edge is in them; strays last. */
export function contentsGroups(
  sections: readonly SectionView[],
  views: readonly PlacementView[],
): ContentsGroup[] {
  const topDown = views.toSorted((a, b) => b.y - a.y || bayOrder(a.bay) - bayOrder(b.bay))
  const groups: ContentsGroup[] = sections.toReversed().map((section) => ({
    section,
    placements: topDown.filter(
      (view) => view.y >= section.startSixths && view.y < section.endSixths,
    ),
  }))
  const placed = new Set(groups.flatMap((group) => group.placements.map((view) => view.id)))
  const strays = topDown.filter((view) => !placed.has(view.id))
  if (strays.length > 0) groups.push({ placements: strays })
  return groups
}

function bayOrder(bay: PlacementBay): number {
  return bay === 'left' ? 0 : bay === 'full' ? 1 : 2
}

// ---------------------------------------------------------------------------------------------
// Accessible names (the drawing itself is not read out)

export function haveWords(have: boolean): string {
  return have ? HAVE_TEXT : NEED_TEXT
}

/** "Lenovo Tiny mount 1U, U4, In my rack, holds Lenovo ThinkCentre M720q Tiny (In my rack)". */
export function placementAriaLabel(view: PlacementView): string {
  const name = view.known ? view.name : `Unknown part: ${view.name}`
  const face = view.face === 'rear' ? ', rear' : ''
  const bay = view.bay === 'full' ? '' : `, ${view.bay} half`
  const devices =
    view.devices.length === 0
      ? ''
      : `, holds ${view.devices
          .map((device) => `${device.name} (${haveWords(device.have)})`)
          .join(', ')}`
  return `${name}, ${view.position}${face}${bay}, ${haveWords(view.have)}${devices}`
}

/** "6U section, U4–U9, In my rack". */
export function sectionAriaLabel(section: SectionView): string {
  return `${section.label}, ${rangeText(section.uStart, section.uEnd)}, ${haveWords(section.have)}`
}

/** Focus order of the drawn placements: top to bottom, left before right. */
export function focusOrder(views: readonly PlacementView[]): string[] {
  return views
    .toSorted((a, b) => b.y - a.y || bayOrder(a.bay) - bayOrder(b.bay))
    .map((view) => view.id)
}
