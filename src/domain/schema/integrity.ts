import { sixthsToMm } from '../geometry'
import {
  isValidOptionValue,
  type CatalogEntry,
  type Frame,
  type Item,
  type Option,
  type Part3D,
  type PrintGroup,
  type RecipeLine,
  type RecipeUnit,
} from './catalog'
import { isCustomId, type Condition, type OptionMatch } from './common'

/**
 * Rules one catalog entry must meet beyond its schema shape: unique local ids, references that
 * resolve inside the entry, and units/scopes that fit the entry kind. Cross-entry references
 * (hardware ids, frames in `compat`) are left to validate-catalog.
 *
 * Returns readable problems; an empty array means the entry is consistent.
 */
export function checkEntryIntegrity(entry: CatalogEntry): string[] {
  switch (entry.kind) {
    case 'frame':
      return checkFrame(entry)
    case 'item':
    case 'extra':
      return checkItem(entry)
    case 'device':
    case 'hardware':
      return []
  }
}

const FRAME_UNITS: readonly RecipeUnit[] = ['rack', 'top', 'bottom', 'section', 'joint']
const FRAME_SCOPES: readonly string[] = ['rack', 'top', 'bottom', 'section']

interface EntryContext {
  options: readonly Option[]
  typeIds: ReadonlySet<string>
  printIds: ReadonlySet<string>
  /** Undefined when the entry declares no 3D parts. */
  partIds: ReadonlySet<string> | undefined
}

interface ConditionRefs {
  options: Array<[string, OptionMatch]>
  typeIds: string[]
}

function idsOf(entries: ReadonlyArray<{ id: string }> | undefined): string[] {
  return (entries ?? []).map((entry) => entry.id)
}

function partIdsOf(parts: readonly Part3D[] | undefined): ReadonlySet<string> | undefined {
  return parts === undefined ? undefined : new Set(idsOf(parts))
}

function duplicateIds(what: string, ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id)
    seen.add(id)
  }
  return [...repeated].map((id) => `${what} id "${id}" is used more than once`)
}

function optionProblems(options: readonly Option[], scopes: readonly string[]): string[] {
  const problems = duplicateIds('option', idsOf(options))
  for (const option of options) {
    const where = `option "${option.id}"`
    if (!scopes.includes(option.scope)) {
      const allowed = scopes.join(' / ')
      problems.push(`${where}: scope "${option.scope}" is not allowed here (use ${allowed})`)
    }
    problems.push(...duplicateIds(`${where}: choice`, idsOf(option.choices)))
    if (option.kind === 'choice' && option.effects) {
      problems.push(`${where}: put effects on the choices of a choice option`)
    }
  }
  return problems
}

/** Option ids/values and section type ids a condition refers to. */
function conditionRefs(cond: Condition, refs: ConditionRefs): ConditionRefs {
  if ('option' in cond) {
    refs.options.push(...Object.entries(cond.option))
  } else if ('stack' in cond) {
    const { topTypeId, bottomTypeId } = cond.stack
    for (const typeId of [topTypeId, bottomTypeId]) {
      if (typeId !== undefined) refs.typeIds.push(typeId)
    }
  } else if ('all' in cond) {
    for (const inner of cond.all) conditionRefs(inner, refs)
  } else if ('any' in cond) {
    for (const inner of cond.any) conditionRefs(inner, refs)
  } else {
    conditionRefs(cond.not, refs)
  }
  return refs
}

function conditionProblems(
  where: string,
  cond: Condition | undefined,
  ctx: EntryContext,
): string[] {
  if (cond === undefined) return []
  const problems: string[] = []
  const refs = conditionRefs(cond, { options: [], typeIds: [] })
  for (const [optionId, match] of refs.options) {
    const option = ctx.options.find((candidate) => candidate.id === optionId)
    if (option === undefined) {
      problems.push(`${where}: condition uses unknown option "${optionId}"`)
      continue
    }
    for (const value of Array.isArray(match) ? match : [match]) {
      if (!isValidOptionValue(option, value)) {
        const shown = JSON.stringify(value)
        problems.push(`${where}: condition value ${shown} is not valid for option "${optionId}"`)
      }
    }
  }
  for (const typeId of refs.typeIds) {
    if (!ctx.typeIds.has(typeId)) {
      problems.push(`${where}: condition uses unknown section type "${typeId}"`)
    }
  }
  return problems
}

