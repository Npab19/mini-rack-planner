/**
 * Stack operations as requests the inspector can run, re-run with a conflict policy, and
 * announce. Each `run` is a pure domain call (frame.ts); `useStackOps` applies it through the plan
 * store and shows `StackConflictDialog` when the domain reports conflicts a policy can resolve.
 */
import { HAVE_TEXT } from '@/components/common/HaveNeed'
import { markSectionContents } from '@/domain/build'
import type { StackConflict, StackOpResult } from '@/domain/api'
import {
  insertSection,
  mergeSections,
  moveSection,
  removeSection,
  retireSection,
  setHeight,
  splitSection,
  type PlacementPolicy,
  type StackEnd,
} from '@/domain/frame'
import type { CatalogLookup, Frame, SectionType } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import { sectionSummaryText } from '@/state/derived'
import { nowIso } from './planOps'
import { stackRows, type MergeChoice, type SplitChoice, type StackRow } from './stackModel'

/** The choices the conflict dialog offers, passed back to the operation. */
export interface OpPolicy {
  /** A part across a joint that changes moves with its lower or upper section. */
  straddle?: 'lower' | 'upper'
  /** Parts on a section that goes away (through the remap): kept where they are or deleted. */
  orphans?: 'keep' | 'delete'
  /** Remove / Retire: also remove what is mounted on the section (owned parts retire). */
  removePlacements?: boolean
}

export interface StackOpRequest {
  /** What the user asked for, e.g. "Move 6U section, U4–U9 up" (the dialog's title). */
  title: string
  run: (plan: Plan, policy: OpPolicy) => StackOpResult
  /**
   * How "the section still holds parts" resolves: through the remap (keep or delete), or by
   * removing what is mounted on it (Remove / Retire: delete only).
   */
  notEmpty: 'remap' | 'remove'
  /** Announced when the operation applies, from the plan after it. */
  done: (plan: Plan) => string
  /**
   * Conflicts no policy resolves (height limits, sections you have) are returned as an error for
   * the caller to show next to its form, instead of in the dialog.
   */
  inlineErrors?: boolean
  /** Called once the operation applied (directly or after the conflict dialog), with both plans. */
  applied?: (before: Plan, after: Plan) => void
}

/** Conflicts the dialog can resolve with a policy. */
export function isResolvable(conflict: StackConflict): boolean {
  return conflict.kind === 'straddle' || conflict.kind === 'section-not-empty'
}

export interface StackOpContext {
  frame: Frame
  /** Resolves placement heights and names for the remap (the plan's lookup). */
  lookup: CatalogLookup
}

function placementPolicy(lookup: CatalogLookup, policy: OpPolicy): PlacementPolicy {
  return {
    catalog: lookup,
    ...(policy.straddle === undefined ? {} : { straddle: policy.straddle }),
    ...(policy.orphans === undefined ? {} : { orphans: policy.orphans }),
  }
}

/** "Stack, bottom to top: 3U + 6U + 3U · 12U." */
export function stackText(plan: Plan, frame: Frame): string {
  const heights = stackRows(plan, frame).map((row) => row.heightU)
  return `Stack, bottom to top: ${sectionSummaryText(heights)}.`
}

function rowIn(plan: Plan, frame: Frame, sectionId: string): StackRow | undefined {
  return stackRows(plan, frame).find((row) => row.sectionId === sectionId)
}

function where(at: StackEnd): string {
  return at === 'top' ? 'on top' : 'at the bottom'
}

/** "a 3U section", "an 8U section", "an open frame". */
export function withArticle(label: string): string {
  return `${/^(?:[aeiou]|8|11(?!\d)|18(?!\d))/i.test(label) ? 'an' : 'a'} ${label}`
}

export function moveSectionRequest(
  { frame, lookup }: StackOpContext,
  row: StackRow,
  direction: 'up' | 'down',
): StackOpRequest {
  const toIndex = row.index + (direction === 'up' ? 1 : -1)
  return {
    title: `Move ${row.name} ${direction}`,
    notEmpty: 'remap',
    run: (plan, policy) =>
      moveSection(plan, frame, row.sectionId, toIndex, placementPolicy(lookup, policy)),
    done: (plan) => {
      const moved = rowIn(plan, frame, row.sectionId)
      const now = moved === undefined ? '' : `: now ${moved.range}`
      const rebuild = row.have ? ' Reordering built sections means taking the rack apart.' : ''
      return `Moved ${row.typeLabel} ${direction}${now}. ${stackText(plan, frame)}${rebuild}`
    },
  }
}

