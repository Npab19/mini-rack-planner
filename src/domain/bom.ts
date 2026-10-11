/**
 * Bill of materials (derived only). Expands the planned rack (target) and what the user owns
 * (as-built), aggregates both per line key and works out what to install, spares, what to buy
 * and the surplus.
 *
 * - Target: every section with its current type/height/options, caps whenever there is a
 *   section, every placement, extra, placed device and equipment entry.
 * - As-built: Have sections in stack order (snapshot type/height/options) followed by retired
 *   sections, caps with a Have snapshot (plus retired caps), Have placements (snapshot item and
 *   options), extras' haveQty, owned devices and everything retired. Rack and joint lines of the
 *   as-built stack read the current rack options: there is no rack-level snapshot, and sections
 *   and caps carry their own.
 * - Hardware: install = max(0, target − as-built); spare = ⌈install × spare%⌉;
 *   need = max(0, install + spare − inventory); buy = need rounded up to packs.
 *   Embedded hardware (inserts, magnets) follows the prints you still have to make and is never
 *   surplus. Rack screws come from each placement's mount holes × the frame's fastener; recipe
 *   lines with role `rack-mount` only add provenance notes.
 * - Prints and devices: need = max(0, target − as-built − inventory).
 * - Quantities are rounded up once per aggregated line.
 */
import type {
  BomLine,
  BomLineKind,
  BomProvenance,
  BomResult,
  BomTotals,
  BomUnit,
  ComputeBom,
} from './api'
import { formatU, uNumberAt, uToSixths } from './geometry'
import { deviceKey, hardwareKey } from './ids'
import {
  expandFrameRecipe,
  expandItemRecipe,
  formatCount,
  frameConfigFromPlan,
  sectionHeightU,
  type ExpandedLine,
  type FrameConfig,
  type FrameConfigSection,
  type OptionInput,
} from './recipe'
import {
  defaultMountHoles,
  deviceName,
  withCustomEntries,
  type CatalogLookup,
  type Device,
  type Frame,
  type HardwareCategory,
  type Item,
  type PrintGroup,
} from './schema/catalog'
import type { Placement, Plan, RetiredEntry } from './schema/plan'
import { sparePctFor, type Inventory, type PackPrice, type Settings } from './schema/settings'

const EPSILON = 1e-9

/** Ear thickness assumed when an item does not declare one (mm). */
export const DEFAULT_EAR_THICKNESS_MM = 4

/** Material key for prints whose print group names none. */
export const UNSPECIFIED_MATERIAL = 'unspecified'

/** Rounds a summed quantity up once; the epsilon absorbs float noise such as 36.0000000001. */
export function roundUpQty(value: number): number {
  return Math.max(0, Math.ceil(value - EPSILON))
}

/** Line key of the power brick a device needs (included in the box or bought separately). */
export function brickKey(deviceId: string): string {
  return `${deviceKey(deviceId)}/brick`
}

// ---------------------------------------------------------------------------------------------
// Placements

type RackMount = NonNullable<Device['rackmount']>

/** What a placement holds: a catalog item, ear-mounted gear placed directly, or an unknown id. */
export type PlacedEntry =
  | { kind: 'item'; item: Item }
  | { kind: 'device'; device: Device; rackmount: RackMount }
  | { kind: 'unknown'; id: string }

/** Resolves a placement's `itemId`: an item, or a device with `rackmount` placed without a mount. */
export function resolvePlacedEntry(catalog: CatalogLookup, id: string): PlacedEntry {
  const item = catalog.item(id)
  if (item) return { kind: 'item', item }
  const device = catalog.device(id)
  if (device?.rackmount) return { kind: 'device', device, rackmount: device.rackmount }
  return { kind: 'unknown', id }
}

function placedEntryName(entry: PlacedEntry): string | undefined {
  if (entry.kind === 'item') return entry.item.name
  if (entry.kind === 'device') return deviceName(entry.device)
  return undefined
}

/** "Lenovo Tiny mount @U4": the user's label, else the catalog name, else the stored name. */
export function placementLabel(placement: Placement, entry: PlacedEntry): string {
  const name = placement.label ?? placedEntryName(entry) ?? placement.name ?? placement.itemId
  return `${name} @U${uNumberAt(placement.y)}`
}

/** Screw holes a placed item uses; rear-supported items without rear holes repeat the front count. */
export function mountHoleCount(
  mount: { front: number; rear: number },
  requiresRearSupport: boolean,
): number {
  const rear = mount.rear === 0 && requiresRearSupport ? mount.front : mount.rear
  return mount.front + rear
}

interface MountSpec {
  holes: number
  earThicknessMm: number
}

function mountSpecOf(entry: PlacedEntry): MountSpec | undefined {
  switch (entry.kind) {
    case 'item': {
      const { mount, requiresRearSupport } = entry.item
      return {
        holes: mountHoleCount(mount, requiresRearSupport ?? false),
        earThicknessMm: mount.earThicknessMm ?? DEFAULT_EAR_THICKNESS_MM,
      }
    }
    case 'device':
      return {
        holes: defaultMountHoles(entry.rackmount.heightSixths, 'full'),
        earThicknessMm: DEFAULT_EAR_THICKNESS_MM,
      }
    case 'unknown':
      return undefined
  }
}

export interface ScrewChoice {
  hardwareId: string
  /** Undefined when the catalog does not know the screw's length. */
  lengthMm?: number
  requiredMm: number
}

/** Shortest stock screw at least ear + engagement long; the longest one when none is. */
export function pickEquipmentScrew(
  frame: Frame,
  catalog: CatalogLookup,
  earThicknessMm: number = DEFAULT_EAR_THICKNESS_MM,
): ScrewChoice | undefined {
  const requiredMm = earThicknessMm + frame.equipmentFastener.engagementMm
  const sized = frame.equipmentFastener.screwIds
    .map((hardwareId) => ({ hardwareId, lengthMm: catalog.hardware(hardwareId)?.spec.lengthMm }))
    .filter(
      (screw): screw is { hardwareId: string; lengthMm: number } => screw.lengthMm !== undefined,
    )
    .toSorted((a, b) => a.lengthMm - b.lengthMm)
  const choice = sized.find((screw) => screw.lengthMm >= requiredMm - EPSILON) ?? sized.at(-1)
  if (choice) return { ...choice, requiredMm }
  const first = frame.equipmentFastener.screwIds[0]
  return first === undefined ? undefined : { hardwareId: first, requiredMm }
}

