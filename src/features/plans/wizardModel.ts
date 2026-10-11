/**
 * The New plan wizard as plain state and pure functions (no React): the frame, the stack of
 * sections (bottom -> top) with Have/Need, the frame's options answered per scope, the goal and the
 * name. `buildPlanFromWizard` turns the answers into a schema-1 plan through the domain's own stack
 * operations (`markSection`, `setHeight`), so the wizard and the editor agree on snapshots and on
 * which heights are reachable.
 */
import { composeHeight, listNames, markSection, setHeight, type StackEnd } from '@/domain/frame'
import { uNumberAt, uToSixths } from '@/domain/geometry'
import { ID_PREFIX, newId } from '@/domain/ids'
import { resolveOptionValues, sectionHeightU } from '@/domain/recipe'
import {
  isValidOptionValue,
  optionDefault,
  type CatalogLookup,
  type Frame,
  type Option,
  type SectionType,
} from '@/domain/schema/catalog'
import { isCustomId, type OptionValue, type OptionValues } from '@/domain/schema/common'
import {
  PLAN_SCHEMA_VERSION,
  PlanSchema,
  type CapState,
  type Plan,
  type PlanSection,
  type Snapshot,
} from '@/domain/schema/plan'

export type { StackEnd } from '@/domain/frame'

/** record: "Record my rack and plan an upgrade"; new: "Plan a new rack". */
export type WizardMode = 'record' | 'new'

/** `start` is the choice the New plan button opens on; the numbered steps follow it. */
export type WizardStep = 'start' | 'frame' | 'stack' | 'finish'
export type NumberedStep = Exclude<WizardStep, 'start'>
export const WIZARD_STEPS: readonly NumberedStep[] = ['frame', 'stack', 'finish']

/** Same limit as `PlanSchema.name` and `validPlanName` in the plans repository. */
export const MAX_PLAN_NAME_LENGTH = 200
/** Starting height of a section whose type has a height range (a generic 10" rack). */
const DEFAULT_RANGE_HEIGHT_U = 6

export interface WizardSection {
  /** Stable key for lists and focus. Plan section ids are made when the plan is built. */
  key: string
  typeId: string
  /** The chosen height, for section types with a height range. */
  heightU?: number
  /** Already built (Recording mode); new racks are all planned. */
  have: boolean
}

export type WizardGoal = { kind: 'none' } | { kind: 'target-height'; targetU: number; at: StackEnd }

/** Option scopes the wizard asks about; item options belong to placed items, not the frame. */
export type WizardOptionScope = 'rack' | 'top' | 'bottom' | 'section'
export const WIZARD_OPTION_SCOPES: readonly WizardOptionScope[] = [
  'rack',
  'top',
  'bottom',
  'section',
]

export interface WizardState {
  mode: WizardMode
  frameId?: string
  /** Bottom -> top. */
  sections: WizardSection[]
  /** Answers per scope; missing answers mean the option's default. */
  options: Record<WizardOptionScope, OptionValues>
  /** Undefined until chosen: then the default goal applies (see `defaultGoal`). */
  goal?: WizardGoal
  /** The user's own name; undefined while the suggested name is used. */
  name?: string
  /** Source of section keys (kept in the state so every function stays pure). */
  nextKey: number
}

export function initialWizardState(mode: WizardMode): WizardState {
  return { mode, sections: [], options: emptyAnswers(), nextKey: 1 }
}

function emptyAnswers(): Record<WizardOptionScope, OptionValues> {
  return { rack: {}, top: {}, bottom: {}, section: {} }
}

// ---------------------------------------------------------------------------------------------
// Frames and section types

function isRangeType(type: SectionType): boolean {
  return typeof type.heightU !== 'number'
}

function fixedHeight(type: SectionType): number {
  return typeof type.heightU === 'number' ? type.heightU : type.heightU.min
}

/** Fixed-height section types, in catalog order. */
export function fixedSectionTypes(frame: Frame): SectionType[] {
  return frame.sectionTypes.filter((type) => !isRangeType(type))
}

/**
 * A frame built as one piece of a chosen height (every section type has a height range, like the
 * generic 10" rack): the stack is exactly one section and the wizard asks for its height.
 */
export function isOnePieceFrame(frame: Frame): boolean {
  return frame.sectionTypes.every(isRangeType)
}

