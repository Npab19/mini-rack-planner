import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { CrossTabListener } from '@/db/crossTab'
import { getDb, resetDbForTests } from '@/db/db'
import { createPlan, getPlan, savePlan } from '@/db/plansRepo'
import { FRAME, makePlan, USER_SECTIONS } from '@/domain/__fixtures__/frameFixtures'
import { samplePlan } from '@/domain/__fixtures__/samplePlan'
import { insertSection } from '@/domain/frame'
import type { Plan } from '@/domain/schema/plan'
import { getDbStatus, resetDbStatusForTests } from './dbStatus'
import {
  canRedo,
  canUndo,
  createPlanStore,
  installPlanPersistence,
  type PlanStore,
  type PlanStoreDeps,
} from './planStore'
import { createStorageRecovery, type PlanRecovery } from './recovery'

const stores: PlanStore[] = []

function makeStore(overrides: Partial<PlanStoreDeps> = {}): PlanStore {
  const store = createPlanStore(overrides)
  stores.push(store)
  return store
}

/** A store whose saves are counted. */
function spiedStore(): { store: PlanStore; save: Mock<typeof savePlan> } {
  const save = vi.fn(savePlan)
  return { store: makeStore({ savePlan: save }), save }
}

/** A stored 3U + 6U plan (both sections owned). */
function storedPlan(): Promise<Plan> {
  return createPlan(makePlan({ sections: USER_SECTIONS }))
}

/** Only setTimeout is faked: fake-indexeddb schedules its work with (real) setImmediate. */
function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

function rename(store: PlanStore, name: string): boolean {
  return store.getState().edit((draft) => {
    draft.name = name
  })
}

function pastSteps(store: PlanStore): number {
  return store.temporal.getState().pastStates.length
}

beforeEach(async () => {
  await resetDbForTests()
  resetDbStatusForTests()
})

afterEach(async () => {
  vi.useRealTimers()
  // Flush and close every store, so no autosave outlives its test.
  for (const store of stores.splice(0)) await store.getState().unload()
})

describe('loading', () => {
  it('loads the stored plan with an empty history', async () => {
    const plan = await storedPlan()
    const other = await createPlan(samplePlan())
    const store = makeStore()
    await store.getState().load(plan.id)
    expect(store.getState()).toMatchObject({
      planId: plan.id,
      status: 'ready',
      rev: 1,
      readOnly: false,
      saveState: 'saved',
      conflict: null,
    })
    expect(store.getState().plan?.name).toBe('Test plan')
    expect(canUndo(store)).toBe(false)

    expect(store.getState().renamePlan('  Edited ')).toBe(true)
    expect(store.getState().plan?.name).toBe('Edited')
    expect(store.getState().renamePlan('   ')).toBe(false)
    expect(canUndo(store)).toBe(true)
    // Opening the plan that is already open keeps its history.
    await store.getState().load(plan.id)
    expect(canUndo(store)).toBe(true)

    await store.getState().load(other.id)
    expect(store.getState().plan?.id).toBe(other.id)
    expect(canUndo(store)).toBe(false)
    // Switching saved the first plan's pending edit.
    expect((await getPlan(plan.id)).plan.name).toBe('Edited')
  })

  it('reports a missing plan', async () => {
    const store = makeStore()
    await store.getState().load('plan-missing')
    expect(store.getState()).toMatchObject({ status: 'not-found', plan: null })
    expect(store.getState().error).toMatch(/not in this browser/)
  })

  it('opens a plan from a newer app read-only and never saves it', async () => {
    const plan = samplePlan()
    await getDb().plans.put({
      id: plan.id,
      rackId: plan.rackId,
      name: plan.name,
      updatedAt: plan.updatedAt,
      rev: 4,
      schema: 2,
      plan: { ...plan, schema: 2 },
    })
    const { store, save } = spiedStore()
    await store.getState().load(plan.id)
    expect(store.getState()).toMatchObject({ status: 'ready', readOnly: true, rev: 4 })
    expect(store.getState().warnings).toHaveLength(1)
    expect(rename(store, 'Nope')).toBe(false)
    expect(store.getState().renamePlan('Nope')).toBe(false)
    expect(store.getState().applyOp((current) => ({ plan: { ...current, name: 'Nope' } }))).toEqual(
      { applied: false, conflicts: [], error: 'No editable plan is open.' },
    )
    expect(await store.getState().flushSave()).toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(store.getState().plan?.name).toBe(plan.name)
  })
})