export function removeSectionRequest(
  { frame, lookup }: StackOpContext,
  row: StackRow,
): StackOpRequest {
  return {
    title: `Remove ${row.name}`,
    notEmpty: 'remove',
    run: (plan, policy) =>
      removeSection(plan, frame, row.sectionId, {
        ...placementPolicy(lookup, policy),
        removePlacements: policy.removePlacements === true,
      }),
    done: (plan) => `Removed ${row.name}. ${stackText(plan, frame)}`,
  }
}

export function retireSectionRequest(
  { frame, lookup }: StackOpContext,
  row: StackRow,
): StackOpRequest {
  return {
    title: `Retire ${row.name}`,
    notEmpty: 'remove',
    run: (plan, policy) =>
      retireSection(plan, frame, row.sectionId, nowIso(), {
        ...placementPolicy(lookup, policy),
        removePlacements: policy.removePlacements === true,
      }),
    done: (plan) =>
      `Retired ${row.name}: it is kept as a part you own, out of the rack. ${stackText(plan, frame)}`,
  }
}

export function splitSectionRequest(
  { frame, lookup }: StackOpContext,
  row: StackRow,
  choice: SplitChoice,
): StackOpRequest {
  return {
    title: `Split ${row.name} into ${choice.text}`,
    notEmpty: 'remap',
    run: (plan, policy) =>
      splitSection(
        plan,
        frame,
        row.sectionId,
        choice.parts.map((part) => part.id),
        placementPolicy(lookup, policy),
      ),
    done: (plan) => `Split ${row.name} into ${choice.text}. ${stackText(plan, frame)}`,
  }
}

export function mergeSectionsRequest(
  { frame, lookup }: StackOpContext,
  row: StackRow,
  choice: MergeChoice,
): StackOpRequest {
  return {
    title: `Merge ${row.name} with the section ${choice.direction}`,
    notEmpty: 'remap',
    run: (plan, policy) =>
      mergeSections(
        plan,
        frame,
        row.sectionId,
        choice.other.sectionId,
        choice.into,
        placementPolicy(lookup, policy),
      ),
    done: (plan) =>
      `Merged ${row.name} and ${choice.other.name} into ${withArticle(choice.intoLabel)}. ${stackText(plan, frame)}`,
  }
}

/**
 * Recording mode marks every section the operation created as In my rack, with the cap rule of
 * `markSectionContents` (the top and bottom count as built once any section is).
 */
function markNewSectionsHave(
  before: Plan,
  after: Plan,
  frame: Frame,
  at: string,
  lookup: CatalogLookup,
): Plan {
  const existing = new Set(before.frame.sections.map((section) => section.id))
  let next = after
  for (const section of after.frame.sections) {
    if (existing.has(section.id)) continue
    next = markSectionContents(next, frame, section.id, true, at, lookup)
  }
  return next
}

/** On top, at the bottom, or at a stack index with its phrase ("between Section 1 (3U) and …"). */
export type InsertAt = StackEnd | { index: number; phrase: string }

export function insertSectionRequest(
  { frame, lookup }: StackOpContext,
  type: SectionType,
  at: InsertAt,
  recording: boolean,
  /** For a section type with a height range. */
  heightU?: number,
): StackOpRequest {
  const phrase = typeof at === 'string' ? where(at) : at.phrase
  const index = (plan: Plan): number =>
    typeof at === 'string' ? (at === 'top' ? plan.frame.sections.length : 0) : at.index
  return {
    title: `Add ${withArticle(type.label)} ${phrase}`,
    notEmpty: 'remap',
    run: (plan, policy) => {
      const stamp = nowIso()
      const result = insertSection(plan, frame, index(plan), type.id, {
        ...placementPolicy(lookup, policy),
        have: recording,
        at: stamp,
        ...(heightU === undefined ? {} : { heightU }),
      })
      if (result.error !== undefined || !recording) return result
      return { ...result, plan: markNewSectionsHave(plan, result.plan, frame, stamp, lookup) }
    },
    done: (plan) =>
      `Added ${withArticle(type.label)} ${phrase}${recording ? `, marked ${HAVE_TEXT}` : ''}. ${stackText(plan, frame)}`,
    inlineErrors: true,
  }
}

export function setHeightRequest(
  { frame, lookup }: StackOpContext,
  targetU: number,
  at: StackEnd,
  recording: boolean,
): StackOpRequest {
  return {
    title: `Set the height to ${targetU}U ${where(at)}`,
    notEmpty: 'remap',
    run: (plan, policy) => {
      const result = setHeight(plan, frame, targetU, at, placementPolicy(lookup, policy))
      if (result.error !== undefined || !recording) return result
      return { ...result, plan: markNewSectionsHave(plan, result.plan, frame, nowIso(), lookup) }
    },
    done: (plan) => `The rack is now ${targetU}U. ${stackText(plan, frame)}`,
    inlineErrors: true,
  }
}