function defaultHeightFor(type: SectionType): number | undefined {
  if (typeof type.heightU === 'number') return undefined
  const { min, max } = type.heightU
  return Math.min(max, Math.max(min, DEFAULT_RANGE_HEIGHT_U))
}

function findType(frame: Frame, typeId: string): SectionType | undefined {
  return frame.sectionTypes.find((type) => type.id === typeId)
}

/** "3U and 6U sections, 3U to 30U" or "2U to 22U": what a frame can be built as. */
export function frameSizesText(frame: Frame): string {
  const range = `${frame.stack.minU}U to ${frame.stack.maxU}U`
  const fixed = fixedSectionTypes(frame).map((type) => `${fixedHeight(type)}U`)
  return fixed.length === 0 ? range : `${listNames(fixed)} sections, ${range}`
}

// ---------------------------------------------------------------------------------------------
// Presets

export interface StackPreset {
  /** Type ids joined with "+", bottom first. */
  id: string
  /** Bottom -> top. */
  typeIds: string[]
  /** "3U + 6U" (bottom first, like the plan summaries). */
  label: string
  /** "3U at the bottom, 6U on top". */
  description: string
}

/**
 * Quick starts for frames built from fixed sections: each section alone and each ordered pair,
 * except pairs that a single section of the same height replaces (3U + 3U on a frame with 6U
 * sections). KWS: 3U, 6U, 3U + 6U, 6U + 3U, 6U + 6U. One-piece frames have none.
 */
export function stackPresets(frame: Frame): StackPreset[] {
  const fixed = fixedSectionTypes(frame)
  const singleHeights = new Set(fixed.map(fixedHeight))
  const singles = fixed.map((type) => [type])
  const pairs = fixed
    .flatMap((lower) => fixed.map((upper) => [lower, upper]))
    .filter(([lower, upper]) => {
      if (lower === undefined || upper === undefined) return false
      return !singleHeights.has(fixedHeight(lower) + fixedHeight(upper))
    })
  return [...singles, ...pairs]
    .filter((types) => {
      const total = types.reduce((sum, type) => sum + fixedHeight(type), 0)
      return total >= frame.stack.minU && total <= frame.stack.maxU
    })
    .map((types) => {
      const heights = types.map((type) => `${fixedHeight(type)}U`)
      const [lower, upper] = heights
      return {
        id: types.map((type) => type.id).join('+'),
        typeIds: types.map((type) => type.id),
        label: heights.join(' + '),
        description:
          upper === undefined
            ? `One ${lower ?? ''} section`
            : `${lower ?? ''} at the bottom, ${upper} on top`,
      }
    })
}

// ---------------------------------------------------------------------------------------------
// Editing the stack

function newSection(state: WizardState, type: SectionType): [WizardSection, WizardState] {
  const heightU = defaultHeightFor(type)
  const section: WizardSection = {
    key: `s${state.nextKey}`,
    typeId: type.id,
    ...(heightU === undefined ? {} : { heightU }),
    have: state.mode === 'record',
  }
  return [section, { ...state, nextKey: state.nextKey + 1 }]
}

function withTypes(state: WizardState, types: readonly SectionType[]): WizardState {
  let next: WizardState = { ...state, sections: [] }
  const sections: WizardSection[] = []
  for (const type of types) {
    const [section, after] = newSection(next, type)
    sections.push(section)
    next = after
  }
  return { ...next, sections }
}

/**
 * Picks the frame. Another frame starts over (sections and answers belong to a frame); a one-piece
 * frame gets its single section right away.
 */
export function selectFrame(state: WizardState, frame: Frame): WizardState {
  if (state.frameId === frame.id) return state
  const base: WizardState = { ...state, frameId: frame.id, sections: [], options: emptyAnswers() }
  delete base.goal
  const first = frame.sectionTypes[0]
  return isOnePieceFrame(frame) && first !== undefined ? withTypes(base, [first]) : base
}

/** Replaces the stack with a preset (Have in Recording mode, else Need). */
export function applyPreset(state: WizardState, frame: Frame, preset: StackPreset): WizardState {
  const types = preset.typeIds
    .map((typeId) => findType(frame, typeId))
    .filter((type) => type !== undefined)
  return withTypes(state, types)
}

/** Whether one more section of this type keeps the stack within the frame's maximum. */
export function canAddSection(state: WizardState, frame: Frame, typeId: string): boolean {
  const type = findType(frame, typeId)
  if (type === undefined) return false
  return (
    stackHeightU(state, frame) + (defaultHeightFor(type) ?? fixedHeight(type)) <= frame.stack.maxU
  )
}