describe('editing and history', () => {
  it('edits, undoes and redoes, one step per edit', async () => {
    const plan = await storedPlan()
    const store = makeStore()
    await store.getState().load(plan.id)
    const { edit, undo, redo } = store.getState()

    expect(rename(store, 'A')).toBe(true)
    const addNote = () =>
      edit((draft) => {
        draft.notes = 'B'
      })
    expect(addNote()).toBe(true)
    expect(addNote()).toBe(false)
    expect(pastSteps(store)).toBe(2)

    undo()
    expect(store.getState().plan?.notes).toBeUndefined()
    expect(store.getState().plan?.name).toBe('A')
    undo()
    expect(store.getState().plan?.name).toBe('Test plan')
    expect(canUndo(store)).toBe(false)
    redo()
    expect(store.getState().plan?.name).toBe('A')
    expect(canRedo(store)).toBe(true)
    // A new edit drops the redo branch.
    rename(store, 'C')
    expect(canRedo(store)).toBe(false)
  })

  it('applies a stack operation as one step and leaves the plan alone when it fails', async () => {
    const plan = await storedPlan()
    const store = makeStore()
    await store.getState().load(plan.id)
    const before = store.getState().plan

    const failed = store.getState().applyOp((current) => insertSection(current, FRAME, 9, 's3'))
    expect(failed.applied).toBe(false)
    expect(failed.error).toMatch(/outside a stack/)
    expect(store.getState().plan).toBe(before)
    expect(pastSteps(store)).toBe(0)

    const inserted = store.getState().applyOp((current) => insertSection(current, FRAME, 0, 's6'))
    expect(inserted).toEqual({ applied: true, conflicts: [] })
    // 9U + 6U + 6U would pass the frame's 18U maximum.
    const tooTall = store.getState().applyOp((current) => insertSection(current, FRAME, 0, 's6'))
    expect(tooTall).toMatchObject({ applied: false, conflicts: [{ kind: 'out-of-bounds' }] })

    expect(store.getState().plan?.frame.sections).toHaveLength(3)
    expect(pastSteps(store)).toBe(1)
    store.getState().undo()
    expect(store.getState().plan).toBe(before)
  })

  it('records a gesture as a single undo step, or nothing when cancelled', async () => {
    const plan = await storedPlan()
    const store = makeStore()
    await store.getState().load(plan.id)
    const { beginGesture, endGesture, cancelGesture, undo } = store.getState()

    beginGesture()
    for (const name of ['drag 1', 'drag 2', 'drag 3']) rename(store, name)
    endGesture()
    expect(store.getState().plan?.name).toBe('drag 3')
    expect(pastSteps(store)).toBe(1)
    undo()
    expect(store.getState().plan?.name).toBe('Test plan')

    beginGesture()
    rename(store, 'moving')
    cancelGesture()
    expect(store.getState().plan?.name).toBe('Test plan')
    expect(pastSteps(store)).toBe(0)
    // Nothing happened, so the redo branch survives.
    expect(canRedo(store)).toBe(true)
  })
  it('runs every applied op through the op finisher, in the same undo step', async () => {
    const plan = await storedPlan()
    const store = makeStore()
    await store.getState().load(plan.id)
    const before = store.getState().plan
    const finisher = vi.fn((current: Plan) => ({ ...current, notes: 'finished' }))
    store.getState().setOpFinisher(finisher)

    const failed = store.getState().applyOp((current) => insertSection(current, FRAME, 9, 's3'))
    expect(failed.applied).toBe(false)
    expect(finisher).not.toHaveBeenCalled()

    store.getState().applyOp((current) => ({ plan: { ...current, name: 'Renamed' } }))
    expect(store.getState().plan).toMatchObject({ name: 'Renamed', notes: 'finished' })
    expect(pastSteps(store)).toBe(1)
    store.getState().undo()
    expect(store.getState().plan).toBe(before)

    // A failing finisher keeps the op's own result; a cleared one is not called.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    store.getState().setOpFinisher(() => {
      throw new Error('broken finisher')
    })
    store.getState().applyOp((current) => ({ plan: { ...current, name: 'Again' } }))
    expect(store.getState().plan?.name).toBe('Again')
    store.getState().setOpFinisher(null)
    finisher.mockClear()
    store.getState().applyOp((current) => ({ plan: { ...current, name: 'Plain' } }))
    expect(finisher).not.toHaveBeenCalled()
    expect(store.getState().plan?.notes).not.toBe('finished')
  })
})

