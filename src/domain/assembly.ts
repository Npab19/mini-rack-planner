/**
 * 3D assembly: turns a plan into part instances (a catalog part or a proxy box, plus a transform).
 * The 3D viewer only renders the result.
 *
 * Rack millimetres: X right (0 = rack centreline), Y up (0 = bottom of U1), Z toward the viewer
 * (0 = rail front face; the frame extends back to -depthMm).
 *
 * Each instance's local frame has its box (`proxyDims`, which is the part envelope for catalog
 * parts) centred on the origin. A renderer draws `box(w, h, d)`, or a mesh aligned to the part
 * envelope, with `matrix` as is.
 *
 * - Frame parts come from the frame's `assembly3d` rules. A frame without rules or 3D parts (or an
 *   unknown frame) gets generic proxies: corner posts, a connector slab per joint, top and bottom
 *   plates.
 * - Each placement is a front panel, a tray for shelf/tray styles (or the body of ear-mounted
 *   gear), and a box per device, sized and packed like the placement engine does.
 * - state: 'have' when the owning section/cap/placement has a Have snapshot (both sections for a
 *   joint; the device's own flag for devices), else 'need'.
 */
import type { Assemble, PartInstance, PartState } from './api'
import {
  EIA_EAR_SPACING_MM,
  NOMINAL_OPENING_MM,
  PANEL_WIDTH_MM,
  panelFaceHeightMm,
  SIXTHS_PER_U,
  sixthsToMm,
} from './geometry'
import { partKey } from './ids'
import {
  DEVICE_GAP_MM,
  fitDeviceInSlot,
  orientedDims,
  packAreaSlot,
  resolvePlaceable,
  type PackedDevice,
  type PackItem,
  type Placeable,
} from './placement'
import { evaluateCondition, type StackFacts } from './qty'
import {
  effectiveFrameSize,
  resolveOptionValues,
  sectionHeightU,
  sectionLabel,
  type OptionInput,
} from './recipe'
import {
  deviceName,
  withCustomEntries,
  type AssemblyRule,
  type CatalogLookup,
  type Corner,
  type Frame,
  type Item,
  type Slot,
} from './schema/catalog'
import type { Dims, OptionValues, Orientation, Vec3 } from './schema/common'
import type { PlacedDevice, Placement, PlacementBay, Plan, PlanSection } from './schema/plan'

/** Part keys of generic proxies. Catalog ids cannot contain "proxy:", so these never get a mesh. */
export const PROXY_PART_KEYS = {
  post: 'proxy:frame-post',
  connector: 'proxy:frame-connector',
  topPlate: 'proxy:frame-top',
  bottomPlate: 'proxy:frame-bottom',
  panel: 'proxy:panel',
  tray: 'proxy:tray',
  device: 'proxy:device',
} as const

// Generic proxy sizes (mm).
const POST_MM = 20
const PLATE_MM = 6
/** Connector slab thickness when the frame declares no joint gap. */
const CONNECTOR_MM = 4
const PANEL_MM = 4
const TRAY_MM = 3
/** A tray is this much narrower than the opening it sits in. */
const TRAY_MARGIN_MM = 10
/** Depth assumed when the plan's frame is not in the catalog. */
const UNKNOWN_FRAME_DEPTH_MM = 250
const UNKNOWN_DEVICE_DIMS: Dims = { w: 100, d: 100, h: 30 }
const ALL_CORNERS: readonly Corner[] = ['fl', 'fr', 'rl', 'rr']

// ---------------------------------------------------------------------------------------------
// 4×4 matrices, column-major like three.js Matrix4.elements

type Mat4 = readonly number[]

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]
}

function scaling(x: number, y: number, z: number): Mat4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]
}

const MIRROR_X = scaling(-1, 1, 1)
const MIRROR_Z = scaling(1, 1, -1)

function cosSin(degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180
  return [Math.cos(radians), Math.sin(radians)]
}

function rotationX(degrees: number): Mat4 {
  const [c, s] = cosSin(degrees)
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]
}