export function addSection(
  state: WizardState,
  frame: Frame,
  typeId: string,
  at: StackEnd,
): WizardState {
  const type = findType(frame, typeId)
  if (type === undefined || !canAddSection(state, frame, typeId)) return state
  const [section, next] = newSection(state, type)
  const sections = at === 'top' ? [...state.sections, section] : [section, ...state.sections]
  return { ...next, sections }
}

/** Moves a section one place: `up` toward the top of the rack, `down` toward the bottom. */
export function moveSection(
  state: WizardState,
  key: string,
  direction: 'up' | 'down',
): WizardState {
  const index = state.sections.findIndex((section) => section.key === key)
  const target = direction === 'up' ? index + 1 : index - 1
  const section = state.sections[index]
  const other = state.sections[target]
  if (section === undefined || other === undefined) return state
  const sections = [...state.sections]
  sections[index] = other
  sections[target] = section
  return { ...state, sections }
}

export function removeSection(state: WizardState, key: string): WizardState {
  const sections = state.sections.filter((section) => section.key !== key)
  return sections.length === state.sections.length ? state : { ...state, sections }
}

function updateSection(
  state: WizardState,
  key: string,
  change: (section: WizardSection) => WizardSection,
): WizardState {
  let changed = false
  const sections = state.sections.map((section) => {
    if (section.key !== key) return section
    const next = change(section)
    changed ||= next !== section
    return next
  })
  return changed ? { ...state, sections } : state
}

export function setSectionHave(state: WizardState, key: string, have: boolean): WizardState {
  return updateSection(state, key, (section) =>
    section.have === have ? section : { ...section, have },
  )
}

/** Height of a range-type section (validated by `wizardIssues`, so typing never jumps). */
export function setSectionHeight(state: WizardState, key: string, heightU: number): WizardState {
  return updateSection(state, key, (section) =>
    section.heightU === heightU ? section : { ...section, heightU },
  )
}

// ---------------------------------------------------------------------------------------------
// Stack facts

export interface StackRow {
  key: string
  typeId: string
  /** The section type's label ("3U section"). */
  label: string
  heightU: number
  /** First and last U of the section, counted from 1 at the bottom. */
  fromU: number
  toU: number
  have: boolean
  /** Allowed heights, for section types with a height range. */
  range?: { min: number; max: number }
}

/** A section's height in U; 0 while a range height is half-typed (empty or not a number). */
function sectionU(frame: Frame, section: WizardSection): number {
  const heightU = sectionHeightU(frame, section.typeId, section.heightU)
  return Number.isFinite(heightU) && heightU > 0 ? heightU : 0
}

/** The stack bottom -> top with U ranges ("U4–U9"). */
export function stackRows(state: WizardState, frame: Frame): StackRow[] {
  const rows: StackRow[] = []
  let start = 0
  for (const section of state.sections) {
    const type = findType(frame, section.typeId)
    const heightU = sectionU(frame, section)
    const end = start + uToSixths(heightU)
    rows.push({
      key: section.key,
      typeId: section.typeId,
      label: type?.label ?? section.typeId,
      heightU,
      fromU: uNumberAt(start),
      toU: end > start ? uNumberAt(end - 1) : uNumberAt(start),
      have: section.have,
      ...(type !== undefined && typeof type.heightU !== 'number'
        ? { range: { min: type.heightU.min, max: type.heightU.max } }
        : {}),
    })
    start = end
  }
  return rows
}

export function stackHeightU(state: WizardState, frame: Frame): number {
  return state.sections.reduce((total, section) => total + sectionU(frame, section), 0)
}

/** "3U + 6U" bottom -> top, as the plan summaries write it. */
export function stackSummary(state: WizardState, frame: Frame): string {
  return stackRows(state, frame)
    .map((row) => `${row.heightU}U`)
    .join(' + ')
}

// ---------------------------------------------------------------------------------------------
// Options

export interface OptionGroup {
  scope: WizardOptionScope
  options: Option[]
}

/** The frame's options grouped by where they apply; empty groups are left out. */
export function optionGroups(frame: Frame): OptionGroup[] {
  return WIZARD_OPTION_SCOPES.map((scope) => ({
    scope,
    options: frame.options.filter((option) => option.scope === scope),
  })).filter((group) => group.options.length > 0)
}