describe('autosave', () => {
  it('debounces edits into one save and flushes on demand', async () => {
    const plan = await storedPlan()
    const { store, save } = spiedStore()
    await store.getState().load(plan.id)
    fakeTimers()

    rename(store, 'One')
    expect(store.getState().saveState).toBe('dirty')
    await vi.advanceTimersByTimeAsync(300)
    rename(store, 'Two')
    await vi.advanceTimersByTimeAsync(399)
    expect(save).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(await store.getState().flushSave()).toBe(true)
    expect(store.getState()).toMatchObject({ saveState: 'saved', rev: 2, lastError: null })
    expect((await getPlan(plan.id)).plan.name).toBe('Two')

    // flushSave saves right away, without waiting for the debounce.
    rename(store, 'Three')
    expect(await store.getState().flushSave()).toBe(true)
    expect(save).toHaveBeenCalledTimes(2)
    expect((await getPlan(plan.id)).rev).toBe(3)
    expect(store.getState().rev).toBe(3)
  })

  it('does not save when undo returns to the stored version', async () => {
    const plan = await storedPlan()
    const { store, save } = spiedStore()
    await store.getState().load(plan.id)
    fakeTimers()
    rename(store, 'Oops')
    store.getState().undo()
    expect(store.getState().saveState).toBe('saved')
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).not.toHaveBeenCalled()
  })

  it('waits for the end of a gesture before saving', async () => {
    const plan = await storedPlan()
    const { store, save } = spiedStore()
    await store.getState().load(plan.id)
    fakeTimers()
    store.getState().beginGesture()
    rename(store, 'Dragging')
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).not.toHaveBeenCalled()
    store.getState().endGesture()
    await vi.advanceTimersByTimeAsync(400)
    expect(save).toHaveBeenCalledTimes(1)
    expect(await store.getState().flushSave()).toBe(true)
    expect((await getPlan(plan.id)).plan.name).toBe('Dragging')
  })

  it('serializes concurrent flushes, so a tab never conflicts with itself', async () => {
    const plan = await storedPlan()
    const { store, save } = spiedStore()
    await store.getState().load(plan.id)
    rename(store, 'Once')
    // visibilitychange, pagehide and an update prompt can all flush at the same moment.
    const flushes = [1, 2, 3].map(() => store.getState().flushSave())
    expect(await Promise.all(flushes)).toEqual([true, true, true])
    expect(save).toHaveBeenCalledTimes(1)

    // An edit made while a save is in flight is saved after it, on the new revision.
    rename(store, 'Twice')
    const first = store.getState().flushSave()
    rename(store, 'Thrice')
    expect(await Promise.all([first, store.getState().flushSave()])).toEqual([false, true])
    expect(store.getState()).toMatchObject({ conflict: null, saveState: 'saved', rev: 4 })
    expect((await getPlan(plan.id)).plan.name).toBe('Thrice')
  })

  it('unload saves pending edits', async () => {
    const plan = await storedPlan()
    const store = makeStore()
    await store.getState().load(plan.id)
    rename(store, 'Saved on the way out')
    await store.getState().unload()
    expect(store.getState()).toMatchObject({ status: 'idle', plan: null, planId: null })
    expect((await getPlan(plan.id)).plan.name).toBe('Saved on the way out')
  })
})

