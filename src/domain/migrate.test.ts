import { describe, expect, it } from 'vitest'
import {
  CURRENT_PLAN_SCHEMA,
  migratePlan,
  parseNewerPlanReadOnly,
  PlanInvalidError,
  PlanLoadError,
  PlanTooNewError,
  runMigrations,
  type PlanMigration,
} from './migrate'

const NOW = '2026-10-11T09:30:00.000Z'
const v1 = {
  schema: 1,
  id: 'plan-abc123',
  rackId: 'rack-abc123',
  name: 'Sample',
  createdAt: NOW,
  updatedAt: NOW,
  frame: { frameId: 'kws-v2', sections: [{ id: 'sec-1', typeId: 's3' }] },
}

describe('migratePlan', () => {
  it('passes a current plan through validation', () => {
    const { plan, warnings } = migratePlan(v1)
    expect(CURRENT_PLAN_SCHEMA).toBe(1)
    expect(plan.schema).toBe(1)
    expect(plan.frame.sections).toHaveLength(1)
    expect(plan.placements).toEqual([])
    expect(warnings).toEqual([])
  })

  it('does not mutate its input', () => {
    const input = structuredClone(v1)
    migratePlan(input)
    expect(input).toEqual(v1)
  })

  it('reads a plan without a schema version as the current one, with a warning', () => {
    const unversioned: Record<string, unknown> = { ...v1 }
    delete unversioned.schema
    const { plan, warnings } = migratePlan(unversioned)
    expect(plan.schema).toBe(1)
    expect(warnings).toHaveLength(1)
  })

  it('refuses plans from a newer app version with a typed error', () => {
    const newer = { ...v1, schema: 2, extraField: true }
    const error = catchError(() => migratePlan(newer))
    expect(error).toBeInstanceOf(PlanTooNewError)
    expect(error).toBeInstanceOf(PlanLoadError)
    expect(error).toMatchObject({ found: 2, supported: 1, name: 'PlanTooNewError' })
    expect(parseNewerPlanReadOnly(newer)?.name).toBe('Sample')
    expect(parseNewerPlanReadOnly({ schema: 2 })).toBeUndefined()
  })

  it('rejects non-plans and invalid plans with issues', () => {
    for (const input of [null, 'plan', [v1], 42]) {
      expect(catchError(() => migratePlan(input))).toBeInstanceOf(PlanInvalidError)
    }
    expect(catchError(() => migratePlan({ ...v1, schema: 'one' }))).toBeInstanceOf(PlanInvalidError)
    expect(catchError(() => migratePlan({ ...v1, schema: 0 }))).toBeInstanceOf(PlanInvalidError)
    const invalid = catchError(() => migratePlan({ ...v1, frame: { frameId: 'Bad Id' } }))
    expect(invalid).toBeInstanceOf(PlanInvalidError)
    expect((invalid as PlanInvalidError).issues).toEqual([
      expect.objectContaining({ path: 'frame.frameId' }),
    ])
  })
})

describe('runMigrations', () => {
  // Listed out of order on purpose: the chain follows `from`, not array order.
  const steps: PlanMigration[] = [
    {
      from: 2,
      up: (doc, warnings) => {
        warnings.push('2 -> 3')
        return { ...doc, c: true }
      },
    },
    {
      from: 1,
      up: (doc, warnings) => {
        warnings.push('1 -> 2')
        return { ...doc, b: true }
      },
    },
  ]

  it('applies the steps in version order and stamps the schema', () => {
    const warnings: string[] = []
    const result = runMigrations({ schema: 1, a: true }, 1, 3, steps, warnings)
    expect(result).toEqual({ schema: 3, a: true, b: true, c: true })
    expect(warnings).toEqual(['1 -> 2', '2 -> 3'])
  })

  it('starts from the given version and needs a complete chain', () => {
    expect(runMigrations({ schema: 2 }, 2, 3, steps, [])).toEqual({ schema: 3, c: true })
    expect(() => runMigrations({ schema: 3 }, 3, 4, steps, [])).toThrow(PlanInvalidError)
  })
})

function catchError(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected an error')
}