function isWizardScope(scope: Option['scope']): scope is WizardOptionScope {
  return scope !== 'item'
}

/** The answer for an option: what the user picked, else the option's default. */
export function optionAnswer(state: WizardState, option: Option): OptionValue {
  if (!isWizardScope(option.scope)) return optionDefault(option)
  const value = state.options[option.scope][option.id]
  return isValidOptionValue(option, value) ? value : optionDefault(option)
}

export function setOptionValue(
  state: WizardState,
  option: Option,
  value: OptionValue,
): WizardState {
  if (!isWizardScope(option.scope) || !isValidOptionValue(option, value)) return state
  const scope = option.scope
  return {
    ...state,
    options: { ...state.options, [scope]: { ...state.options[scope], [option.id]: value } },
  }
}

/** Every option of one scope with its answer (explicit, so a later default change in the catalog does not change the plan). */
function answersFor(state: WizardState, frame: Frame, scope: WizardOptionScope): OptionValues {
  const values: OptionValues = {}
  for (const option of frame.options) {
    if (option.scope === scope) values[option.id] = optionAnswer(state, option)
  }
  return values
}

// ---------------------------------------------------------------------------------------------
// Goal

/** Height of the planned (Need) sections at one end, which `setHeight` may rebuild. */
function plannedRunU(rows: readonly StackRow[], at: StackEnd): number {
  const fromEnd = at === 'top' ? rows.toReversed() : rows
  let total = 0
  for (const row of fromEnd) {
    if (row.have) break
    total += row.heightU
  }
  return total
}

/**
 * Heights above the current stack that `setHeight` can reach when new sections go at `at`: the
 * kept sections plus fixed-height sections, up to the frame's maximum. Empty for one-piece frames
 * and in "new" mode stacks without sections.
 */
export function goalHeights(state: WizardState, frame: Frame, at: StackEnd): number[] {
  const rows = stackRows(state, frame)
  if (rows.length === 0) return []
  const currentU = rows.reduce((total, row) => total + row.heightU, 0)
  const keptU = currentU - plannedRunU(rows, at)
  const heights: number[] = []
  for (
    let heightU = Math.max(currentU + 1, frame.stack.minU);
    heightU <= frame.stack.maxU;
    heightU++
  ) {
    if (composeHeight(heightU - keptU, frame.sectionTypes) !== undefined) heights.push(heightU)
  }
  return heights
}

/** Recording: grow by the smallest step on top when possible. New racks have no goal. */
export function defaultGoal(state: WizardState, frame: Frame): WizardGoal {
  if (state.mode === 'new') return { kind: 'none' }
  const first = goalHeights(state, frame, 'top')[0]
  return first === undefined
    ? { kind: 'none' }
    : { kind: 'target-height', targetU: first, at: 'top' }
}

/**
 * The goal to show on the last step: the chosen one while it is still reachable (the stack may
 * have changed since), else the closest reachable height at the same end, else the default.
 */
export function resolveGoal(state: WizardState, frame: Frame): WizardGoal {
  const goal = state.goal
  if (state.mode === 'new') return { kind: 'none' }
  if (goal === undefined) return defaultGoal(state, frame)
  if (goal.kind === 'none') return goal
  const heights = goalHeights(state, frame, goal.at)
  if (heights.includes(goal.targetU)) return goal
  const closest = heights.find((heightU) => heightU >= goal.targetU) ?? heights.at(-1)
  return closest === undefined ? { kind: 'none' } : { ...goal, targetU: closest }
}

export function setGoal(state: WizardState, goal: WizardGoal): WizardState {
  return { ...state, goal }
}

/** "9U → 12U: a new 3U section on top." for a target height; undefined otherwise. */
export function goalSummary(
  state: WizardState,
  frame: Frame,
  goal: WizardGoal,
): string | undefined {
  if (goal.kind !== 'target-height') return undefined
  const rows = stackRows(state, frame)
  const currentU = rows.reduce((total, row) => total + row.heightU, 0)
  const planned = plannedRunU(rows, goal.at)
  const types = composeHeight(goal.targetU - (currentU - planned), frame.sectionTypes)
  if (types === undefined) return undefined
  const sizes = types.map((type) => `${fixedHeight(type)}U`).join(' + ')
  const where = goal.at === 'top' ? 'on top' : 'at the bottom'
  const what =
    planned > 0
      ? `the planned sections ${where} become ${sizes}`
      : types.length === 1
        ? `a new ${sizes} section ${where}`
        : `new ${sizes} sections ${where}`
  return `${currentU}U → ${goal.targetU}U: ${what}.`
}