/** Nut that goes with each equipment screw, for `screw+nut` / `screw+cage-nut` frames. */
export function perHoleNutId(frame: Frame, catalog: CatalogLookup): string | undefined {
  const { perHole, nutId, thread } = frame.equipmentFastener
  if (perHole === 'screw') return undefined
  if (nutId !== undefined) return nutId
  const category: HardwareCategory = perHole === 'screw+cage-nut' ? 'cage-nut' : 'nut'
  const match = catalog
    .allHardware()
    .find((hardware) => hardware.category === category && hardware.spec.thread === thread)
  return match?.id
}

// ---------------------------------------------------------------------------------------------
// Collecting contributions

type Side = 'target' | 'asBuilt'

/**
 * reusable: assembly parts; inPrints: embedded in a print (follows the prints still to make);
 * locked: embedded without a print (never surplus).
 */
type Bucket = 'reusable' | 'inPrints' | 'locked'

interface Contribution {
  side: Side
  key: string
  kind: BomLineKind
  refId: string
  qty: number
  bucket: Bucket
  provenance: BomProvenance
  cutLengthMm?: number
  brick?: { device: Device; included: boolean }
}

interface PrintOwner {
  name: string
  isItem: boolean
  prints: readonly PrintGroup[]
}

interface UnitPrints {
  target: number
  asBuilt: number
  /** Embedded hardware key -> target quantity in this unit. */
  embeds: Map<string, number>
}

interface Collector {
  readonly plan: Plan
  readonly catalog: CatalogLookup
  readonly frame: Frame | undefined
  readonly contributions: Contribution[]
  /** Zero-quantity provenance notes per line key (rack-mount recipe lines, designer table). */
  readonly notes: Map<string, BomProvenance[]>
  /** Print key -> the frame or item whose print group it is. */
  readonly printOwners: Map<string, PrintOwner>
  /** Print key -> unit key -> prints and embeds: ties embedded hardware to prints still to make. */
  readonly printUnits: Map<string, Map<string, UnitPrints>>
  readonly designerNoteKeys: Set<string>
  readonly warnings: Set<string>
}

function sideDetail(side: Side, detail: string): string {
  return side === 'target' ? detail : `Owned: ${detail}`
}

function bucketOf(line: ExpandedLine): Bucket {
  if (line.reusable) return 'reusable'
  return line.embeddedIn ? 'inPrints' : 'locked'
}

function addNote(c: Collector, key: string, note: BomProvenance): void {
  const notes = c.notes.get(key) ?? []
  notes.push(note)
  c.notes.set(key, notes)
}

function unitPrintsFor(c: Collector, printKey: string, unitKey: string): UnitPrints {
  let units = c.printUnits.get(printKey)
  if (!units) {
    units = new Map()
    c.printUnits.set(printKey, units)
  }
  let unit = units.get(unitKey)
  if (!unit) {
    unit = { target: 0, asBuilt: 0, embeds: new Map() }
    units.set(unitKey, unit)
  }
  return unit
}

function hardwareName(c: Collector, hardwareId: string): string {
  return c.catalog.hardware(hardwareId)?.name ?? hardwareId
}

interface ExpandSource {
  owner: PrintOwner
  unitKey: (line: ExpandedLine) => string
  label: (line: ExpandedLine) => string
  multiplier: number
  /** Line the notes of `rack-mount` recipe lines attach to (the screw derived for a placement). */
  rackMountNoteKey?: string
}

function addExpanded(
  c: Collector,
  side: Side,
  lines: readonly ExpandedLine[],
  source: ExpandSource,
): void {
  for (const line of lines) {
    const qty = line.qty * source.multiplier
    if (!(qty > 0)) continue
    const label = source.label(line)
    if (line.role === 'rack-mount') {
      if (side === 'target') {
        const detail = `The designer lists ${formatCount(qty)} × ${hardwareName(c, line.refId)} for rack mounting; counted from the mount holes instead`
        addNote(c, source.rackMountNoteKey ?? line.lineKey, { label, qty: 0, detail })
      }
      continue
    }
    const unitKey = source.unitKey(line)
    const detail = line.provenance[0]?.detail ?? ''
    c.contributions.push({
      side,
      key: line.lineKey,
      kind: line.kind,
      refId: line.refId,
      qty,
      bucket: bucketOf(line),
      provenance: { label, qty, detail: sideDetail(side, detail) },
      cutLengthMm: line.cutLengthMm,
    })
    if (line.kind === 'print') {
      if (!c.printOwners.has(line.lineKey)) c.printOwners.set(line.lineKey, source.owner)
      unitPrintsFor(c, line.lineKey, unitKey)[side] += qty
    } else if (side === 'target' && line.embeddedIn) {
      const embeds = unitPrintsFor(c, line.embeddedIn.printKey, unitKey).embeds
      embeds.set(line.lineKey, (embeds.get(line.lineKey) ?? 0) + qty)
    }
  }
}

// Frame ----------------------------------------------------------------------------------------

type SectionNames = Map<string, { long: string; short: string }>

function sectionNames(plan: Plan, config: FrameConfig): SectionNames {
  const position = new Map(plan.frame.sections.map((section, index) => [section.id, index + 1]))
  const names: SectionNames = new Map()
  for (const section of config.sections) {
    const height = formatU(uToSixths(section.heightU))
    const index = position.get(section.id)
    names.set(
      section.id,
      index === undefined
        ? { long: `Retired ${height} section`, short: `retired ${height}` }
        : { long: `${height} section #${index}`, short: `${height} #${index}` },
    )
  }
  return names
}