function rotationY(degrees: number): Mat4 {
  const [c, s] = cosSin(degrees)
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]
}

function rotationZ(degrees: number): Mat4 {
  const [c, s] = cosSin(degrees)
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const product: number[] = []
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] ?? 0) * (b[column * 4 + k] ?? 0)
      product.push(sum)
    }
  }
  return product
}

/** Product in reading order: the last matrix applies first. */
function compose(...matrices: readonly Mat4[]): Mat4 {
  return matrices.reduce(multiply, IDENTITY)
}

/** three.js 'XYZ' Euler angles in degrees (matrix Rx · Ry · Rz). */
function eulerXyz([x, y, z]: Vec3): Mat4 {
  return compose(rotationX(x), rotationY(y), rotationZ(z))
}

// ---------------------------------------------------------------------------------------------
// Instances

/** Rounds float noise away (3 × 44.45 = 133.35000000000002 -> 133.35) and turns -0 into 0. */
function clean(value: number): number {
  return Math.round(value * 1e9) / 1e9 || 0
}

interface InstanceSpec {
  key: string
  partKey: string
  matrix: Mat4
  state: PartState
  dims: Dims
  label: string
  sourceId: string
}

function instance(spec: InstanceSpec): PartInstance {
  return {
    key: spec.key,
    partKey: spec.partKey,
    matrix: spec.matrix.map(clean),
    state: spec.state,
    proxyDims: { w: clean(spec.dims.w), h: clean(spec.dims.h), d: clean(spec.dims.d) },
    label: spec.label,
    sourceId: spec.sourceId,
  }
}

function stateOf(owned: boolean): PartState {
  return owned ? 'have' : 'need'
}

// ---------------------------------------------------------------------------------------------
// Rack and stack layout

interface RackGeometry {
  panelWidthMm: number
  innerWidthMm: number
  earSpacingMm: number
  depthMm: number
  jointGapMm: number
}

function rackGeometry(frame: Frame | undefined, rackOptions: OptionInput): RackGeometry {
  if (frame === undefined) {
    return {
      panelWidthMm: PANEL_WIDTH_MM,
      innerWidthMm: NOMINAL_OPENING_MM,
      earSpacingMm: EIA_EAR_SPACING_MM,
      depthMm: UNKNOWN_FRAME_DEPTH_MM,
      jointGapMm: 0,
    }
  }
  const { depthMm, innerWidthMm } = effectiveFrameSize(frame, rackOptions)
  return {
    panelWidthMm: frame.standard.panelWidthMm,
    innerWidthMm,
    earSpacingMm: frame.rail.earSpacingMm,
    depthMm,
    jointGapMm: frame.stack.joint?.gapMm ?? 0,
  }
}

interface SectionLayout {
  section: PlanSection
  /** "Section 2 (6U)" (`sectionLabel`), as in stack messages and recipe provenance. */
  label: string
  bottomMm: number
  heightMm: number
}

interface JointLayout {
  lower: SectionLayout
  upper: SectionLayout
  label: string
  yMm: number
  /** `<lower id>/<upper id>`, as in BOM provenance. */
  sourceId: string
}

interface StackLayout {
  sections: SectionLayout[]
  joints: JointLayout[]
  topMm: number
  facts: StackFacts
}

function layoutStack(frame: Frame | undefined, sections: readonly PlanSection[]): StackLayout {
  let bottomSixths = 0
  let totalU = 0
  const spans = sections.map((section, index): SectionLayout => {
    // Unknown section types fall back to the height captured when the section was marked Have.
    const heightU =
      sectionHeightU(frame, section.typeId, section.heightU) || (section.have?.heightU ?? 0)
    const heightSixths = heightU * SIXTHS_PER_U
    const span = {
      section,
      label: sectionLabel(index, heightU),
      bottomMm: sixthsToMm(bottomSixths),
      heightMm: sixthsToMm(heightSixths),
    }
    bottomSixths += heightSixths
    totalU += heightU
    return span
  })
  const joints: JointLayout[] = []
  for (let index = 1; index < spans.length; index++) {
    const lower = spans[index - 1]
    const upper = spans[index]
    if (lower === undefined || upper === undefined) continue
    joints.push({
      lower,
      upper,
      label: `Joint ${index}`,
      yMm: upper.bottomMm,
      sourceId: `${lower.section.id}/${upper.section.id}`,
    })
  }
  return {
    sections: spans,
    joints,
    topMm: sixthsToMm(bottomSixths),
    facts: { u: totalU, sectionTypes: sections.map((section) => section.typeId) },
  }
}

