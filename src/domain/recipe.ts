/**
 * Recipe expansion: turns a frame stack (or a placed item) into unrounded print and hardware
 * lines with provenance. These are the BOM inputs; bom.ts aggregates them by `lineKey` and rounds.
 */
import { formatU, sixthsToU, uToSixths } from './geometry'
import { hardwareKey, printKey, roundCutLengthMm } from './ids'
import {
  evaluateCondition,
  evaluateLength,
  evaluateQty,
  jointPasses,
  type ConditionContext,
  type Joint,
  type QtyContext,
  type StackFacts,
} from './qty'
import {
  isValidOptionValue,
  optionDefault,
  type Frame,
  type Item,
  type Option,
  type OptionEffects,
  type PrintGroup,
  type RecipeLine,
  type RecipeRole,
  type RecipeUnit,
} from './schema/catalog'
import type { OptionValue, OptionValues, Qty } from './schema/common'
import type { PlanFrame } from './schema/plan'

/** Option values as stored on a plan or snapshot. Unknown ids and invalid values are ignored. */
export type OptionInput = Readonly<Record<string, unknown>>

export interface FrameConfigSection {
  id: string
  typeId: string
  heightU: number
  options: OptionInput
}

export interface CapConfig {
  present: boolean
  options: OptionInput
}

/**
 * A frame stack to expand (the planned target, or the as-built stack from Have snapshots).
 *
 * Option layers, lowest priority first: the option's default, then `rackOptions`, then the unit's
 * own options (a section's, the top cap's or the bottom cap's). Rack and joint lines see the
 * rack layer only.
 */
export interface FrameConfig {
  /** Bottom -> top. */
  sections: readonly FrameConfigSection[]
  rackOptions: OptionInput
  top: CapConfig
  bottom: CapConfig
}

export interface LineProvenance {
  /** "Rack", "Top", "Bottom", "Section 2 (6U)", "Joint 1 (3U / 6U)", or the item name. */
  unitLabel: string
  /** Section id, 'top' | 'bottom', `<lower id>/<upper id>` for a joint, or the item instance id. */
  unitId?: string
  /** How the quantity came about: "16 per section", "embedded in 6U leg: 18 per print × 4". */
  detail: string
  qty: number
}

/** One contribution of one recipe line in one unit (not aggregated: see `sumByLineKey`). */
export interface ExpandedLine {
  lineKey: string
  kind: 'print' | 'hardware'
  /** Print group id (local to `ownerId`) or hardware catalog id. */
  refId: string
  /** Unrounded. */
  qty: number
  unit: RecipeUnit
  role: RecipeRole
  /** False for embedded hardware, which is locked inside its print. */
  reusable: boolean
  provenance: LineProvenance[]
  cutLengthMm?: number
  /** Frame or item id that owns the recipe and its print groups. */
  ownerId: string
  recipeLineId: string
  /** Set on embedded hardware: the print it goes into and how many per print. */
  embeddedIn?: { printKey: string; printId: string; perPrint: number }
}

// ---------------------------------------------------------------------------------------------
// Options

/**
 * Value of every declared option: the default, overridden by each layer in turn (lowest priority
 * first). Values of the wrong type or unknown choices are skipped, so stale plans still resolve.
 */
export function resolveOptionValues(
  options: readonly Option[],
  ...layers: ReadonlyArray<OptionInput | undefined>
): OptionValues {
  const resolved: OptionValues = {}
  for (const option of options) {
    let value = optionDefault(option)
    for (const layer of layers) {
      const candidate = layer?.[option.id]
      if (isValidOptionValue(option, candidate)) value = candidate
    }
    resolved[option.id] = value
  }
  return resolved
}

function activeEffects(option: Option, value: OptionValue | undefined): OptionEffects | undefined {
  if (option.kind === 'boolean') return value === true ? option.effects : undefined
  return option.choices?.find((choice) => choice.id === value)?.effects
}