function frameUnitLabel(line: ExpandedLine, names: SectionNames): string {
  const unitId = line.provenance[0]?.unitId ?? ''
  switch (line.unit) {
    case 'section':
      return names.get(unitId)?.long ?? line.provenance[0]?.unitLabel ?? 'Section'
    case 'joint': {
      const [lower = '', upper = ''] = unitId.split('/')
      const short = (id: string) => names.get(id)?.short ?? id
      return `Joint ${short(lower)} / ${short(upper)}`
    }
    case 'top':
      return 'Top'
    case 'bottom':
      return 'Bottom'
    default:
      return 'Rack'
  }
}

interface FrameLinesOverride {
  unitKey: string
  label: string
}

function addFrameLines(
  c: Collector,
  frame: Frame,
  side: Side,
  config: FrameConfig,
  lines: readonly ExpandedLine[],
  override?: FrameLinesOverride,
): void {
  const names = sectionNames(c.plan, config)
  addExpanded(c, side, lines, {
    owner: { name: frame.name, isItem: false, prints: frame.prints },
    unitKey: (line) => override?.unitKey ?? line.provenance[0]?.unitId ?? line.unit,
    label: (line) => override?.label ?? frameUnitLabel(line, names),
    multiplier: 1,
  })
  if (side !== 'target') return
  for (const line of lines) {
    const perSection = line.unit === 'section' || line.unit === 'joint'
    if (line.kind === 'hardware' && perSection && line.role !== 'rack-mount') {
      c.designerNoteKeys.add(line.lineKey)
    }
  }
}

function retiredUnitKey(entry: RetiredEntry): string {
  return `retired:${entry.id}`
}

/** Have sections in stack order, then retired sections; caps only when they were captured. */
export function asBuiltFrameConfig(plan: Plan, frame: Frame): FrameConfig {
  const sections: FrameConfigSection[] = []
  for (const section of plan.frame.sections) {
    const have = section.have
    if (!have) continue
    const typeId = have.typeId ?? section.typeId
    const plannedHeight = typeId === section.typeId ? section.heightU : undefined
    sections.push({
      id: section.id,
      typeId,
      heightU: have.heightU ?? sectionHeightU(frame, typeId, plannedHeight),
      options: have.options,
    })
  }
  // Retired sections stack on top: they were joined to this stack, so their joints' connectors
  // are owned too (a new section elsewhere can reuse them).
  for (const entry of plan.retired) {
    const typeId = entry.snapshot.typeId
    if (entry.kind !== 'section' || typeId === undefined) continue
    sections.push({
      id: retiredUnitKey(entry),
      typeId,
      heightU: entry.snapshot.heightU ?? sectionHeightU(frame, typeId),
      options: entry.snapshot.options,
    })
  }
  const { top, bottom } = plan.frame.caps
  return {
    sections,
    rackOptions: plan.frame.options,
    top: { present: top.have !== undefined, options: top.have?.options ?? {} },
    bottom: { present: bottom.have !== undefined, options: bottom.have?.options ?? {} },
  }
}

function addRetiredCap(
  c: Collector,
  frame: Frame,
  asBuilt: FrameConfig,
  entry: RetiredEntry,
): void {
  const cap = entry.sourceId
  if (cap !== 'top' && cap !== 'bottom') {
    c.warnings.add(`A retired cap does not say whether it was the top or the bottom; skipped`)
    return
  }
  const options = entry.snapshot.options
  const config: FrameConfig = {
    ...asBuilt,
    top: { present: cap === 'top', options },
    bottom: { present: cap === 'bottom', options },
  }
  const lines = expandFrameRecipe(frame, config).filter((line) => line.unit === cap)
  const label = cap === 'top' ? 'Retired top' : 'Retired bottom'
  addFrameLines(c, frame, 'asBuilt', config, lines, { unitKey: retiredUnitKey(entry), label })
}

function warnUnknownSectionTypes(c: Collector, frame: Frame): void {
  const known = new Set(frame.sectionTypes.map((type) => type.id))
  for (const [index, section] of c.plan.frame.sections.entries()) {
    if (!known.has(section.typeId)) {
      c.warnings.add(
        `Section #${index + 1} uses section type "${section.typeId}", which ${frame.name} does not have`,
      )
    }
  }
}

function collectFrame(c: Collector): void {
  const { plan, frame } = c
  if (frame === undefined) {
    c.warnings.add(
      `Frame "${plan.frame.frameId}" is not in the catalog: frame parts and rack screws are not counted`,
    )
    return
  }
  warnUnknownSectionTypes(c, frame)
  const target = frameConfigFromPlan(plan.frame, frame)
  addFrameLines(c, frame, 'target', target, expandFrameRecipe(frame, target))
  const asBuilt = asBuiltFrameConfig(plan, frame)
  addFrameLines(c, frame, 'asBuilt', asBuilt, expandFrameRecipe(frame, asBuilt))
  for (const entry of plan.retired) {
    if (entry.kind === 'cap') addRetiredCap(c, frame, asBuilt, entry)
  }
}

// Items, rack screws and devices ---------------------------------------------------------------

function addItem(
  c: Collector,
  side: Side,
  item: Item,
  options: OptionInput,
  unitKey: string,
  label: string,
  multiplier: number,
  rackMountNoteKey?: string,
): void {
  addExpanded(c, side, expandItemRecipe(item, options, unitKey), {
    owner: { name: item.name, isItem: true, prints: item.prints },
    unitKey: () => unitKey,
    label: () => label,
    multiplier,
    rackMountNoteKey,
  })
}