function isRight(corner: Corner): boolean {
  return corner === 'fr' || corner === 'rr'
}

function isRear(corner: Corner): boolean {
  return corner === 'rl' || corner === 'rr'
}

function jointState(joint: JointLayout): PartState {
  return stateOf(joint.lower.section.have !== undefined && joint.upper.section.have !== undefined)
}

// ---------------------------------------------------------------------------------------------
// Frame: generic proxies

function genericFrameParts(layout: StackLayout, rack: RackGeometry, plan: Plan): PartInstance[] {
  const parts: PartInstance[] = []
  for (const span of layout.sections) {
    if (span.heightMm <= 0) continue
    for (const corner of ALL_CORNERS) {
      const x = ((isRight(corner) ? 1 : -1) * rack.earSpacingMm) / 2
      const z = isRear(corner) ? -rack.depthMm + POST_MM / 2 : -POST_MM / 2
      parts.push(
        instance({
          key: `section:${span.section.id}:post-${corner}`,
          partKey: PROXY_PART_KEYS.post,
          matrix: translation(x, span.bottomMm + span.heightMm / 2, z),
          state: stateOf(span.section.have !== undefined),
          dims: { w: POST_MM, h: span.heightMm, d: POST_MM },
          label: `${span.label} post`,
          sourceId: span.section.id,
        }),
      )
    }
  }
  for (const joint of layout.joints) {
    parts.push(
      instance({
        key: `joint:${joint.sourceId}:connector`,
        partKey: PROXY_PART_KEYS.connector,
        matrix: translation(0, joint.yMm, -rack.depthMm / 2),
        state: jointState(joint),
        dims: {
          w: rack.earSpacingMm + POST_MM,
          h: rack.jointGapMm > 0 ? rack.jointGapMm : CONNECTOR_MM,
          d: rack.depthMm,
        },
        label: `${joint.label} connector`,
        sourceId: joint.sourceId,
      }),
    )
  }
  if (layout.sections.length === 0) return parts
  const plate: Dims = { w: rack.innerWidthMm, h: PLATE_MM, d: rack.depthMm }
  const { top, bottom } = plan.frame.caps
  parts.push(
    instance({
      key: 'cap:top:plate',
      partKey: PROXY_PART_KEYS.topPlate,
      matrix: translation(0, layout.topMm + PLATE_MM / 2, -rack.depthMm / 2),
      state: stateOf(top.have !== undefined),
      dims: plate,
      label: 'Top plate',
      sourceId: 'top',
    }),
    instance({
      key: 'cap:bottom:plate',
      partKey: PROXY_PART_KEYS.bottomPlate,
      matrix: translation(0, -PLATE_MM / 2, -rack.depthMm / 2),
      state: stateOf(bottom.have !== undefined),
      dims: plate,
      label: 'Bottom plate',
      sourceId: 'bottom',
    }),
  )
  return parts
}

// ---------------------------------------------------------------------------------------------
// Frame: assembly3d rules

/** A unit a rule places parts on: a section, a joint or a cap. */
interface Anchor {
  keyPrefix: string
  sourceId: string
  yMm: number
  state: PartState
  /** Resolved option values for the rule's `when` (same layering as the recipe). */
  options: OptionValues
}

function hasAssemblyRules(frame: Frame): boolean {
  return (frame.parts3d?.length ?? 0) > 0 && (frame.assembly3d?.length ?? 0) > 0
}