function recipeProblems(
  recipe: readonly RecipeLine[],
  units: readonly RecipeUnit[],
  ctx: EntryContext,
): string[] {
  const problems = duplicateIds('recipe line', idsOf(recipe))
  for (const line of recipe) {
    const where = `recipe line "${line.id}"`
    if (!units.includes(line.unit)) {
      const allowed = units.join(' / ')
      problems.push(`${where}: unit "${line.unit}" is not allowed here (use ${allowed})`)
    }
    if ('print' in line.ref) {
      if (!ctx.printIds.has(line.ref.print)) {
        problems.push(`${where}: unknown print "${line.ref.print}"`)
      }
      if (line.length) problems.push(`${where}: only hardware lines can have a cut length`)
    }
    if (typeof line.count !== 'number') {
      const perSection = Object.keys(line.count.perSection ?? {})
      const notAdjacentTo = line.count.jointFilter?.notAdjacentTo ?? []
      for (const typeId of [...perSection, ...notAdjacentTo]) {
        if (!ctx.typeIds.has(typeId)) problems.push(`${where}: unknown section type "${typeId}"`)
      }
      if (line.unit === 'joint' && line.count.perU) {
        problems.push(`${where}: perU has no meaning per joint`)
      }
    }
    problems.push(...conditionProblems(where, line.when, ctx))
  }
  return problems
}

function printProblems(prints: readonly PrintGroup[], ctx: EntryContext): string[] {
  const problems = duplicateIds('print', idsOf(prints))
  for (const print of prints) {
    const where = `print "${print.id}"`
    for (const piece of print.pieces ?? []) {
      if (!ctx.partIds?.has(piece.partId)) {
        problems.push(`${where}: unknown 3D part "${piece.partId}"`)
      }
    }
    for (const embed of print.embeds ?? []) {
      problems.push(...conditionProblems(`${where} embed "${embed.hardwareId}"`, embed.when, ctx))
    }
  }
  return problems
}

function assemblyProblems(frame: Frame, ctx: EntryContext): string[] {
  const problems: string[] = []
  for (const [index, rule] of (frame.assembly3d ?? []).entries()) {
    const where = `assembly3d[${index}]`
    if (!ctx.partIds?.has(rule.partId)) problems.push(`${where}: unknown 3D part "${rule.partId}"`)
    if (rule.at === 'item') problems.push(`${where}: a frame rule cannot be placed "at: item"`)
    for (const typeId of rule.sectionTypes ?? []) {
      if (!ctx.typeIds.has(typeId)) problems.push(`${where}: unknown section type "${typeId}"`)
    }
    problems.push(...conditionProblems(where, rule.when, ctx))
  }
  return problems
}

function checkFrame(frame: Frame): string[] {
  const ctx: EntryContext = {
    options: frame.options,
    typeIds: new Set(idsOf(frame.sectionTypes)),
    printIds: new Set(idsOf(frame.prints)),
    partIds: partIdsOf(frame.parts3d),
  }
  const problems = [
    ...duplicateIds('section type', idsOf(frame.sectionTypes)),
    ...duplicateIds('3D part', idsOf(frame.parts3d)),
    ...optionProblems(frame.options, FRAME_SCOPES),
    ...printProblems(frame.prints, ctx),
    ...recipeProblems(frame.recipe, FRAME_UNITS, ctx),
    ...assemblyProblems(frame, ctx),
  ]
  if (!isCustomId(frame.id) && frame.source === undefined) {
    problems.push('a curated frame needs a source')
  }
  if (frame.stack.minU > frame.stack.maxU) problems.push('stack.minU is greater than stack.maxU')
  for (const type of frame.sectionTypes) {
    if (typeof type.heightU !== 'number' && type.heightU.min > type.heightU.max) {
      problems.push(`section type "${type.id}": heightU.min is greater than heightU.max`)
    }
  }
  return problems
}

function checkItem(item: Item): string[] {
  const ctx: EntryContext = {
    options: item.options,
    typeIds: new Set(),
    printIds: new Set(idsOf(item.prints)),
    partIds: partIdsOf(item.parts3d),
  }
  const problems = [
    ...duplicateIds('slot', idsOf(item.slots)),
    ...duplicateIds('3D part', idsOf(item.parts3d)),
    ...optionProblems(item.options, ['item']),
    ...printProblems(item.prints, ctx),
    ...recipeProblems(item.recipe, ['item'], ctx),
  ]
  if (!isCustomId(item.id) && item.source === undefined) {
    problems.push(`a curated ${item.kind} needs a source`)
  }
  if (item.kind === 'extra' && item.heightSixths !== 0) {
    problems.push('an extra must have heightSixths 0')
  }
  if (item.kind === 'item' && item.heightSixths === 0) {
    problems.push('an item needs a height (use kind "extra" for accessories)')
  }
  if (item.kind === 'item' && item.mount.front + item.mount.rear === 0) {
    problems.push('an item needs mount holes (see defaultMountHoles)')
  }
  const heightMm = sixthsToMm(item.heightSixths)
  for (const offset of item.mount.holeOffsetsMm ?? []) {
    if (offset > heightMm) {
      problems.push(`mount hole offset ${offset} mm is above the item's height`)
    }
  }
  return problems
}