/** Adds the rack screws (and nuts) of one placed entry; returns the screw's line key. */
function addMountFasteners(
  c: Collector,
  side: Side,
  entry: PlacedEntry,
  label: string,
): string | undefined {
  const { frame } = c
  const spec = mountSpecOf(entry)
  if (frame === undefined || spec === undefined || spec.holes <= 0) return undefined
  const screw = pickEquipmentScrew(frame, c.catalog, spec.earThicknessMm)
  if (screw === undefined) {
    c.warnings.add(`${frame.name} lists no equipment screws, so rack screws are not counted`)
    return undefined
  }
  const { thread } = frame.equipmentFastener
  if (screw.lengthMm !== undefined && screw.lengthMm < screw.requiredMm - EPSILON) {
    c.warnings.add(
      `${label}: no stock ${thread} screw is ${screw.requiredMm} mm or longer; counted ${hardwareName(c, screw.hardwareId)}`,
    )
  }
  const screwKey = hardwareKey(screw.hardwareId)
  const screwDetail = `${spec.holes} mount holes × 1 ${thread} screw (≥ ${screw.requiredMm} mm: ${spec.earThicknessMm} mm ear + ${frame.equipmentFastener.engagementMm} mm thread)`
  c.contributions.push({
    side,
    key: screwKey,
    kind: 'hardware',
    refId: screw.hardwareId,
    qty: spec.holes,
    bucket: 'reusable',
    provenance: { label, qty: spec.holes, detail: sideDetail(side, screwDetail) },
  })
  if (frame.equipmentFastener.perHole === 'screw') return screwKey
  const nutId = perHoleNutId(frame, c.catalog)
  if (nutId === undefined) {
    c.warnings.add(`${frame.name} needs a nut per mount hole, but no ${thread} nut is known`)
    return screwKey
  }
  const nutDetail = `${spec.holes} mount holes × 1 nut`
  c.contributions.push({
    side,
    key: hardwareKey(nutId),
    kind: 'hardware',
    refId: nutId,
    qty: spec.holes,
    bucket: 'reusable',
    provenance: { label, qty: spec.holes, detail: sideDetail(side, nutDetail) },
  })
  return screwKey
}

function addDevice(
  c: Collector,
  side: Side,
  deviceId: string,
  label: string,
  detail: string,
): void {
  const device = c.catalog.device(deviceId)
  if (device === undefined) {
    c.warnings.add(`Device "${deviceId}" is not in the catalog: it is listed by id only`)
  }
  const provenance = { label, qty: 1, detail: sideDetail(side, detail) }
  c.contributions.push({
    side,
    key: deviceKey(deviceId),
    kind: 'device',
    refId: deviceId,
    qty: 1,
    bucket: 'reusable',
    provenance,
  })
  const brick = device?.power?.input.brick
  if (device === undefined || brick === undefined) return
  c.contributions.push({
    side,
    key: brickKey(deviceId),
    kind: 'device',
    refId: deviceId,
    qty: 1,
    bucket: 'reusable',
    provenance,
    brick: { device, included: brick.included },
  })
}

function addPlacedEntry(
  c: Collector,
  side: Side,
  entry: PlacedEntry,
  options: OptionInput,
  unitKey: string,
  label: string,
): void {
  switch (entry.kind) {
    case 'item': {
      const screwKey = addMountFasteners(c, side, entry, label)
      addItem(c, side, entry.item, options, unitKey, label, 1, screwKey)
      return
    }
    case 'device':
      addMountFasteners(c, side, entry, label)
      addDevice(c, side, entry.device.id, label, 'rack-mounted')
      return
    case 'unknown':
      c.warnings.add(
        `Part "${entry.id}" (${label}) is not in the catalog: its prints and hardware are not counted`,
      )
  }
}

function collectPlacements(c: Collector): void {
  for (const placement of c.plan.placements) {
    const planned = resolvePlacedEntry(c.catalog, placement.itemId)
    const label = placementLabel(placement, planned)
    addPlacedEntry(c, 'target', planned, placement.options ?? {}, placement.id, label)
    if (placement.have) {
      const built = resolvePlacedEntry(c.catalog, placement.have.itemId ?? placement.itemId)
      addPlacedEntry(c, 'asBuilt', built, placement.have.options, placement.id, label)
    }
    for (const placed of placement.devices) {
      const detail = `in slot "${placed.slotId}"`
      addDevice(c, 'target', placed.deviceId, label, detail)
      if (placed.have) addDevice(c, 'asBuilt', placed.deviceId, label, detail)
    }
  }
}

function collectExtras(c: Collector): void {
  for (const extra of c.plan.extras) {
    const item = c.catalog.item(extra.itemId)
    if (item === undefined) {
      c.warnings.add(`Extra "${extra.itemId}" is not in the catalog: it is not counted`)
      continue
    }
    addItem(c, 'target', item, {}, extra.id, item.name, extra.qty)
    addItem(c, 'asBuilt', item, {}, extra.id, item.name, extra.haveQty)
  }
}

function collectEquipment(c: Collector): void {
  const label = 'Equipment to fit'
  for (const entry of c.plan.equipment) {
    addDevice(c, 'target', entry.deviceId, label, 'not placed yet')
    if (entry.have) addDevice(c, 'asBuilt', entry.deviceId, label, 'not placed yet')
  }
}

function collectRetired(c: Collector): void {
  for (const entry of c.plan.retired) {
    const unitKey = retiredUnitKey(entry)
    const { itemId, options } = entry.snapshot
    if (entry.kind === 'placement') {
      const placed: PlacedEntry =
        itemId === undefined
          ? { kind: 'unknown', id: entry.sourceId ?? entry.id }
          : resolvePlacedEntry(c.catalog, itemId)
      const label = `Retired ${placedEntryName(placed) ?? itemId ?? 'placement'}`
      addPlacedEntry(c, 'asBuilt', placed, options, unitKey, label)
      for (const deviceId of entry.devices ?? []) {
        addDevice(c, 'asBuilt', deviceId, label, 'kept from a removed placement')
      }
    } else if (entry.kind === 'extra') {
      const item = itemId === undefined ? undefined : c.catalog.item(itemId)
      if (item === undefined) {
        c.warnings.add(`Retired extra "${itemId ?? entry.id}" is not in the catalog: not counted`)
        continue
      }
      addItem(c, 'asBuilt', item, options, unitKey, `Retired ${item.name}`, entry.qty ?? 0)
    }
  }
}