/**
 * Units a rule applies to. `sectionTypes` filters sections; a joint qualifies when either
 * neighbour has a listed type, a cap when the end section next to it does.
 */
function anchorsFor(rule: AssemblyRule, frame: Frame, layout: StackLayout, plan: Plan): Anchor[] {
  const listed = (typeId: string): boolean =>
    rule.sectionTypes === undefined || rule.sectionTypes.includes(typeId)
  const rackOptions = plan.frame.options
  switch (rule.at) {
    case 'section':
      return layout.sections
        .filter((span) => listed(span.section.typeId))
        .map((span) => ({
          keyPrefix: `section:${span.section.id}`,
          sourceId: span.section.id,
          yMm: span.bottomMm,
          state: stateOf(span.section.have !== undefined),
          options: resolveOptionValues(frame.options, rackOptions, span.section.options),
        }))
    case 'joint':
      return layout.joints
        .filter((joint) => listed(joint.lower.section.typeId) || listed(joint.upper.section.typeId))
        .map((joint) => ({
          keyPrefix: `joint:${joint.sourceId}`,
          sourceId: joint.sourceId,
          yMm: joint.yMm,
          state: jointState(joint),
          options: resolveOptionValues(frame.options, rackOptions),
        }))
    case 'top':
    case 'bottom': {
      const end = rule.at === 'top' ? layout.sections.at(-1) : layout.sections[0]
      if (end === undefined || !listed(end.section.typeId)) return []
      const cap = plan.frame.caps[rule.at]
      return [
        {
          keyPrefix: `cap:${rule.at}`,
          sourceId: rule.at,
          yMm: rule.at === 'top' ? layout.topMm : 0,
          state: stateOf(cap.have !== undefined),
          options: resolveOptionValues(frame.options, rackOptions, cap.options),
        },
      ]
    }
    case 'item':
      // A frame rule cannot be placed per item (checkEntryIntegrity reports it).
      return []
  }
}

/**
 * Transform of a rule's part at a corner. The rule describes the front-left instance (offset and
 * rotation, with the envelope's bottom centre on the corner point); the other corners are its
 * mirror images across the rack's centre planes, so an offset that points inward at the front
 * left points inward everywhere. Mirror images are turned back into rigid copies (det > 0),
 * except on the right side when the rule sets `mirrorX`: those use the mirrored part.
 */
function cornerMatrix(
  local: Mat4,
  corner: Corner,
  yMm: number,
  rack: RackGeometry,
  mirrorX: boolean,
): Mat4 {
  const right = isRight(corner)
  const rear = isRear(corner)
  const reflectDepth = compose(translation(0, 0, -rack.depthMm), MIRROR_Z)
  const frontLeft = compose(translation(-rack.earSpacingMm / 2, yMm, 0), local)
  return compose(
    right ? MIRROR_X : IDENTITY,
    rear ? reflectDepth : IDENTITY,
    frontLeft,
    rear ? MIRROR_Z : IDENTITY,
    right && !mirrorX ? MIRROR_X : IDENTITY,
  )
}

function ruleFrameParts(
  frame: Frame,
  layout: StackLayout,
  rack: RackGeometry,
  plan: Plan,
): PartInstance[] {
  const parts: PartInstance[] = []
  for (const [ruleIndex, rule] of (frame.assembly3d ?? []).entries()) {
    const part = frame.parts3d?.find((candidate) => candidate.id === rule.partId)
    // A rule for an unknown part is a catalog error (checkEntryIntegrity); nothing to draw.
    if (part === undefined) continue
    const [dx, dy, dz] = rule.transform?.offsetMm ?? [0, 0, 0]
    const local = compose(
      translation(dx, dy, dz),
      eulerXyz(rule.transform?.rotDeg ?? [0, 0, 0]),
      translation(0, part.envelopeMm.h / 2, 0),
    )
    const mirrorX = rule.transform?.mirrorX === true
    for (const anchor of anchorsFor(rule, frame, layout, plan)) {
      if (!evaluateCondition(rule.when, { options: anchor.options, stack: layout.facts })) continue
      const placed =
        rule.corners === undefined
          ? [{ suffix: 'centre', matrix: compose(translation(0, anchor.yMm, 0), local) }]
          : rule.corners.map((corner) => ({
              suffix: corner,
              matrix: cornerMatrix(local, corner, anchor.yMm, rack, mirrorX),
            }))
      for (const { suffix, matrix } of placed) {
        parts.push(
          instance({
            key: `${anchor.keyPrefix}:rule-${ruleIndex}-${suffix}`,
            partKey: partKey(frame.id, part.id),
            matrix,
            state: anchor.state,
            dims: part.envelopeMm,
            label: part.label,
            sourceId: anchor.sourceId,
          }),
        )
      }
    }
  }
  return parts
}