// ---------------------------------------------------------------------------------------------
// Name

/** "KWS Rack v2: 9U → 12U", "KWS Rack v2: 9U as built", "KWS Rack v2: new 12U". */
export function suggestedName(state: WizardState, frame: Frame): string {
  const heightU = stackHeightU(state, frame)
  if (state.mode === 'new') return `${frame.name}: new ${heightU}U`
  const goal = state.goal ?? defaultGoal(state, frame)
  return goal.kind === 'target-height'
    ? `${frame.name}: ${heightU}U → ${goal.targetU}U`
    : `${frame.name}: ${heightU}U as built`
}

/** The name the plan gets: the user's, else the suggestion. */
export function planName(state: WizardState, frame: Frame): string {
  return state.name ?? suggestedName(state, frame)
}

export function setName(state: WizardState, name: string): WizardState {
  return { ...state, name }
}

// ---------------------------------------------------------------------------------------------
// Validation

/** What an issue points at: a control on the step, or one section (`section:<key>`). */
export type WizardField = 'frame' | 'sections' | 'goal' | 'name' | `section:${string}`

export interface WizardIssue {
  step: NumberedStep
  field: WizardField
  message: string
}

/** Problems that keep the user on `step`, in display order. */
export function wizardIssues(
  state: WizardState,
  frame: Frame | undefined,
  step: NumberedStep,
): WizardIssue[] {
  if (frame === undefined || state.frameId !== frame.id) {
    return [{ step: 'frame', field: 'frame', message: 'Pick a frame to continue.' }]
  }
  if (step === 'frame') return []
  if (step === 'stack') return stackIssues(state, frame)
  const issues: WizardIssue[] = []
  const name = planName(state, frame).trim()
  if (name === '') issues.push({ step, field: 'name', message: 'Give the plan a name.' })
  else if (name.length > MAX_PLAN_NAME_LENGTH) {
    issues.push({
      step,
      field: 'name',
      message: `Use at most ${MAX_PLAN_NAME_LENGTH} characters.`,
    })
  }
  return issues
}

function stackIssues(state: WizardState, frame: Frame): WizardIssue[] {
  const step = 'stack'
  if (state.sections.length === 0) {
    return [
      {
        step,
        field: 'sections',
        message:
          state.mode === 'record'
            ? 'Add the sections your rack has: pick a quick start or add them one by one.'
            : 'Add at least one section: pick a quick start or add them one by one.',
      },
    ]
  }
  const issues: WizardIssue[] = []
  for (const section of state.sections) {
    const type = findType(frame, section.typeId)
    if (type === undefined) {
      issues.push({
        step,
        field: `section:${section.key}`,
        message: `${frame.name} has no section type "${section.typeId}". Remove this section.`,
      })
    } else if (typeof type.heightU !== 'number') {
      const { min, max } = type.heightU
      const heightU = section.heightU
      if (heightU === undefined || !Number.isInteger(heightU) || heightU < min || heightU > max) {
        issues.push({
          step,
          field: `section:${section.key}`,
          message: `Enter a whole number of U from ${min} to ${max}.`,
        })
      }
    }
  }
  if (issues.length > 0) return issues
  const heightU = stackHeightU(state, frame)
  if (heightU > frame.stack.maxU) {
    issues.push({
      step,
      field: 'sections',
      message: `${frame.name} stacks go up to ${frame.stack.maxU}U; this one is ${heightU}U.`,
    })
  } else if (heightU < frame.stack.minU) {
    issues.push({
      step,
      field: 'sections',
      message: `${frame.name} stacks start at ${frame.stack.minU}U; this one is ${heightU}U.`,
    })
  }
  if (state.mode === 'record' && !state.sections.some((section) => section.have)) {
    issues.push({
      step,
      field: 'sections',
      message:
        'Mark at least one section as In my rack. If nothing is built yet, plan a new rack instead.',
    })
  }
  return issues
}

// ---------------------------------------------------------------------------------------------
// Building the plan