function addDesignerNote(c: Collector): void {
  const note = c.frame ? designerTableNote(c.frame, c.plan) : undefined
  if (note === undefined) return
  for (const key of c.designerNoteKeys) {
    addNote(c, key, { label: 'Designer table', qty: 0, detail: note })
  }
}

// ---------------------------------------------------------------------------------------------
// Designer table

function largestFirst(totalU: number, sizes: readonly number[]): number[] | undefined {
  const parts: number[] = []
  let rest = totalU
  for (const size of [...new Set(sizes)].toSorted((a, b) => b - a)) {
    while (rest >= size) {
      parts.push(size)
      rest -= size
    }
  }
  return rest === 0 ? parts : undefined
}

function sameHeights(a: readonly number[], b: readonly number[]): boolean {
  const sortedA = a.toSorted((x, y) => x - y)
  const sortedB = b.toSorted((x, y) => x - y)
  return sortedA.length === sortedB.length && sortedA.every((value, i) => value === sortedB[i])
}

function joinU(heights: readonly number[]): string {
  return heights.map((u) => `${u}U`).join('+')
}

/**
 * Designers publish hardware per rack height assuming the largest sections first (KWS: 12U =
 * 6U+6U). When this stack is built differently, its counts differ from that row; this returns
 * the hint, e.g. "The designer's 12U row assumes 6U+6U; this rack has 3 sections".
 */
export function designerTableNote(frame: Frame, plan: Plan): string | undefined {
  const heights = plan.frame.sections.map((section) =>
    sectionHeightU(frame, section.typeId, section.heightU),
  )
  const sizes = frame.sectionTypes.flatMap((type) =>
    typeof type.heightU === 'number' ? [type.heightU] : [],
  )
  const ranged = sizes.length !== frame.sectionTypes.length
  if (heights.length === 0 || ranged || heights.some((u) => u <= 0)) return undefined
  const totalU = heights.reduce((sum, u) => sum + u, 0)
  const designer = largestFirst(totalU, sizes)
  if (designer === undefined || sameHeights(designer, heights)) return undefined
  const count = heights.length
  const thisRack =
    designer.length === count ? joinU(heights) : `${count} section${count === 1 ? '' : 's'}`
  return `The designer's ${totalU}U row assumes ${joinU(designer)}; this rack has ${thisRack}`
}

// ---------------------------------------------------------------------------------------------
// Packs

export interface PackCount {
  size: number
  count: number
}

export interface PackRound {
  /** Pieces to buy. */
  buy: number
  packs: PackCount[]
  /** Price of those packs; set only when prices were given. */
  cost?: number
}

// Beyond this many pieces the exact search gives way to whole packs of the best value.
const MAX_PACK_SEARCH = 100_000

function sumPacks(packs: readonly PackCount[]): number {
  return packs.reduce((total, pack) => total + pack.size * pack.count, 0)
}

function mergePacks(packs: readonly PackCount[]): PackCount[] {
  const counts = new Map<number, number>()
  for (const pack of packs) {
    if (pack.count > 0) counts.set(pack.size, (counts.get(pack.size) ?? 0) + pack.count)
  }
  return [...counts].map(([size, count]) => ({ size, count })).toSorted((a, b) => b.size - a.size)
}

function bestValuePacks(need: number, prices: readonly PackPrice[]): PackRound {
  const best = prices.reduce((a, b) => (b.price / b.size < a.price / a.size ? b : a))
  const count = Math.ceil(need / best.size)
  return { buy: count * best.size, packs: [{ size: best.size, count }], cost: count * best.price }
}

/** Cheapest pack combination covering `need`; ties go to fewer pieces, then fewer packs. */
function cheapestPacks(need: number, prices: readonly PackPrice[]): PackRound {
  const largest = Math.max(...prices.map((price) => price.size))
  // An optimum never needs more than need + largest pieces: one pack less would still cover it.
  const limit = need + largest
  if (limit > MAX_PACK_SEARCH) return bestValuePacks(need, prices)
  const cost: number[] = [0]
  const packCount: number[] = [0]
  const lastPack: number[] = [-1]
  for (let quantity = 1; quantity <= limit; quantity++) {
    cost[quantity] = Infinity
    packCount[quantity] = 0
    lastPack[quantity] = -1
    for (const [index, pack] of prices.entries()) {
      if (pack.size > quantity) continue
      const before = quantity - pack.size
      const candidate = (cost[before] ?? Infinity) + pack.price
      const packs = (packCount[before] ?? 0) + 1
      const current = cost[quantity] ?? Infinity
      const cheaper = candidate < current - EPSILON
      const tie = Math.abs(candidate - current) <= EPSILON && packs < (packCount[quantity] ?? 0)
      if (cheaper || tie) {
        cost[quantity] = candidate
        packCount[quantity] = packs
        lastPack[quantity] = index
      }
    }
  }
  // Ascending quantities with a strict comparison: equal costs keep the smaller quantity.
  let best = -1
  let bestCost = Infinity
  for (let quantity = need; quantity <= limit; quantity++) {
    const candidate = cost[quantity] ?? Infinity
    if (candidate < bestCost - EPSILON) {
      best = quantity
      bestCost = candidate
    }
  }
  if (best < 0) return bestValuePacks(need, prices)
  const chosen: PackCount[] = []
  for (let quantity = best; quantity > 0;) {
    const pack = prices[lastPack[quantity] ?? -1]
    if (pack === undefined) break
    chosen.push({ size: pack.size, count: 1 })
    quantity -= pack.size
  }
  return { buy: best, packs: mergePacks(chosen), cost: cost[best] ?? 0 }
}

/**
 * Rounds a quantity up to what can be bought: the cheapest combination when prices are known,
 * else the smallest pack that covers it, else whole packs of the largest size topped up with the
 * smallest pack that covers the rest. Without packs, exactly `need`.
 */