// ---------------------------------------------------------------------------------------------
// Placements. Sizes, orientations and slot packing follow the placement engine (placement.ts),
// so the 3D view shows exactly what the occupancy and fit checks assume.

/** A placement's opening (where trays and devices go) and panel, in world X. */
interface BaySpace {
  openingLeftMm: number
  openingWidthMm: number
  panelCentreMm: number
  panelWidthMm: number
}

function baySpace(bay: PlacementBay, rack: RackGeometry): BaySpace {
  const halfOpening = rack.innerWidthMm / 2
  switch (bay) {
    case 'full':
      return {
        openingLeftMm: -halfOpening,
        openingWidthMm: rack.innerWidthMm,
        panelCentreMm: 0,
        panelWidthMm: rack.panelWidthMm,
      }
    case 'left':
      return {
        openingLeftMm: -halfOpening,
        openingWidthMm: halfOpening,
        panelCentreMm: -rack.panelWidthMm / 4,
        panelWidthMm: rack.panelWidthMm / 2,
      }
    case 'right':
      return {
        openingLeftMm: 0,
        openingWidthMm: halfOpening,
        panelCentreMm: rack.panelWidthMm / 4,
        panelWidthMm: rack.panelWidthMm / 2,
      }
  }
}

/**
 * The item frame that slot layouts are relative to: origin at the left edge of the opening, the
 * item's bottom and the rail face it mounts on, +Z out of its front. Rear items face backwards,
 * so their frame is turned 180° about Y.
 */
function itemFrame(placement: Placement, bay: BaySpace, rack: RackGeometry): Mat4 {
  const yMm = sixthsToMm(placement.y)
  if (placement.face === 'front') return translation(bay.openingLeftMm, yMm, 0)
  return compose(
    translation(bay.openingLeftMm + bay.openingWidthMm, yMm, -rack.depthMm),
    rotationY(180),
  )
}

/** World X -> item-frame X (the rear frame runs right to left). */
function itemX(worldX: number, placement: Placement, bay: BaySpace): number {
  return placement.face === 'front'
    ? worldX - bay.openingLeftMm
    : bay.openingLeftMm + bay.openingWidthMm - worldX
}

function isTrayStyle(item: Item): boolean {
  return item.render?.style === 'shelf' || item.render?.style === 'tray'
}

/** Proper rotations (no mirroring) that turn a device's box into `orientedDims` in rack axes. */
const ORIENTATION_ROTATIONS: Record<Orientation, Mat4> = {
  flat: IDENTITY,
  'flat-rotated': rotationY(90),
  'on-side': rotationZ(90),
  upright: rotationX(90),
}

/** A device's place in its slot: left edge from the slot origin, and its orientation. */
interface DeviceSpot {
  placed: PlacedDevice
  dims: Dims
  label: string
  slot: Slot
  orientation: Orientation
  leftMm: number
}

/** The whole opening as an area slot, for devices whose item or slot is unknown. */
function openingSlot(slotId: string, bay: BaySpace, depthMm: number): Slot {
  return {
    id: slotId,
    kind: 'area',
    maxW: bay.openingWidthMm,
    maxD: depthMm,
    orientations: ['flat'],
    layout: { xMm: 0, yMm: 0, zMm: 0 },
  }
}

