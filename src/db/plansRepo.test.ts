import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FRAME, makePlan, USER_SECTIONS } from '@/domain/__fixtures__/frameFixtures'
import { sampleCatalog, samplePlan } from '@/domain/__fixtures__/samplePlan'
import { PlanInvalidError } from '@/domain/migrate'
import type { Plan } from '@/domain/schema/plan'
import { getDb, resetDbForTests } from './db'
import { PlanConflictError, PlanNotFoundError, PlanReadOnlyError } from './errors'
import {
  createPlan,
  deletePlan,
  duplicatePlan,
  getPlan,
  listPlans,
  listPlanSummaries,
  renamePlan,
  savePlan,
} from './plansRepo'

beforeEach(async () => {
  await resetDbForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Every entity id in a plan (plan, sections, placements, devices, equipment, extras, retired). */
function entityIds(plan: Plan): string[] {
  return [
    plan.id,
    ...plan.frame.sections.map((section) => section.id),
    ...plan.placements.flatMap((placement) => [
      placement.id,
      ...placement.devices.map((device) => device.id),
    ]),
    ...plan.equipment.map((entry) => entry.id),
    ...plan.extras.map((extra) => extra.id),
    ...plan.retired.map((entry) => entry.id),
  ]
}

describe('plan CRUD', () => {
  it('creates at rev 1, reads, saves with the next revision and deletes', async () => {
    const sample = samplePlan()
    const created = await createPlan(sample)
    expect(created.rev).toBe(1)
    expect(created.updatedAt).not.toBe(sample.updatedAt)
    expect(created.createdAt).toBe(created.updatedAt)

    const loaded = await getPlan(sample.id)
    expect(loaded).toMatchObject({ rev: 1, readOnly: false, warnings: [] })
    expect(loaded.plan).toEqual(created)

    const rev = await savePlan({ ...loaded.plan, name: 'Renamed' }, loaded.rev)
    expect(rev).toBe(2)
    const saved = await getPlan(sample.id)
    expect(saved.rev).toBe(2)
    expect(saved.plan.name).toBe('Renamed')
    expect(saved.plan.rev).toBe(2)
    expect(saved.plan.placements).toHaveLength(6)

    await deletePlan(sample.id)
    await expect(getPlan(sample.id)).rejects.toBeInstanceOf(PlanNotFoundError)
  })

  it('validates plans before writing them', async () => {
    const bad = { ...samplePlan(), frame: { ...samplePlan().frame, frameId: 'Not Kebab' } }
    await expect(createPlan(bad)).rejects.toBeInstanceOf(PlanInvalidError)
    expect(await getDb().plans.count()).toBe(0)
  })

  it('refuses a stale revision (compare-and-swap) and writes nothing', async () => {
    const plan = await createPlan(samplePlan())
    expect(await savePlan({ ...plan, name: 'First tab' }, 1)).toBe(2)

    const conflict = await savePlan({ ...plan, name: 'Second tab' }, 1).catch((error) => error)
    expect(conflict).toBeInstanceOf(PlanConflictError)
    expect(conflict).toMatchObject({ planId: plan.id, theirRev: 2 })
    expect((await getPlan(plan.id)).plan.name).toBe('First tab')

    await deletePlan(plan.id)
    const deleted = await savePlan(plan, 2).catch((error) => error)
    expect(deleted).toMatchObject({ name: 'PlanConflictError', theirRev: null })
    expect(await getDb().plans.count()).toBe(0)
  })

  it('renames with a new revision and an optional compare-and-swap', async () => {
    const plan = await createPlan(samplePlan())
    expect(await renamePlan(plan.id, '  Garage rack  ')).toBe(2)
    expect((await getPlan(plan.id)).plan.name).toBe('Garage rack')
    await expect(renamePlan(plan.id, 'Stale', 1)).rejects.toBeInstanceOf(PlanConflictError)
    await expect(renamePlan(plan.id, '   ')).rejects.toBeInstanceOf(PlanInvalidError)
    await expect(renamePlan('plan-missing', 'x')).rejects.toBeInstanceOf(PlanNotFoundError)
  })
})

describe('listPlanSummaries', () => {
  it('lists plans newest first with stack facts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T10:00:00.000Z'))
    const sample = await createPlan(samplePlan())
    vi.setSystemTime(new Date('2026-10-02T10:00:00.000Z'))
    const user = await createPlan(makePlan({ sections: USER_SECTIONS }))

    const summaries = await listPlanSummaries(sampleCatalog())
    expect(summaries.map((summary) => summary.id)).toEqual([user.id, sample.id])
    expect(summaries[1]).toEqual({
      id: sample.id,
      rackId: sample.rackId,
      name: 'KWS 9U → 12U',
      frameId: 'kws-v2',
      frameName: 'KWS Rack v2 (fixture)',
      heightU: 12,
      sectionHeightsU: [3, 6, 3],
      sectionCount: 3,
      haveSectionCount: 2,
      placementCount: 6,
      // The same counts as planStats on the validated plan (state/derived.test.ts).
      haveCount: 12,
      needCount: 5,
      updatedAt: '2026-10-01T10:00:00.000Z',
      readOnly: false,
    })
    // The fixture frame is not in this catalog: heights come from what was built, no name.
    expect(summaries[0]).toMatchObject({
      frameId: 'test-frame',
      heightU: 9,
      sectionHeightsU: [3, 6],
      haveSectionCount: 2,
    })
    expect(summaries[0]?.frameName).toBeUndefined()
  })

  it('names a plan’s own custom frame', async () => {
    const plan = makePlan({ sections: USER_SECTIONS })
    const ownFrame = { ...FRAME, id: 'custom:my-frame', name: 'My frame' }
    await createPlan({
      ...plan,
      frame: { ...plan.frame, frameId: ownFrame.id },
      custom: { ...plan.custom, frames: [ownFrame] },
    })
    const [summary] = await listPlanSummaries(sampleCatalog())
    expect(summary).toMatchObject({ frameName: 'My frame', heightU: 9, needCount: 0 })
  })

  it('falls back to section heights without a catalog', async () => {
    await createPlan(samplePlan())
    const [summary] = await listPlanSummaries()
    // The planned top 3U has no snapshot, so only the built 3U + 6U count.
    expect(summary?.heightU).toBe(9)
  })
})

