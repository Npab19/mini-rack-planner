import type {
  Condition,
  JointFilter,
  Length,
  OptionMatch,
  Qty,
  StackCondition,
} from './schema/common'

/** A pair of adjacent sections as [lower type id, upper type id]. */
export type Joint = readonly [string, string]

/** What a quantity formula is evaluated against (see recipe.ts for the context of each unit). */
export interface QtyContext {
  /** Height in U of the unit being counted: a section, the whole stack, or an item. */
  u: number
  /** Number of sections of each type in scope. */
  sectionCounts: Readonly<Record<string, number>>
  /** Number of sections in scope, any type. */
  sectionCountAny: number
  /** Adjacent section pairs in scope. */
  joints: readonly Joint[]
}

export interface StackFacts {
  /** Total height of the stack in U. */
  u: number
  /** Section type ids, bottom -> top. */
  sectionTypes: readonly string[]
}

export interface ConditionContext {
  /** Resolved option values of the scope being evaluated. */
  options: Readonly<Record<string, unknown>>
  stack: StackFacts
}

/** True when the joint is not excluded by `filter`. */
export function jointPasses(joint: Joint, filter: JointFilter | undefined): boolean {
  const excluded = filter?.notAdjacentTo ?? []
  return !excluded.includes(joint[0]) && !excluded.includes(joint[1])
}

function perSectionTotal(
  perSection: Readonly<Record<string, number>> | undefined,
  counts: Readonly<Record<string, number>>,
): number {
  let total = 0
  for (const [typeId, each] of Object.entries(perSection ?? {})) {
    total += each * (counts[typeId] ?? 0)
  }
  return total
}

/** Sum of every term of the formula. Not rounded: the BOM rounds once per aggregated line. */
export function evaluateQty(qty: Qty, ctx: QtyContext): number {
  if (typeof qty === 'number') return qty
  const joints = ctx.joints.filter((joint) => jointPasses(joint, qty.jointFilter)).length
  return (
    (qty.base ?? 0) +
    (qty.perU ?? 0) * ctx.u +
    perSectionTotal(qty.perSection, ctx.sectionCounts) +
    (qty.perSectionAny ?? 0) * ctx.sectionCountAny +
    (qty.perJoint ?? 0) * joints
  )
}

/** Cut length in mm (never negative). */
export function evaluateLength(length: Length, ctx: Pick<QtyContext, 'u'>): number {
  return Math.max(0, length.base + length.perU * ctx.u)
}

function optionMatches(actual: unknown, expected: OptionMatch): boolean {
  return Array.isArray(expected) ? expected.some((value) => value === actual) : expected === actual
}

function stackMatches(condition: StackCondition, stack: StackFacts): boolean {
  const sections = stack.sectionTypes.length
  if (condition.minU !== undefined && stack.u < condition.minU) return false
  if (condition.maxU !== undefined && stack.u > condition.maxU) return false
  if (condition.minSections !== undefined && sections < condition.minSections) return false
  if (condition.maxSections !== undefined && sections > condition.maxSections) return false
  if (
    condition.topTypeId !== undefined &&
    stack.sectionTypes[sections - 1] !== condition.topTypeId
  ) {
    return false
  }
  if (condition.bottomTypeId !== undefined && stack.sectionTypes[0] !== condition.bottomTypeId) {
    return false
  }
  return true
}

/**
 * Evaluates a condition; a missing condition is true. An option that is not set reads as
 * undefined, so it never equals a value.
 */
export function evaluateCondition(cond: Condition | undefined, ctx: ConditionContext): boolean {
  if (cond === undefined) return true
  if ('option' in cond) {
    return Object.entries(cond.option).every(([id, expected]) =>
      optionMatches(ctx.options[id], expected),
    )
  }
  if ('stack' in cond) return stackMatches(cond.stack, ctx.stack)
  if ('all' in cond) return cond.all.every((inner) => evaluateCondition(inner, ctx))
  if ('any' in cond) return cond.any.some((inner) => evaluateCondition(inner, ctx))
  return !evaluateCondition(cond.not, ctx)
}