function placeholderDims(slot: Slot): Dims {
  return {
    w: Math.min(UNKNOWN_DEVICE_DIMS.w, slot.maxW),
    d: Math.min(UNKNOWN_DEVICE_DIMS.d, slot.maxD),
    h: Math.min(UNKNOWN_DEVICE_DIMS.h, slot.maxH ?? UNKNOWN_DEVICE_DIMS.h),
  }
}

/**
 * Spots for the devices in one slot. A device's own orientation wins, as in the occupancy check;
 * otherwise the first allowed orientation that fits. A fixed slot centres its device. An area slot
 * packs with `packAreaSlot`; a device's own `xMm` wins, and devices the packer skips (too wide,
 * not accepted, unknown) line up after the packed ones.
 */
function slotSpots(
  slot: Slot,
  placed: readonly PlacedDevice[],
  lookup: CatalogLookup,
): DeviceSpot[] {
  const devices = new Map(placed.map((entry) => [entry.id, lookup.device(entry.deviceId)]))
  const items: PackItem[] = placed.flatMap((entry) => {
    const device = devices.get(entry.id)
    return device === undefined ? [] : [{ id: entry.id, device, orientation: entry.orientation }]
  })
  const positions = new Map<string, PackedDevice>()
  if (slot.kind === 'area') {
    for (const position of packAreaSlot(items, slot).positions) positions.set(position.id, position)
  }
  let nextFreeMm = 0
  for (const position of positions.values()) {
    const device = devices.get(position.id)
    const widthMm = device === undefined ? 0 : orientedDims(device.dims, position.orientation).w
    nextFreeMm = Math.max(nextFreeMm, position.xMm + widthMm + DEVICE_GAP_MM)
  }
  return placed.map((entry) => {
    const device = devices.get(entry.id)
    const dims = device?.dims ?? placeholderDims(slot)
    const position = positions.get(entry.id)
    const fitted = device === undefined ? undefined : fitDeviceInSlot(device, slot).orientation
    const orientation =
      entry.orientation ?? position?.orientation ?? fitted ?? slot.orientations[0] ?? 'flat'
    const widthMm = orientedDims(dims, orientation).w
    let leftMm = (slot.maxW - widthMm) / 2
    if (slot.kind === 'area') {
      leftMm = entry.xMm ?? position?.xMm ?? nextFreeMm
      if (entry.xMm === undefined && position === undefined) nextFreeMm += widthMm + DEVICE_GAP_MM
    }
    const label = device ? deviceName(device) : `Unknown device "${entry.deviceId}"`
    return { placed: entry, dims, label, slot, orientation, leftMm }
  })
}

/** Spots for every device of a placement, in the placement's device order. */
function deviceSpots(
  placement: Placement,
  placeable: Placeable | undefined,
  bay: BaySpace,
  rack: RackGeometry,
  lookup: CatalogLookup,
): DeviceSpot[] {
  const bySlot = new Map<string, PlacedDevice[]>()
  for (const placed of placement.devices) {
    const group = bySlot.get(placed.slotId)
    if (group === undefined) bySlot.set(placed.slotId, [placed])
    else group.push(placed)
  }
  const depthMm =
    placeable !== undefined && placeable.depthMm > 0 ? placeable.depthMm : rack.depthMm
  const spots = new Map<PlacedDevice, DeviceSpot>()
  for (const [slotId, group] of bySlot) {
    const slot =
      placeable?.slots.find((candidate) => candidate.id === slotId) ??
      openingSlot(slotId, bay, depthMm)
    for (const spot of slotSpots(slot, group, lookup)) spots.set(spot.placed, spot)
  }
  return placement.devices.flatMap((placed) => spots.get(placed) ?? [])
}

