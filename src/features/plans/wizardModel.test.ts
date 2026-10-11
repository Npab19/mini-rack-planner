import { describe, expect, it } from 'vitest'
import { FIXTURE_NOW, KWS_FRAME, kwsCatalog } from '@/domain/__fixtures__/kws'
import { computeBom } from '@/domain/bom'
import { FrameSchema, type Frame } from '@/domain/schema/catalog'
import { PlanSchema, type Plan } from '@/domain/schema/plan'
import { defaultSettings } from '@/domain/schema/settings'
import {
  addSection,
  applyPreset,
  buildPlanFromWizard,
  canAddSection,
  defaultGoal,
  goalHeights,
  goalSummary,
  initialWizardState,
  moveSection,
  optionAnswer,
  optionGroups,
  removeSection,
  resolveGoal,
  selectFrame,
  setGoal,
  setName,
  setOptionValue,
  setSectionHave,
  setSectionHeight,
  stackHeightU,
  stackPresets,
  stackRows,
  suggestedName,
  wizardIssues,
  WizardBuildError,
  type WizardMode,
  type WizardState,
} from './wizardModel'

const LOOKUP = kwsCatalog()

/** Like catalog/frames/generic-10in.json: one section of 2U to 22U, no options. */
const GENERIC: Frame = FrameSchema.parse({
  kind: 'frame',
  id: 'generic-10in',
  name: 'Generic 10-inch rack',
  verified: { by: 'test', date: '2026-10-11', method: 'unverified' },
  standard: { panelWidthMm: 254, innerWidthMm: 222.25, depthMm: 300, rearOpen: true },
  rail: { earSpacingMm: 236.525, holeOffsetsPerUMm: [6.35, 22.225, 38.1], holeTolMm: 1 },
  equipmentFastener: {
    thread: 'M6',
    perHole: 'screw+cage-nut',
    screwIds: ['screw-m6x12-bhcs'],
    engagementMm: 6,
  },
  sectionTypes: [{ id: 'rack', label: 'Rack', heightU: { min: 2, max: 22 } }],
  stack: { minU: 2, maxU: 22 },
})

/** A KWS wizard with the stack given as section heights, bottom first. */
function kws(mode: WizardMode, heights: ReadonlyArray<3 | 6>): WizardState {
  let state = selectFrame(initialWizardState(mode), KWS_FRAME)
  for (const heightU of heights) state = addSection(state, KWS_FRAME, `s${heightU}`, 'top')
  return state
}

function stackOf(plan: Plan): Array<[string, boolean]> {
  return plan.frame.sections.map((section) => [section.typeId, section.have !== undefined])
}