/** Geometry effects of true boolean options and selected choices; later options win. */
export function optionEffects(
  options: readonly Option[],
  ...layers: ReadonlyArray<OptionInput | undefined>
): OptionEffects {
  const values = resolveOptionValues(options, ...layers)
  const effects: OptionEffects = {}
  for (const option of options) Object.assign(effects, activeEffects(option, values[option.id]))
  return effects
}

export interface FrameSize {
  depthMm: number
  innerWidthMm: number
}

/** A frame's depth and opening after the rack-wide option effects (e.g. 320 mm-deep connectors). */
export function effectiveFrameSize(frame: Frame, rackOptions: OptionInput | undefined): FrameSize {
  const effects = optionEffects(frame.options, rackOptions)
  return {
    depthMm: effects.depthMm ?? frame.standard.depthMm,
    innerWidthMm: effects.innerWidthMm ?? frame.standard.innerWidthMm,
  }
}

// ---------------------------------------------------------------------------------------------
// Stack helpers

/** Height of a section: the plan's own height for range types, else the type's fixed height. */
export function sectionHeightU(frame: Frame | undefined, typeId: string, heightU?: number): number {
  if (heightU !== undefined) return heightU
  const type = frame?.sectionTypes.find((candidate) => candidate.id === typeId)
  if (type === undefined) return 0
  return typeof type.heightU === 'number' ? type.heightU : type.heightU.min
}

/** "Section 2 (6U)" for the section at `index` (0 = bottom): one wording for messages and labels. */
export function sectionLabel(index: number, heightU: number): string {
  return `Section ${index + 1} (${formatU(uToSixths(heightU))})`
}

/** The planned (target) configuration of a plan's frame. Caps exist whenever there are sections. */
export function frameConfigFromPlan(planFrame: PlanFrame, frame: Frame): FrameConfig {
  const sections = planFrame.sections.map((section) => ({
    id: section.id,
    typeId: section.typeId,
    heightU: sectionHeightU(frame, section.typeId, section.heightU),
    options: section.options ?? {},
  }))
  const present = sections.length > 0
  return {
    sections,
    rackOptions: planFrame.options,
    top: { present, options: planFrame.caps.top.options ?? {} },
    bottom: { present, options: planFrame.caps.bottom.options ?? {} },
  }
}

/** Total quantity per line key. */
export function sumByLineKey(lines: readonly ExpandedLine[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const line of lines) totals.set(line.lineKey, (totals.get(line.lineKey) ?? 0) + line.qty)
  return totals
}

// ---------------------------------------------------------------------------------------------
// Expansion

interface Scope {
  unit: RecipeUnit
  unitLabel: string
  unitId?: string
  conditions: ConditionContext
  qty: QtyContext
}

interface RecipeOwner {
  id: string
  prints: readonly PrintGroup[]
}

type TypeLabel = (typeId: string) => string

const typeIdAsLabel: TypeLabel = (typeId) => typeId

const PER_UNIT: Record<RecipeUnit, string> = {
  rack: ' per rack',
  top: '',
  bottom: '',
  section: ' per section',
  joint: ' per joint',
  item: ' per item',
}

/** A quantity for provenance text: at most 3 decimals ("16", "0.333"). */
export function formatCount(value: number): string {
  return String(Math.round(value * 1000) / 1000)
}

function describeQty(qty: Qty, unit: RecipeUnit, typeLabel: TypeLabel): string {
  if (typeof qty === 'number') return `${formatCount(qty)}${PER_UNIT[unit]}`
  const terms: string[] = []
  if (qty.base) terms.push(formatCount(qty.base))
  if (qty.perU) terms.push(`${formatCount(qty.perU)} per U`)
  for (const [typeId, each] of Object.entries(qty.perSection ?? {})) {
    if (each) terms.push(`${formatCount(each)} per ${typeLabel(typeId)}`)
  }
  if (qty.perSectionAny) terms.push(`${formatCount(qty.perSectionAny)} per section`)
  if (qty.perJoint) terms.push(`${formatCount(qty.perJoint)} per joint`)
  return terms.length > 0 ? terms.join(' + ') : '0'
}