function placementParts(
  placement: Placement,
  lookup: CatalogLookup,
  rack: RackGeometry,
): PartInstance[] {
  const placeable = resolvePlaceable(lookup, placement.itemId)
  const name = placeable?.name ?? placement.name ?? placement.itemId
  // An unknown entry draws from its denormalized height, or as 1U when even that is missing.
  const heightSixths = placeable?.heightSixths ?? (placement.heightSixths || SIXTHS_PER_U)
  const nominalMm = sixthsToMm(heightSixths)
  const bay = baySpace(placement.bay, rack)
  const frame = itemFrame(placement, bay, rack)
  const keyPrefix = `placement:${placement.id}`
  const parts: PartInstance[] = []
  const add = (suffix: string, proxyKey: string, local: Mat4, dims: Dims, label: string): void => {
    parts.push(
      instance({
        key: `${keyPrefix}:${suffix}`,
        partKey: proxyKey,
        matrix: compose(frame, local),
        state: stateOf(placement.have !== undefined),
        dims,
        label,
        sourceId: placement.id,
      }),
    )
  }

  if (heightSixths > 0) {
    add(
      'panel',
      PROXY_PART_KEYS.panel,
      translation(itemX(bay.panelCentreMm, placement, bay), nominalMm / 2, PANEL_MM / 2),
      { w: bay.panelWidthMm, h: panelFaceHeightMm(heightSixths), d: PANEL_MM },
      placement.label ? `${placement.label} (${name})` : name,
    )
  }

  const item = lookup.item(placement.itemId)
  if (item !== undefined && isTrayStyle(item) && item.depthMm > 0) {
    add(
      'tray',
      PROXY_PART_KEYS.tray,
      translation(bay.openingWidthMm / 2, TRAY_MM / 2, -item.depthMm / 2),
      { w: Math.max(0, bay.openingWidthMm - TRAY_MARGIN_MM), h: TRAY_MM, d: item.depthMm },
      `${name} tray`,
    )
  }

  // Ear-mounted gear placed directly (device.rackmount): its body sits behind the panel.
  const gear = placeable?.source === 'rackmount' ? lookup.device(placement.itemId) : undefined
  if (gear !== undefined && placeable !== undefined && placeable.depthMm > 0) {
    const body: Dims = {
      w: Math.min(gear.dims.w, bay.openingWidthMm),
      h: Math.min(gear.dims.h, nominalMm),
      d: placeable.depthMm,
    }
    const centre = translation(bay.openingWidthMm / 2, nominalMm / 2, -body.d / 2)
    add('body', PROXY_PART_KEYS.device, centre, body, name)
  }

  for (const spot of deviceSpots(placement, placeable, bay, rack, lookup)) {
    const { layout } = spot.slot
    const size = orientedDims(spot.dims, spot.orientation)
    const centre = translation(
      layout.xMm + spot.leftMm + size.w / 2,
      layout.yMm + size.h / 2,
      layout.zMm - size.d / 2,
    )
    parts.push(
      instance({
        key: `${keyPrefix}:device:${spot.placed.id}`,
        partKey: PROXY_PART_KEYS.device,
        matrix: compose(frame, centre, ORIENTATION_ROTATIONS[spot.orientation]),
        state: stateOf(spot.placed.have),
        dims: spot.dims,
        label: spot.label,
        sourceId: placement.id,
      }),
    )
  }
  return parts
}

// ---------------------------------------------------------------------------------------------

/**
 * Part instances for a plan: frame parts first (generic proxies section by section, then joints
 * and caps; rule parts in rule order), then each placement's panel, tray (or rack-mount gear
 * body) and devices in plan order. Unknown catalog ids never throw: they draw as generic proxies
 * or labelled placeholders.
 */
export const assemble: Assemble = (plan, catalog) => {
  const lookup = withCustomEntries(catalog, plan.custom)
  const frame = lookup.frame(plan.frame.frameId)
  const rack = rackGeometry(frame, plan.frame.options)
  const layout = layoutStack(frame, plan.frame.sections)
  const frameParts =
    frame !== undefined && hasAssemblyRules(frame)
      ? ruleFrameParts(frame, layout, rack, plan)
      : genericFrameParts(layout, rack, plan)
  const placements = plan.placements.flatMap((placement) => placementParts(placement, lookup, rack))
  return [...frameParts, ...placements]
}