describe('listPlans', () => {
  it('reads every plan newest first and leaves out the ones it cannot read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T10:00:00.000Z'))
    const sample = await createPlan(samplePlan())
    vi.setSystemTime(new Date('2026-10-02T10:00:00.000Z'))
    const user = await createPlan(makePlan({ sections: USER_SECTIONS }))
    const broken = { ...user, id: 'plan-broken', updatedAt: '2026-10-03T10:00:00.000Z' }
    await getDb().plans.put({
      id: broken.id,
      rackId: broken.rackId,
      name: 'Broken',
      updatedAt: broken.updatedAt,
      rev: 1,
      schema: broken.schema,
      plan: { ...broken, frame: 'not a frame' } as unknown as Plan,
    })

    const plans = await listPlans()
    expect(plans.map((loaded) => loaded.plan.id)).toEqual([user.id, sample.id])
    expect(plans[1]?.plan.name).toBe('KWS 9U → 12U')
    expect(plans.every((loaded) => !loaded.readOnly)).toBe(true)
  })
})

describe('duplicatePlan', () => {
  it('gives every entity a new id and resets ownership on request', async () => {
    const original = await createPlan(samplePlan())
    const copy = await duplicatePlan(original.id, { resetHave: true, sameRack: false })

    const originalIds = new Set(entityIds(original))
    expect(entityIds(copy).filter((id) => originalIds.has(id))).toEqual([])
    expect(copy.name).toBe('KWS 9U → 12U (copy)')
    expect(copy.rackId).not.toBe(original.rackId)
    expect(copy.rev).toBe(1)

    expect(copy.frame.sections).toHaveLength(3)
    expect(copy.frame.sections.every((section) => section.have === undefined)).toBe(true)
    expect(copy.frame.caps.top.have).toBeUndefined()
    expect(copy.frame.caps.bottom.have).toBeUndefined()
    expect(copy.frame.caps.top.options).toEqual({ top: 'handle' })
    expect(copy.placements).toHaveLength(6)
    expect(copy.placements.every((placement) => placement.have === undefined)).toBe(true)
    const devices = copy.placements.flatMap((placement) => placement.devices)
    expect(devices).toHaveLength(5)
    expect(devices.every((device) => !device.have)).toBe(true)
    expect(copy.equipment.every((entry) => !entry.have)).toBe(true)
    expect(copy.extras).toEqual([expect.objectContaining({ qty: 4, haveQty: 0 })])
    expect(copy.retired).toEqual([])
    // Catalog ids (including the plan's custom entries) stay.
    expect(copy.custom.devices.map((device) => device.id)).toEqual(['custom:diy-n100-nas'])
    expect(copy.placements[1]?.label).toBe('Proxmox 1')

    expect((await getPlan(copy.id)).plan).toEqual(copy)
    expect((await getPlan(original.id)).plan).toEqual(original)
  })

  it('keeps ownership and the rack when asked', async () => {
    const original = await createPlan(samplePlan())
    const copy = await duplicatePlan(original.id, {
      name: 'Next idea',
      resetHave: false,
      sameRack: true,
    })
    expect(copy.name).toBe('Next idea')
    expect(copy.rackId).toBe(original.rackId)
    expect(copy.frame.sections[0]?.have).toEqual(original.frame.sections[0]?.have)
    expect(copy.placements[1]?.devices[0]?.have).toBe(true)
    expect(copy.retired).toHaveLength(1)
    expect(copy.retired[0]?.id).not.toBe(original.retired[0]?.id)
  })
})

describe('plans from a newer app version', () => {
  async function storeNewer(): Promise<Plan> {
    const plan = samplePlan()
    await getDb().plans.put({
      id: plan.id,
      rackId: plan.rackId,
      name: plan.name,
      updatedAt: plan.updatedAt,
      rev: 3,
      schema: 2,
      plan: { ...plan, schema: 2, rev: 3, someFutureField: { x: 1 } },
    })
    return plan
  }

  it('opens read-only, is listed as read-only and is never overwritten', async () => {
    const plan = await storeNewer()
    const loaded = await getPlan(plan.id)
    expect(loaded).toMatchObject({ readOnly: true, rev: 3 })
    expect(loaded.warnings).toHaveLength(1)
    expect(loaded.plan.name).toBe(plan.name)

    await expect(savePlan(loaded.plan, 3)).rejects.toBeInstanceOf(PlanReadOnlyError)
    await expect(renamePlan(plan.id, 'x')).rejects.toBeInstanceOf(PlanReadOnlyError)
    const [summary] = await listPlanSummaries(sampleCatalog())
    expect(summary).toMatchObject({ readOnly: true, heightU: 12 })
    const row = await getDb().plans.get(plan.id)
    expect(row?.plan).toMatchObject({ schema: 2, someFutureField: { x: 1 } })
  })

  it('can be duplicated into an editable copy', async () => {
    const plan = await storeNewer()
    const copy = await duplicatePlan(plan.id, { resetHave: false, sameRack: true })
    const loaded = await getPlan(copy.id)
    expect(loaded.readOnly).toBe(false)
    expect(loaded.plan.schema).toBe(1)
  })
})