function expandPrint(
  owner: RecipeOwner,
  line: RecipeLine,
  printId: string,
  prints: number,
  scope: Scope,
  detail: string,
): ExpandedLine[] {
  const key = printKey(owner.id, printId)
  const where = { unitLabel: scope.unitLabel, unitId: scope.unitId }
  const printLine: ExpandedLine = {
    lineKey: key,
    kind: 'print',
    refId: printId,
    qty: prints,
    unit: scope.unit,
    role: line.role,
    reusable: line.role !== 'embedded',
    provenance: [{ ...where, detail, qty: prints }],
    ownerId: owner.id,
    recipeLineId: line.id,
  }
  const group = owner.prints.find((print) => print.id === printId)
  const embedded: ExpandedLine[] = []
  for (const embed of group?.embeds ?? []) {
    if (!evaluateCondition(embed.when, scope.conditions)) continue
    const qty = prints * embed.perPrint
    if (!(qty > 0)) continue
    const perPrint = `${formatCount(embed.perPrint)} per print × ${formatCount(prints)}`
    const embedDetail = `embedded in ${group?.label ?? printId}: ${perPrint}`
    embedded.push({
      lineKey: hardwareKey(embed.hardwareId),
      kind: 'hardware',
      refId: embed.hardwareId,
      qty,
      unit: scope.unit,
      role: 'embedded',
      reusable: false,
      provenance: [{ ...where, detail: embedDetail, qty }],
      ownerId: owner.id,
      recipeLineId: line.id,
      embeddedIn: { printKey: key, printId, perPrint: embed.perPrint },
    })
  }
  return [printLine, ...embedded]
}

function expandLine(
  owner: RecipeOwner,
  line: RecipeLine,
  scope: Scope,
  typeLabel: TypeLabel,
): ExpandedLine[] {
  if (!evaluateCondition(line.when, scope.conditions)) return []
  const qty = evaluateQty(line.count, scope.qty)
  if (!(qty > 0)) return []
  const detail = line.note ?? describeQty(line.count, scope.unit, typeLabel)
  if ('print' in line.ref) return expandPrint(owner, line, line.ref.print, qty, scope, detail)

  const cutLengthMm = line.length
    ? roundCutLengthMm(evaluateLength(line.length, scope.qty))
    : undefined
  return [
    {
      lineKey: hardwareKey(line.ref.hardware, cutLengthMm),
      kind: 'hardware',
      refId: line.ref.hardware,
      qty,
      unit: scope.unit,
      role: line.role,
      reusable: line.role !== 'embedded',
      provenance: [{ unitLabel: scope.unitLabel, unitId: scope.unitId, detail, qty }],
      ...(cutLengthMm === undefined ? {} : { cutLengthMm }),
      ownerId: owner.id,
      recipeLineId: line.id,
    },
  ]
}

function countByType(typeIds: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const typeId of typeIds) counts[typeId] = (counts[typeId] ?? 0) + 1
  return counts
}

function adjacentPairs<T>(items: readonly T[]): Array<readonly [T, T]> {
  const pairs: Array<readonly [T, T]> = []
  for (let index = 1; index < items.length; index++) {
    const lower = items[index - 1]
    const upper = items[index]
    if (lower !== undefined && upper !== undefined) pairs.push([lower, upper])
  }
  return pairs
}

function heightLabel(heightU: number): string {
  return formatU(uToSixths(heightU))
}

interface JointScope {
  joint: Joint
  scope: Scope
}

/**
 * Expands a frame recipe for a stack. Per unit:
 * - rack: once when there is at least one section (whole-stack quantity context)
 * - top / bottom: once when the cap is present (whole-stack quantity context)
 * - section: once per section (u = section height, sectionCounts = { its type: 1 })
 * - joint: once per adjacent pair that passes the line's `jointFilter`
 *   (u = 0, sectionCounts = the two neighbours, joints = [that pair])
 * Conditions always see the whole stack (height, section types bottom -> top).
 */