function option(id: string) {
  const found = KWS_FRAME.options.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no option ${id}`)
  return found
}

describe('presets', () => {
  it('offers KWS singles and pairs, bottom first, without 3U + 3U', () => {
    const presets = stackPresets(KWS_FRAME)
    expect(presets.map((preset) => preset.label)).toEqual([
      '3U',
      '6U',
      '3U + 6U',
      '6U + 3U',
      '6U + 6U',
    ])
    expect(presets[2]).toMatchObject({
      typeIds: ['s3', 's6'],
      description: '3U at the bottom, 6U on top',
    })
  })

  it('applies a preset as Have in Recording mode and Need for a new rack', () => {
    const preset = stackPresets(KWS_FRAME)[2]
    if (preset === undefined) throw new Error('missing preset')
    const recorded = applyPreset(kws('record', []), KWS_FRAME, preset)
    expect(recorded.sections.map((section) => [section.typeId, section.have])).toEqual([
      ['s3', true],
      ['s6', true],
    ])
    const planned = applyPreset(kws('new', [6]), KWS_FRAME, preset)
    expect(planned.sections.map((section) => [section.typeId, section.have])).toEqual([
      ['s3', false],
      ['s6', false],
    ])
    expect(new Set(planned.sections.map((section) => section.key)).size).toBe(2)
  })

  it('gives a one-piece frame a single section with a height instead of presets', () => {
    expect(stackPresets(GENERIC)).toEqual([])
    const state = selectFrame(initialWizardState('record'), GENERIC)
    expect(state.sections).toEqual([{ key: 's1', typeId: 'rack', heightU: 6, have: true }])
    expect(stackRows(state, GENERIC)[0]).toMatchObject({
      label: 'Rack',
      fromU: 1,
      toU: 6,
      range: { min: 2, max: 22 },
    })
  })
})

describe('editing the stack', () => {
  it('lists sections bottom -> top with their U ranges', () => {
    const rows = stackRows(kws('record', [3, 6, 3]), KWS_FRAME)
    expect(rows.map((row) => [row.label, row.fromU, row.toU])).toEqual([
      ['3U section', 1, 3],
      ['6U section', 4, 9],
      ['3U section', 10, 12],
    ])
  })

  it('adds at either end, moves, removes and marks sections', () => {
    let state = kws('record', [6])
    state = addSection(state, KWS_FRAME, 's3', 'bottom')
    expect(state.sections.map((section) => section.typeId)).toEqual(['s3', 's6'])
    const bottom = state.sections[0]?.key ?? ''
    state = moveSection(state, bottom, 'up')
    expect(state.sections.map((section) => section.typeId)).toEqual(['s6', 's3'])
    // Already on top: nothing to move.
    expect(moveSection(state, bottom, 'up')).toBe(state)
    state = setSectionHave(state, bottom, false)
    expect(state.sections.map((section) => section.have)).toEqual([true, false])
    state = removeSection(state, bottom)
    expect(state.sections.map((section) => section.typeId)).toEqual(['s6'])
  })

  it('stops adding at the frame’s maximum height', () => {
    const state = kws('new', [6, 6, 6, 6, 3])
    expect(stackHeightU(state, KWS_FRAME)).toBe(27)
    expect(canAddSection(state, KWS_FRAME, 's3')).toBe(true)
    expect(canAddSection(state, KWS_FRAME, 's6')).toBe(false)
    expect(addSection(state, KWS_FRAME, 's6', 'top')).toBe(state)
  })

  it('starts over when another frame is picked', () => {
    const state = setOptionValue(kws('record', [3, 6]), option('top'), 'flat')
    expect(selectFrame(state, KWS_FRAME)).toBe(state)
    const generic = selectFrame(state, GENERIC)
    expect(generic.sections.map((section) => section.typeId)).toEqual(['rack'])
    expect(generic.options.top).toEqual({})
  })
})

describe('options', () => {
  it('groups the frame’s options by scope', () => {
    expect(
      optionGroups(KWS_FRAME).map((group) => [group.scope, group.options.map((o) => o.id)]),
    ).toEqual([
      ['rack', ['insert-policy', 'high-rack', 'deep-320']],
      ['top', ['top']],
      ['bottom', ['stoppers']],
      ['section', ['magnets', 'side-panels']],
    ])
    expect(optionGroups(GENERIC)).toEqual([])
  })

  it('answers with the default until set, and ignores invalid values', () => {
    let state = kws('record', [3])
    expect(optionAnswer(state, option('top'))).toBe('handle')
    state = setOptionValue(state, option('top'), 'flat')
    expect(optionAnswer(state, option('top'))).toBe('flat')
    expect(setOptionValue(state, option('top'), 'gold')).toBe(state)
    expect(setOptionValue(state, option('magnets'), 'yes')).toBe(state)
  })
})

describe('goal', () => {
  it('lists the heights reachable with 3U and 6U sections', () => {
    const state = kws('record', [3, 6])
    expect(goalHeights(state, KWS_FRAME, 'top')).toEqual([12, 15, 18, 21, 24, 27, 30])
    expect(defaultGoal(state, KWS_FRAME)).toEqual({ kind: 'target-height', targetU: 12, at: 'top' })
    expect(goalSummary(state, KWS_FRAME, { kind: 'target-height', targetU: 18, at: 'top' })).toBe(
      '9U → 18U: new 6U + 3U sections on top.',
    )
  })

  it('counts planned sections at that end as rebuildable', () => {
    let state = kws('record', [3, 6, 3])
    const top = state.sections[2]?.key ?? ''
    state = setSectionHave(state, top, false)
    // 9U is kept; the planned 3U on top can become any composable height.
    expect(goalHeights(state, KWS_FRAME, 'top')).toEqual([15, 18, 21, 24, 27, 30])
    expect(goalHeights(state, KWS_FRAME, 'bottom')).toEqual([15, 18, 21, 24, 27, 30])
    expect(goalSummary(state, KWS_FRAME, { kind: 'target-height', targetU: 15, at: 'top' })).toBe(
      '12U → 15U: the planned sections on top become 6U.',
    )
  })

  it('keeps a reachable choice and moves an outdated one to the closest height', () => {
    const state = setGoal(kws('record', [3, 6]), {
      kind: 'target-height',
      targetU: 15,
      at: 'bottom',
    })
    expect(resolveGoal(state, KWS_FRAME)).toEqual({
      kind: 'target-height',
      targetU: 15,
      at: 'bottom',
    })
    const grown = addSection(state, KWS_FRAME, 's6', 'top')
    expect(resolveGoal(grown, KWS_FRAME)).toEqual({
      kind: 'target-height',
      targetU: 18,
      at: 'bottom',
    })
    expect(resolveGoal(setGoal(state, { kind: 'none' }), KWS_FRAME)).toEqual({ kind: 'none' })
    expect(resolveGoal(kws('new', [6]), KWS_FRAME)).toEqual({ kind: 'none' })
  })

  it('has no reachable heights on a one-piece frame', () => {
    const state = selectFrame(initialWizardState('record'), GENERIC)
    expect(goalHeights(state, GENERIC, 'top')).toEqual([])
    expect(defaultGoal(state, GENERIC)).toEqual({ kind: 'none' })
  })
})

describe('names', () => {
  it('suggests a name from the frame, the stack and the goal', () => {
    expect(suggestedName(kws('record', [3, 6]), KWS_FRAME)).toBe('KWS Rack v2: 9U → 12U')
    const asBuilt = setGoal(kws('record', [3, 6]), { kind: 'none' })
    expect(suggestedName(asBuilt, KWS_FRAME)).toBe('KWS Rack v2: 9U as built')
    expect(suggestedName(kws('new', [6, 6]), KWS_FRAME)).toBe('KWS Rack v2: new 12U')
  })
})

describe('validation', () => {
  it('needs a frame, sections, something built when recording and a name', () => {
    const empty = initialWizardState('record')
    expect(wizardIssues(empty, undefined, 'frame').map((issue) => issue.field)).toEqual(['frame'])
    expect(wizardIssues(kws('record', []), KWS_FRAME, 'stack')[0]?.message).toMatch(
      /Add the sections your rack has/,
    )
    let state = kws('record', [3, 6])
    expect(wizardIssues(state, KWS_FRAME, 'stack')).toEqual([])
    for (const section of state.sections) state = setSectionHave(state, section.key, false)
    expect(wizardIssues(state, KWS_FRAME, 'stack')[0]?.message).toMatch(/Mark at least one/)
    // A new rack has nothing built, by definition.
    expect(wizardIssues(kws('new', [3, 6]), KWS_FRAME, 'stack')).toEqual([])
    expect(wizardIssues(setName(kws('new', [6]), '   '), KWS_FRAME, 'finish')).toEqual([
      { step: 'finish', field: 'name', message: 'Give the plan a name.' },
    ])
  })

  it('checks heights of one-piece frames', () => {
    const state = selectFrame(initialWizardState('record'), GENERIC)
    const key = state.sections[0]?.key ?? ''
    expect(wizardIssues(setSectionHeight(state, key, 23), GENERIC, 'stack')).toEqual([
      {
        step: 'stack',
        field: `section:${key}`,
        message: 'Enter a whole number of U from 2 to 22.',
      },
    ])
    expect(wizardIssues(setSectionHeight(state, key, 9), GENERIC, 'stack')).toEqual([])
  })
})

describe('buildPlanFromWizard', () => {
  it('records KWS 3U + 6U and grows it to 12U on top', () => {
    const plan = buildPlanFromWizard(KWS_FRAME, LOOKUP, kws('record', [3, 6]), FIXTURE_NOW)
    expect(stackOf(plan)).toEqual([
      ['s3', true],
      ['s6', true],
      ['s3', false],
    ])
    expect(plan.frame.sections[0]?.have).toMatchObject({
      at: FIXTURE_NOW,
      typeId: 's3',
      heightU: 3,
    })
    expect(plan.frame.caps.top.have?.options).toMatchObject({ top: 'handle' })
    expect(plan.frame.caps.bottom.have).toBeDefined()
    expect(plan).toMatchObject({ name: 'KWS Rack v2: 9U → 12U', rev: 0, createdAt: FIXTURE_NOW })
    expect(plan.id).toMatch(/^plan-/)
    expect(plan.rackId).toMatch(/^rack-/)
    expect(new Set(plan.frame.sections.map((section) => section.id)).size).toBe(3)
    expect(PlanSchema.safeParse(plan).success).toBe(true)
  })

  it('adds the new 3U at the bottom when asked', () => {
    const state = setGoal(kws('record', [3, 6]), {
      kind: 'target-height',
      targetU: 12,
      at: 'bottom',
    })
    expect(stackOf(buildPlanFromWizard(KWS_FRAME, LOOKUP, state, FIXTURE_NOW))).toEqual([
      ['s3', false],
      ['s3', true],
      ['s6', true],
    ])
  })

  it('keeps everything as built for "I’ll plan it myself"', () => {
    const state = setGoal(kws('record', [3, 6]), { kind: 'none' })
    expect(stackOf(buildPlanFromWizard(KWS_FRAME, LOOKUP, state, FIXTURE_NOW))).toEqual([
      ['s3', true],
      ['s6', true],
    ])
  })

  it('plans a new 6U + 6U rack with nothing owned', () => {
    const state = setName(kws('new', [6, 6]), '  Garage rack ')
    const plan = buildPlanFromWizard(KWS_FRAME, LOOKUP, state, FIXTURE_NOW)
    expect(stackOf(plan)).toEqual([
      ['s6', false],
      ['s6', false],
    ])
    expect(plan.frame.caps.top.have).toBeUndefined()
    expect(plan.frame.caps.bottom.have).toBeUndefined()
    expect(plan.name).toBe('Garage rack')
  })

  it('stores each answer where its scope says', () => {
    let state = kws('record', [3, 6])
    state = setOptionValue(state, option('insert-policy'), 'top-bottom')
    state = setOptionValue(state, option('top'), 'flat')
    state = setOptionValue(state, option('stoppers'), true)
    state = setOptionValue(state, option('magnets'), false)
    state = setOptionValue(state, option('side-panels'), 'printed')
    const plan = buildPlanFromWizard(KWS_FRAME, LOOKUP, state, FIXTURE_NOW)

    // Rack answers, plus section answers (asked once for every section) in the rack layer.
    expect(plan.frame.options).toEqual({
      'insert-policy': 'top-bottom',
      'high-rack': false,
      'deep-320': false,
      magnets: false,
      'side-panels': 'printed',
    })
    expect(plan.frame.caps.top.options).toEqual({ top: 'flat' })
    expect(plan.frame.caps.bottom.options).toEqual({ stoppers: true })
    // Snapshots capture what was built with those answers.
    expect(plan.frame.sections[0]?.have?.options).toMatchObject({
      magnets: false,
      'insert-policy': 'top-bottom',
    })
    expect(plan.frame.sections[0]?.have?.options).not.toHaveProperty('top')
    expect(plan.frame.caps.top.have?.options).toMatchObject({ top: 'flat' })
    expect(plan.frame.caps.bottom.have?.options).toMatchObject({ stoppers: true })
    // The added planned section inherits them, and so do rack-wide lines (no rack magnets).
    const bom = computeBom(plan, LOOKUP, defaultSettings(), {})
    const magnets = bom.lines.find((line) => line.key === 'hw:magnet-10x5')
    expect(magnets?.target ?? 0).toBe(0)
    const sidePlates = bom.lines.find((line) => line.refId === 'side-plate-3u')
    expect(sidePlates?.need).toBe(2)
  })

  it('surfaces an unreachable height from setHeight on the goal step', () => {
    const state = setGoal(kws('record', [3, 6]), { kind: 'target-height', targetU: 13, at: 'top' })
    let error: unknown
    try {
      buildPlanFromWizard(KWS_FRAME, LOOKUP, state, FIXTURE_NOW)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(WizardBuildError)
    expect(error).toMatchObject({ step: 'finish', field: 'goal' })
    expect((error as Error).message).toMatch(/13U is not possible.*Try 12U or 15U/)
  })

  it('refuses incomplete answers with the step to go back to', () => {
    expect(() =>
      buildPlanFromWizard(KWS_FRAME, LOOKUP, kws('record', []), FIXTURE_NOW),
    ).toThrowError(expect.objectContaining({ step: 'stack', field: 'sections' }))
    const elsewhere = selectFrame(initialWizardState('new'), GENERIC)
    expect(() => buildPlanFromWizard(KWS_FRAME, LOOKUP, elsewhere, FIXTURE_NOW)).toThrowError(
      expect.objectContaining({ step: 'frame' }),
    )
  })

  it('records a generic rack as one section of its height', () => {
    let state = selectFrame(initialWizardState('record'), GENERIC)
    state = setSectionHeight(state, state.sections[0]?.key ?? '', 9)
    const plan = buildPlanFromWizard(GENERIC, LOOKUP, state, FIXTURE_NOW)
    expect(plan.frame.sections).toHaveLength(1)
    expect(plan.frame.sections[0]).toMatchObject({
      typeId: 'rack',
      heightU: 9,
      have: { heightU: 9, typeId: 'rack' },
    })
    expect(plan.name).toBe('Generic 10-inch rack: 9U as built')
  })

  it('carries a frame from the user’s library inside the plan', () => {
    const custom = FrameSchema.parse({ ...KWS_FRAME, id: 'custom:my-kws', name: 'My KWS' })
    const state = kws('new', [])
    const own = addSection(selectFrame(state, custom), custom, 's6', 'top')
    const plan = buildPlanFromWizard(custom, LOOKUP, own, FIXTURE_NOW)
    expect(plan.custom.frames.map((frame) => frame.id)).toEqual(['custom:my-kws'])
  })
})