describe('conflicts', () => {
  it('stops autosaving after a conflict until the plan is reloaded', async () => {
    const plan = await storedPlan()
    const { store, save } = spiedStore()
    await store.getState().load(plan.id)
    fakeTimers()
    // Another tab saves first.
    await savePlan({ ...plan, name: 'Other tab' }, 1)

    rename(store, 'This tab')
    expect(await store.getState().flushSave()).toBe(false)
    expect(store.getState()).toMatchObject({ conflict: { theirRev: 2 }, saveState: 'error' })
    expect(store.getState().lastError).toMatch(/changed in another tab/)
    expect(getDbStatus().conflict).toEqual({ planId: plan.id, theirRev: 2 })

    rename(store, 'Still this tab')
    await vi.advanceTimersByTimeAsync(2000)
    expect(await store.getState().flushSave()).toBe(false)
    expect(save).toHaveBeenCalledTimes(1)
    expect((await getPlan(plan.id)).plan.name).toBe('Other tab')

    await store.getState().reloadFromDb()
    expect(store.getState()).toMatchObject({ conflict: null, saveState: 'saved', rev: 2 })
    expect(store.getState().plan?.name).toBe('Other tab')
    expect(canUndo(store)).toBe(false)
    expect(getDbStatus().conflict).toBeNull()

    rename(store, 'After reload')
    expect(await store.getState().flushSave()).toBe(true)
    expect((await getPlan(plan.id)).rev).toBe(3)
  })

  it('saves the local version as a copy, Have marks included', async () => {
    const plan = await storedPlan()
    const store = makeStore()
    await store.getState().load(plan.id)
    await savePlan({ ...plan, name: 'Other tab' }, 1)
    rename(store, 'Mine')
    await store.getState().flushSave()
    expect(store.getState().conflict).not.toBeNull()

    const copyId = await store.getState().saveAsCopy()
    expect(copyId).not.toBe(plan.id)
    const copy = (await getPlan(copyId)).plan
    expect(copy.name).toBe('Mine (copy)')
    expect(copy.rackId).toBe(plan.rackId)
    expect(copy.frame.sections.map((section) => section.have !== undefined)).toEqual([true, true])
    expect((await getPlan(plan.id)).plan.name).toBe('Other tab')
  })

  it('treats another tab’s save or delete notice as a conflict', async () => {
    const plan = await storedPlan()
    let notify: CrossTabListener = () => {}
    const store = makeStore({
      subscribeRemote: (listener) => {
        notify = listener
        return () => {}
      },
    })
    await store.getState().load(plan.id)

    notify({ type: 'plan-saved', id: plan.id, rev: 1, tabId: 'tab-other' })
    notify({ type: 'plan-saved', id: 'plan-else', rev: 9, tabId: 'tab-other' })
    expect(store.getState().conflict).toBeNull()

    notify({ type: 'plan-saved', id: plan.id, rev: 2, tabId: 'tab-other' })
    expect(store.getState().conflict).toEqual({ theirRev: 2 })
    notify({ type: 'plan-deleted', id: plan.id, tabId: 'tab-other' })
    expect(store.getState().conflict).toEqual({ theirRev: null })
    expect(getDbStatus().conflict).toEqual({ planId: plan.id, theirRev: null })
  })
})

describe('edits after a conflict', () => {
  it('count as unsaved and are never saved over the other tab’s version', async () => {
    const plan = await storedPlan()
    let notify: CrossTabListener = () => {}
    const save = vi.fn(savePlan)
    const store = makeStore({
      savePlan: save,
      subscribeRemote: (listener) => {
        notify = listener
        return () => {}
      },
    })
    await store.getState().load(plan.id)
    fakeTimers()
    notify({ type: 'plan-saved', id: plan.id, rev: 2, tabId: 'tab-other' })
    expect(store.getState()).toMatchObject({ conflict: { theirRev: 2 }, saveState: 'saved' })

    rename(store, 'Mine')
    expect(store.getState().saveState).toBe('dirty')
    await vi.advanceTimersByTimeAsync(2000)
    expect(await store.getState().flushSave()).toBe(false)
    expect(save).not.toHaveBeenCalled()
    // Undoing back to the stored version leaves nothing unsaved.
    store.getState().undo()
    expect(store.getState().saveState).toBe('saved')
  })
})

/** A Web Storage area in memory (what localStorage keeps between page loads). */
function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key)
    },
    setItem: (key, value) => {
      data.set(key, String(value))
    },
  }
}