/** Why the plan could not be built, and the step (and control) to send the user back to. */
export class WizardBuildError extends Error {
  override name = 'WizardBuildError'
  readonly step: NumberedStep
  readonly field: WizardField

  constructor(issue: WizardIssue) {
    super(issue.message)
    this.step = issue.step
    this.field = issue.field
  }
}

/** What Mark as Have captures for a cap: every frame option as it resolves for that cap now. */
function capSnapshot(frame: Frame, plan: Plan, cap: 'top' | 'bottom', at: string): Snapshot {
  return {
    at,
    options: resolveOptionValues(frame.options, plan.frame.options, plan.frame.caps[cap].options),
  }
}

function capState(options: OptionValues): CapState {
  return Object.keys(options).length === 0 ? {} : { options }
}

/**
 * The plan the wizard describes, with new ids throughout:
 * - frame options: rack answers in `frame.options`, top and bottom answers on their caps;
 *   section answers (asked once for every section) also go in `frame.options`, the layer every
 *   section inherits, so sections that `setHeight` adds later and rack-wide recipe lines that
 *   depend on a section option (KWS's 7 rack magnets) see the same answer;
 * - Recording: Have sections get snapshots through `markSection`, the caps are Have once any
 *   section is, and a target height runs `setHeight`, which adds planned sections at that end.
 * `catalogRev` is left to the caller (it describes the app's bundled catalog).
 * @throws WizardBuildError with the step to go back to (incomplete answers, an unreachable height)
 */
export function buildPlanFromWizard(
  frame: Frame,
  lookup: CatalogLookup,
  state: WizardState,
  now: string,
): Plan {
  for (const step of WIZARD_STEPS) {
    const issue = wizardIssues(state, frame, step)[0]
    if (issue !== undefined) throw new WizardBuildError(issue)
  }
  const sections: PlanSection[] = state.sections.map((section) => {
    const type = findType(frame, section.typeId)
    const range = type !== undefined && isRangeType(type)
    return {
      id: newId(ID_PREFIX.section),
      typeId: section.typeId,
      ...(range && section.heightU !== undefined ? { heightU: section.heightU } : {}),
    }
  })
  let plan: Plan = {
    schema: PLAN_SCHEMA_VERSION,
    id: newId(ID_PREFIX.plan),
    rackId: newId(ID_PREFIX.rack),
    name: planName(state, frame).trim(),
    createdAt: now,
    updatedAt: now,
    rev: 0,
    frame: {
      frameId: frame.id,
      options: { ...answersFor(state, frame, 'rack'), ...answersFor(state, frame, 'section') },
      caps: {
        top: capState(answersFor(state, frame, 'top')),
        bottom: capState(answersFor(state, frame, 'bottom')),
      },
      sections,
    },
    placements: [],
    equipment: [],
    extras: [],
    retired: [],
    // A frame from the user's own library travels with the plan (backups, share links).
    custom: { frames: isCustomId(frame.id) ? [frame] : [], items: [], devices: [], hardware: [] },
  }

  if (state.mode === 'record') {
    for (const [index, section] of state.sections.entries()) {
      const id = sections[index]?.id
      if (!section.have || id === undefined) continue
      const marked = markSection(plan, id, true, now, frame)
      if (marked.error !== undefined) {
        throw new WizardBuildError({ step: 'stack', field: 'sections', message: marked.error })
      }
      plan = marked.plan
    }
    if (state.sections.some((section) => section.have)) {
      const caps = plan.frame.caps
      plan = {
        ...plan,
        frame: {
          ...plan.frame,
          caps: {
            top: { ...caps.top, have: capSnapshot(frame, plan, 'top', now) },
            bottom: { ...caps.bottom, have: capSnapshot(frame, plan, 'bottom', now) },
          },
        },
      }
    }
    const goal = state.goal ?? defaultGoal(state, frame)
    if (goal.kind === 'target-height') {
      const grown = setHeight(plan, frame, goal.targetU, goal.at, { catalog: lookup })
      if (grown.error !== undefined) {
        throw new WizardBuildError({ step: 'finish', field: 'goal', message: grown.error })
      }
      plan = grown.plan
    }
  }

  const parsed = PlanSchema.safeParse(plan)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new WizardBuildError({
      step: 'finish',
      field: 'name',
      message: `The plan could not be built (${first?.path.join('.') ?? 'plan'}: ${first?.message ?? 'invalid'}).`,
    })
  }
  return parsed.data
}