export function packRound(
  need: number,
  packSizes: readonly number[] = [],
  prices: readonly PackPrice[] = [],
): PackRound {
  if (!(need > 0)) return { buy: 0, packs: [] }
  const priced = prices.filter((price) => price.size > 0)
  if (priced.length > 0) return cheapestPacks(need, priced)
  const sizes = [...new Set(packSizes.filter((size) => size > 0))].toSorted((a, b) => a - b)
  const largest = sizes.at(-1)
  if (largest === undefined) return { buy: need, packs: [] }
  const single = sizes.find((size) => size >= need)
  if (single !== undefined) return { buy: single, packs: [{ size: single, count: 1 }] }
  const full = Math.floor(need / largest)
  const rest = need - full * largest
  const topUp = rest > 0 ? (sizes.find((size) => size >= rest) ?? largest) : undefined
  const packs = mergePacks([
    { size: largest, count: full },
    ...(topUp === undefined ? [] : [{ size: topUp, count: 1 }]),
  ])
  return { buy: sumPacks(packs), packs }
}

function describePacks(packs: readonly PackCount[]): string {
  return packs.map((pack) => `${pack.count} × ${pack.size}`).join(' + ')
}

// ---------------------------------------------------------------------------------------------
// Lines

interface Buckets {
  reusable: number
  inPrints: number
  locked: number
}

interface Tally {
  key: string
  kind: BomLineKind
  refId: string
  cutLengthMm?: number
  brick?: { device: Device; included: boolean }
  target: Buckets
  asBuilt: Buckets
  provenance: BomProvenance[]
}

function emptyBuckets(): Buckets {
  return { reusable: 0, inPrints: 0, locked: 0 }
}

function bucketTotal(buckets: Buckets): number {
  return buckets.reusable + buckets.inPrints + buckets.locked
}

function tallyContributions(contributions: readonly Contribution[]): Map<string, Tally> {
  const tallies = new Map<string, Tally>()
  for (const contribution of contributions) {
    let tally = tallies.get(contribution.key)
    if (!tally) {
      tally = {
        key: contribution.key,
        kind: contribution.kind,
        refId: contribution.refId,
        cutLengthMm: contribution.cutLengthMm,
        brick: contribution.brick,
        target: emptyBuckets(),
        asBuilt: emptyBuckets(),
        provenance: [],
      }
      tallies.set(contribution.key, tally)
    }
    tally[contribution.side][contribution.bucket] += contribution.qty
    tally.provenance.push(contribution.provenance)
  }
  return tallies
}

function isOwnedEntry(entry: BomProvenance): boolean {
  return entry.detail?.startsWith('Owned: ') ?? false
}

/** Merges provenance entries with the same label and detail; target entries come first. */
function mergeProvenance(entries: readonly BomProvenance[]): BomProvenance[] {
  const merged = new Map<string, BomProvenance>()
  for (const entry of entries) {
    const id = `${entry.label}\u0000${entry.detail ?? ''}`
    const existing = merged.get(id)
    if (existing) existing.qty += entry.qty
    else merged.set(id, { ...entry })
  }
  const rounded = [...merged.values()].map((entry) => ({
    ...entry,
    qty: Math.round(entry.qty * 1000) / 1000,
  }))
  return [...rounded.filter((entry) => !isOwnedEntry(entry)), ...rounded.filter(isOwnedEntry)]
}

/**
 * Embedded hardware to install: for each print, the prints still to make are spread over the
 * units (section, cap, placement) that miss prints, and each unit's embeds per print apply.
 * A unit is short when it has fewer as-built prints than planned; prints owned elsewhere (retired
 * sections, changed units) reduce the count to make proportionally.
 */
function embeddedInstall(
  printUnits: ReadonlyMap<string, ReadonlyMap<string, UnitPrints>>,
  printInstall: ReadonlyMap<string, number>,
): Map<string, number> {
  const result = new Map<string, number>()
  for (const [printKey, units] of printUnits) {
    const toMake = printInstall.get(printKey) ?? 0
    if (toMake <= 0) continue
    const shortfall = (unit: UnitPrints) => Math.max(0, unit.target - unit.asBuilt)
    let totalShort = 0
    for (const unit of units.values()) totalShort += shortfall(unit)
    if (totalShort <= 0) continue
    const share = toMake / totalShort
    for (const unit of units.values()) {
      const missing = shortfall(unit)
      if (missing <= 0 || unit.target <= 0) continue
      for (const [embedKey, embeddedQty] of unit.embeds) {
        const perPrint = embeddedQty / unit.target
        result.set(embedKey, (result.get(embedKey) ?? 0) + missing * share * perPrint)
      }
    }
  }
  return result
}

interface Quantities {
  target: number
  asBuilt: number
  install: number
  spare: number
  need: number
  buy: number
  surplus: number
  packs: PackCount[]
  packCost?: number
}