describe('recovery after a reload', () => {
  /**
   * A tab about to unload: its autosave timer never fires (fake timers) and its save is never
   * awaited, like a page torn down mid-save. It is not unloaded after the test either.
   */
  function dyingStore(recovery: PlanRecovery): PlanStore {
    return createPlanStore({ recovery })
  }

  it('keeps edits whose save the unload cut off, and saves them on the next load', async () => {
    const plan = await storedPlan()
    const storage = memoryStorage()
    const recovery = createStorageRecovery(() => storage)
    const before = dyingStore(recovery)
    await before.getState().load(plan.id)
    fakeTimers()
    rename(before, 'Typed, then reloaded')
    before.getState().stashUnsaved()
    expect(storage.length).toBe(1)

    const after = makeStore({ recovery })
    await after.getState().load(plan.id)
    expect(after.getState()).toMatchObject({ rev: 1, saveState: 'dirty' })
    expect(after.getState().plan?.name).toBe('Typed, then reloaded')
    // Taken once: a later load does not apply it again.
    expect(storage.length).toBe(0)
    expect(await after.getState().flushSave()).toBe(true)
    expect(await getPlan(plan.id)).toMatchObject({ rev: 2, plan: { name: 'Typed, then reloaded' } })
  })

  it('drops kept edits when another save won meanwhile', async () => {
    const plan = await storedPlan()
    const storage = memoryStorage()
    const recovery = createStorageRecovery(() => storage)
    const before = dyingStore(recovery)
    await before.getState().load(plan.id)
    fakeTimers()
    rename(before, 'Lost to the other tab')
    before.getState().stashUnsaved()
    await savePlan({ ...plan, name: 'Other tab' }, 1)

    const after = makeStore({ recovery })
    await after.getState().load(plan.id)
    expect(after.getState()).toMatchObject({ rev: 2, saveState: 'saved' })
    expect(after.getState().plan?.name).toBe('Other tab')
    expect(storage.length).toBe(0)
  })

  it('keeps edits made while a save was in flight, also when that save landed', async () => {
    const plan = await storedPlan()
    const storage = memoryStorage()
    const recovery = createStorageRecovery(() => storage)
    const before = dyingStore(recovery)
    await before.getState().load(plan.id)
    fakeTimers()
    rename(before, 'Saving')
    const landing = before.getState().flushSave()
    rename(before, 'Typed during the save')
    before.getState().stashUnsaved()
    await landing
    expect(await getPlan(plan.id)).toMatchObject({ rev: 2, plan: { name: 'Saving' } })

    const after = makeStore({ recovery })
    await after.getState().load(plan.id)
    expect(after.getState().plan?.name).toBe('Typed during the save')
    expect(await after.getState().flushSave()).toBe(true)
    expect(await getPlan(plan.id)).toMatchObject({ rev: 3 })
  })

  it('keeps nothing when everything is saved, or for a conflict', async () => {
    const plan = await storedPlan()
    const storage = memoryStorage()
    const store = makeStore({ recovery: createStorageRecovery(() => storage) })
    await store.getState().load(plan.id)
    rename(store, 'Saved')
    await store.getState().flushSave()
    store.getState().stashUnsaved()
    expect(storage.length).toBe(0)

    await savePlan({ ...plan, name: 'Other tab' }, 2)
    rename(store, 'Conflicted')
    expect(await store.getState().flushSave()).toBe(false)
    store.getState().stashUnsaved()
    expect(storage.length).toBe(0)
  })

  it('ignores damaged or foreign entries, and blocked storage', async () => {
    const plan = await storedPlan()
    const storage = memoryStorage()
    storage.setItem(`mrp-unsaved:${plan.id}`, '{"v":1,"baseRev":1,"plan":{"id":"other"}}')
    const store = makeStore({ recovery: createStorageRecovery(() => storage) })
    await store.getState().load(plan.id)
    expect(store.getState()).toMatchObject({ saveState: 'saved', plan: { name: 'Test plan' } })
    expect(storage.length).toBe(0)

    const blocked = makeStore({
      recovery: createStorageRecovery(() => {
        throw new DOMException('Blocked', 'SecurityError')
      }),
    })
    await blocked.getState().load(plan.id)
    rename(blocked, 'Still editable')
    expect(() => blocked.getState().stashUnsaved()).not.toThrow()
  })
})

describe('installPlanPersistence', () => {
  it('stashes and saves on hide, joins the reload and drain registries, and uninstalls', async () => {
    const plan = await storedPlan()
    const storage = memoryStorage()
    const store = makeStore({ recovery: createStorageRecovery(() => storage) })
    await store.getState().load(plan.id)
    const doc = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as DocumentVisibilityState,
    })
    const win = new EventTarget()
    const reloadHooks: Array<() => unknown> = []
    const drains: Array<() => unknown> = []
    const register = (list: Array<() => unknown>) => (hook: () => unknown) => {
      list.push(hook)
      return () => {
        list.splice(list.indexOf(hook), 1)
      }
    }
    const hooks = { registerBeforeReload: register(reloadHooks), registerDbDrain: register(drains) }
    const page = { document: doc, window: win }
    const uninstall = installPlanPersistence(hooks, store, page)
    // Idempotent per store.
    expect(installPlanPersistence(hooks, store, page)).toBe(uninstall)
    expect([reloadHooks.length, drains.length]).toEqual([1, 1])

    rename(store, 'Hidden')
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    // The copy is written synchronously, before the asynchronous save.
    expect(storage.length).toBe(1)
    await vi.waitFor(() => expect(store.getState().saveState).toBe('saved'))
    expect(storage.length).toBe(0)
    expect((await getPlan(plan.id)).plan.name).toBe('Hidden')

    rename(store, 'Before reload')
    expect(await reloadHooks[0]?.()).toBe(true)
    expect(await drains[0]?.()).toBe(true)
    rename(store, 'Page hide')
    win.dispatchEvent(new Event('pagehide'))
    await vi.waitFor(() => expect(store.getState().saveState).toBe('saved'))
    expect((await getPlan(plan.id)).plan.name).toBe('Page hide')

    uninstall()
    expect([reloadHooks.length, drains.length]).toEqual([0, 0])
    rename(store, 'Not stashed')
    win.dispatchEvent(new Event('pagehide'))
    expect(storage.length).toBe(0)
  })
})