export function expandFrameRecipe(frame: Frame, config: FrameConfig): ExpandedLine[] {
  const { sections } = config
  const typeIds = sections.map((section) => section.typeId)
  const stack: StackFacts = {
    u: sections.reduce((total, section) => total + section.heightU, 0),
    sectionTypes: typeIds,
  }
  const pairs = adjacentPairs(sections)
  const wholeStack: QtyContext = {
    u: stack.u,
    sectionCounts: countByType(typeIds),
    sectionCountAny: sections.length,
    joints: pairs.map(([lower, upper]) => [lower.typeId, upper.typeId] as const),
  }
  const rackValues = resolveOptionValues(frame.options, config.rackOptions)
  const typeLabel: TypeLabel = (typeId) =>
    frame.sectionTypes.find((type) => type.id === typeId)?.label ?? typeId

  const rackScope: Scope = {
    unit: 'rack',
    unitLabel: 'Rack',
    conditions: { options: rackValues, stack },
    qty: wholeStack,
  }
  const capScope = (unit: 'top' | 'bottom', cap: CapConfig): Scope => ({
    unit,
    unitLabel: unit === 'top' ? 'Top' : 'Bottom',
    unitId: unit,
    conditions: {
      options: resolveOptionValues(frame.options, config.rackOptions, cap.options),
      stack,
    },
    qty: wholeStack,
  })
  const sectionScopes = sections.map((section, index): Scope => ({
    unit: 'section',
    unitLabel: sectionLabel(index, section.heightU),
    unitId: section.id,
    conditions: {
      options: resolveOptionValues(frame.options, config.rackOptions, section.options),
      stack,
    },
    qty: {
      u: section.heightU,
      sectionCounts: { [section.typeId]: 1 },
      sectionCountAny: 1,
      joints: [],
    },
  }))
  const jointScopes = pairs.map(([lower, upper], index): JointScope => {
    const joint: Joint = [lower.typeId, upper.typeId]
    const heights = `${heightLabel(lower.heightU)} / ${heightLabel(upper.heightU)}`
    return {
      joint,
      scope: {
        unit: 'joint',
        unitLabel: `Joint ${index + 1} (${heights})`,
        unitId: `${lower.id}/${upper.id}`,
        conditions: { options: rackValues, stack },
        qty: { u: 0, sectionCounts: countByType(joint), sectionCountAny: 2, joints: [joint] },
      },
    }
  })

  const scopesFor = (line: RecipeLine): Scope[] => {
    switch (line.unit) {
      case 'rack':
        return sections.length > 0 ? [rackScope] : []
      case 'top':
        return config.top.present ? [capScope('top', config.top)] : []
      case 'bottom':
        return config.bottom.present ? [capScope('bottom', config.bottom)] : []
      case 'section':
        return sectionScopes
      case 'joint': {
        const filter = typeof line.count === 'number' ? undefined : line.count.jointFilter
        return jointScopes
          .filter(({ joint }) => jointPasses(joint, filter))
          .map(({ scope }) => scope)
      }
      case 'item':
        // Item lines belong to items; a frame has nothing to count them per.
        return []
    }
  }

  return frame.recipe.flatMap((line) =>
    scopesFor(line).flatMap((scope) => expandLine(frame, line, scope, typeLabel)),
  )
}

/**
 * Expands an item's recipe for one placed instance (or one extra). Only `item` lines apply:
 * u = item height, no sections or joints. Line keys use the item id, so identical items aggregate;
 * `instanceId` (placement or extra id) is recorded in provenance only.
 */
export function expandItemRecipe(
  item: Item,
  options: OptionInput = {},
  instanceId?: string,
): ExpandedLine[] {
  const u = sixthsToU(item.heightSixths)
  const scope: Scope = {
    unit: 'item',
    unitLabel: item.name,
    unitId: instanceId,
    conditions: {
      options: resolveOptionValues(item.options, options),
      stack: { u, sectionTypes: [] },
    },
    qty: { u, sectionCounts: {}, sectionCountAny: 0, joints: [] },
  }
  return item.recipe
    .filter((line) => line.unit === 'item')
    .flatMap((line) => expandLine(item, line, scope, typeIdAsLabel))
}