interface ExplainInput {
  target: number
  asBuilt: number
  install: number
  spare: number
  sparePct: number
  inventory: number
  need: number
  buy: number
  surplus: number
  packs: readonly PackCount[]
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`
}

/** Plain-language sum, e.g. "36 = 144 in plan − 108 in your rack − 0 spares". */
export function explainQuantities(q: ExplainInput): string {
  const owned = `${q.target} in plan, ${q.asBuilt} in your rack`
  if (q.install === 0) {
    if (q.surplus > 0) return `0 to get: ${owned} (${q.surplus} surplus)`
    if (q.target > q.asBuilt)
      return `0 to get: ${owned}; the prints that hold them are already made`
    return `0 to get: ${owned}`
  }
  const used = Math.min(q.inventory, q.install + q.spare)
  let text =
    q.install === q.target - q.asBuilt
      ? `${q.need} = ${q.target} in plan − ${q.asBuilt} in your rack`
      : `${q.need} = ${q.install} for what you still build (${owned})`
  if (q.spare > 0) text += ` + ${q.spare} extra (${percent(q.sparePct)})`
  text += q.inventory > used ? ` − ${used} of your ${q.inventory} spares` : ` − ${used} spares`
  if (q.buy > q.need) text += `; buy ${q.buy} (${describePacks(q.packs)})`
  if (q.surplus > 0) text += `; ${q.surplus} surplus`
  return text
}

function countedQuantities(
  target: number,
  asBuilt: number,
  onHand: number,
  reusable: boolean,
): Quantities {
  const install = Math.max(0, target - asBuilt)
  const need = Math.max(0, install - onHand)
  const surplus = reusable ? Math.max(0, asBuilt - target) : 0
  return { target, asBuilt, install, spare: 0, need, buy: need, surplus, packs: [] }
}

interface HardwareInput {
  tally: Tally
  embedded: number
  sparePct: number
  onHand: number
  packSizes: readonly number[] | undefined
  prices: readonly PackPrice[] | undefined
}

function hardwareQuantities(input: HardwareInput): Quantities {
  const { tally, sparePct, onHand } = input
  const targetReusable = roundUpQty(tally.target.reusable)
  const builtReusable = roundUpQty(tally.asBuilt.reusable)
  const lockedInstall = Math.max(
    0,
    roundUpQty(tally.target.locked) - roundUpQty(tally.asBuilt.locked),
  )
  const install =
    Math.max(0, targetReusable - builtReusable) + lockedInstall + roundUpQty(input.embedded)
  const spare = install > 0 ? roundUpQty(install * sparePct) : 0
  const need = Math.max(0, install + spare - onHand)
  // Cut pieces are bought as pieces of their own length, never in packs.
  const rounded =
    tally.cutLengthMm === undefined
      ? packRound(need, input.packSizes, input.prices)
      : { buy: need, packs: [] }
  return {
    target: roundUpQty(bucketTotal(tally.target)),
    asBuilt: roundUpQty(bucketTotal(tally.asBuilt)),
    install,
    spare,
    need,
    buy: rounded.buy,
    surplus: Math.max(0, builtReusable - targetReusable),
    packs: rounded.packs,
    packCost: rounded.cost,
  }
}

interface LineMeta {
  label: string
  unit: BomUnit
  category?: string
  gramsEach?: number
  minutesEach?: number
  material?: string
}

function printMeta(c: Collector, tally: Tally): LineMeta {
  const owner = c.printOwners.get(tally.key)
  const group = owner?.prints.find((print) => print.id === tally.refId)
  const base = group?.label ?? tally.refId
  const label = owner?.isItem && owner.name !== base ? `${owner.name}: ${base}` : base
  return {
    label,
    unit: 'plates',
    gramsEach: group?.gramsPerPrint,
    minutesEach: group?.minutesPerPrint,
    material: group?.material,
  }
}

function hardwareMeta(c: Collector, tally: Tally): LineMeta {
  const hardware = c.catalog.hardware(tally.refId)
  if (hardware === undefined) {
    c.warnings.add(`Hardware "${tally.refId}" is not in the catalog: listed by id`)
  }
  const name = hardware?.name ?? tally.refId
  if (tally.cutLengthMm !== undefined) {
    return {
      label: `${name}, cut to ${tally.cutLengthMm} mm`,
      unit: 'pcs',
      category: hardware?.category,
    }
  }
  return { label: name, unit: hardware?.unit === 'mm' ? 'mm' : 'pcs', category: hardware?.category }
}

function deviceMeta(c: Collector, tally: Tally): LineMeta {
  if (tally.brick) {
    return {
      label: `Power brick for ${deviceName(tally.brick.device)}`,
      unit: 'pcs',
      category: 'power-brick',
    }
  }
  const device = c.catalog.device(tally.refId)
  return {
    label: device ? deviceName(device) : tally.refId,
    unit: 'pcs',
    category: device?.category,
  }
}

function lineMeta(c: Collector, tally: Tally): LineMeta {
  switch (tally.kind) {
    case 'print':
      return printMeta(c, tally)
    case 'hardware':
      return hardwareMeta(c, tally)
    case 'device':
      return deviceMeta(c, tally)
  }
}

function includedQuantities(target: number, asBuilt: number): Quantities {
  return { target, asBuilt, install: 0, spare: 0, need: 0, buy: 0, surplus: 0, packs: [] }
}

/** Only assembly parts can move elsewhere; embedded hardware stays in its print. */
function isReusable(tally: Tally): boolean {
  const embedded = (buckets: Buckets) => buckets.inPrints + buckets.locked
  return embedded(tally.target) + embedded(tally.asBuilt) === 0
}

interface QuantityInput {
  embedded: ReadonlyMap<string, number>
  settings: Settings
  onHand: number
  sparePct: number
}

function quantitiesFor(c: Collector, tally: Tally, input: QuantityInput): Quantities {
  const target = roundUpQty(bucketTotal(tally.target))
  const asBuilt = roundUpQty(bucketTotal(tally.asBuilt))
  if (tally.brick?.included === true) return includedQuantities(target, asBuilt)
  if (tally.kind !== 'hardware') {
    return countedQuantities(target, asBuilt, input.onHand, isReusable(tally))
  }
  return hardwareQuantities({
    tally,
    embedded: input.embedded.get(tally.key) ?? 0,
    sparePct: input.sparePct,
    onHand: input.onHand,
    packSizes: c.catalog.hardware(tally.refId)?.packSizes,
    prices: input.settings.packPrices[tally.refId],
  })
}

function buildLine(
  c: Collector,
  tally: Tally,
  embedded: ReadonlyMap<string, number>,
  settings: Settings,
  inventory: Inventory,
): { line: BomLine; packCost?: number } | undefined {
  const target = roundUpQty(bucketTotal(tally.target))
  const asBuilt = roundUpQty(bucketTotal(tally.asBuilt))
  if (target === 0 && asBuilt === 0) return undefined
  const meta = lineMeta(c, tally)
  const onHand = inventory[tally.key] ?? 0
  const included = tally.brick?.included === true
  const sparePct = tally.kind === 'hardware' ? sparePctFor(settings, meta.category ?? 'default') : 0
  const q = quantitiesFor(c, tally, { embedded, settings, onHand, sparePct })

  const why = included
    ? `Ships with the ${tally.brick ? deviceName(tally.brick.device) : 'device'}: ${target} in plan, ${asBuilt} in your rack; never bought separately`
    : explainQuantities({ ...q, sparePct, inventory: onHand })
  const provenance = [...mergeProvenance(tally.provenance), ...(c.notes.get(tally.key) ?? [])]
  const line: BomLine = {
    key: tally.key,
    kind: tally.kind,
    refId: tally.refId,
    label: meta.label,
    unit: meta.unit,
    target: q.target,
    asBuilt: q.asBuilt,
    install: q.install,
    spare: q.spare,
    need: q.need,
    buy: q.buy,
    surplus: q.surplus,
    reusable: isReusable(tally),
    provenance,
    why,
    ...(meta.category === undefined ? {} : { category: meta.category }),
    ...(included ? { included: true } : {}),
    ...(tally.cutLengthMm === undefined ? {} : { cutLengthMm: tally.cutLengthMm }),
    ...(meta.gramsEach === undefined ? {} : { gramsEach: meta.gramsEach }),
    ...(meta.minutesEach === undefined ? {} : { minutesEach: meta.minutesEach }),
    ...(meta.material === undefined ? {} : { material: meta.material }),
  }
  return q.packCost === undefined ? { line } : { line, packCost: q.packCost }
}

const KIND_ORDER: Record<BomLineKind, number> = { print: 0, hardware: 1, device: 2 }

function compareText(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function compareLines(a: BomLine, b: BomLine): number {
  return (
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    compareText(a.label, b.label) ||
    compareText(a.key, b.key)
  )
}

function addTo(record: Record<string, number>, key: string, value: number): void {
  if (value > 0) record[key] = (record[key] ?? 0) + value
}

function computeTotals(
  lines: readonly BomLine[],
  settings: Settings,
  hardwareCost: number | undefined,
): BomTotals {
  const totals: BomTotals = {
    printsGramsByMaterial: {},
    printMinutes: 0,
    needGramsByMaterial: {},
    needMinutes: 0,
  }
  let filamentCost: number | undefined
  for (const line of lines) {
    if (line.kind !== 'print') continue
    const material = line.material ?? UNSPECIFIED_MATERIAL
    const grams = line.gramsEach ?? 0
    const minutes = line.minutesEach ?? 0
    addTo(totals.printsGramsByMaterial, material, line.target * grams)
    addTo(totals.needGramsByMaterial, material, line.need * grams)
    totals.printMinutes += line.target * minutes
    totals.needMinutes += line.need * minutes
    const pricePerKg =
      line.material === undefined ? undefined : settings.filamentCostPerKg[line.material]
    if (pricePerKg !== undefined && line.gramsEach !== undefined) {
      filamentCost = (filamentCost ?? 0) + (line.need * grams * pricePerKg) / 1000
    }
  }
  if (filamentCost !== undefined || hardwareCost !== undefined) {
    totals.cost = Math.round(((filamentCost ?? 0) + (hardwareCost ?? 0)) * 100) / 100
  }
  return totals
}

function createCollector(plan: Plan, catalog: CatalogLookup): Collector {
  return {
    plan,
    catalog,
    frame: catalog.frame(plan.frame.frameId),
    contributions: [],
    notes: new Map(),
    printOwners: new Map(),
    printUnits: new Map(),
    designerNoteKeys: new Set(),
    warnings: new Set(),
  }
}

function finish(c: Collector, settings: Settings, inventory: Inventory): BomResult {
  const tallies = tallyContributions(c.contributions)
  const printInstall = new Map<string, number>()
  for (const tally of tallies.values()) {
    if (tally.kind !== 'print') continue
    const install = roundUpQty(bucketTotal(tally.target)) - roundUpQty(bucketTotal(tally.asBuilt))
    printInstall.set(tally.key, Math.max(0, install))
  }
  const embedded = embeddedInstall(c.printUnits, printInstall)
  const lines: BomLine[] = []
  let hardwareCost: number | undefined
  for (const tally of tallies.values()) {
    const built = buildLine(c, tally, embedded, settings, inventory)
    if (built === undefined) continue
    lines.push(built.line)
    if (built.packCost !== undefined) hardwareCost = (hardwareCost ?? 0) + built.packCost
  }
  const sorted = lines.toSorted(compareLines)
  return {
    lines: sorted,
    totals: computeTotals(sorted, settings, hardwareCost),
    warnings: [...c.warnings],
  }
}

export const computeBom: ComputeBom = (plan, baseCatalog, settings, inventory) => {
  const catalog = withCustomEntries(baseCatalog, plan.custom)
  const c = createCollector(plan, catalog)
  collectFrame(c)
  collectPlacements(c)
  collectExtras(c)
  collectEquipment(c)
  collectRetired(c)
  addDesignerNote(c)
  return finish(c, settings, inventory)
}

// ---------------------------------------------------------------------------------------------
// Helpers for the BOM drawer

/** What to get: lines with something to buy. Included accessories never show up here. */
export function shoppingLines(result: BomResult): BomLine[] {
  return result.lines.filter((line) => !line.included && line.buy > 0)
}

/** Owned but no longer used by the plan (reusable lines only). */
export function surplusLines(result: BomResult): BomLine[] {
  return result.lines.filter((line) => line.surplus > 0)
}

/**
 * Inventory after a build step (Need -> Have, Finish build): loose spares drop by what is newly
 * installed per line (as-built after − as-built before), never below zero. Entries that reach
 * zero are removed.
 */
export function consumeInventory(
  before: BomResult,
  after: BomResult,
  inventory: Inventory,
): Inventory {
  const builtBefore = new Map(before.lines.map((line) => [line.key, line.asBuilt]))
  const installed = new Map<string, number>()
  for (const line of after.lines) {
    if (line.included) continue
    const added = line.asBuilt - (builtBefore.get(line.key) ?? 0)
    if (added > 0) installed.set(line.key, added)
  }
  const remaining = Object.entries(inventory)
    .map(([key, qty]) => [key, Math.max(0, qty - (installed.get(key) ?? 0))] as const)
    .filter(([, qty]) => qty > 0)
  return Object.fromEntries(remaining)
}
