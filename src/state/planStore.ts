/**
 * The open plan: a Zustand store with immer (draft edits) and zundo (undo/redo).
 *
 * History holds the plan document only (`partialize`), compared by reference (`equality`), at most
 * 100 steps. It is cleared whenever a plan is loaded, reloaded or unloaded. A gesture (a drag)
 * pauses it and records a single step when it ends.
 *
 * Autosave: every change of `plan` (edits, undo, redo; never loads) is saved ~400 ms after the
 * last one, with the stored revision as a compare-and-swap. Saves run one at a time. A conflict
 * (another tab saved or deleted the plan) stops autosaving until the user reloads or saves a copy;
 * read-only plans (newer schema) are never saved. `installPlanPersistence` (main.tsx) flushes
 * pending work when the tab is hidden or closed, before an app reload and before another tab
 * upgrades the database; on hide it also keeps a synchronous recovery copy (`recovery.ts`), because
 * a save started while the page unloads never finishes.
 *
 * `plan.rev` / `plan.updatedAt` inside the store are as loaded: the store's `rev` is authoritative
 * and the repository stamps both on every save.
 */
import type { Draft } from 'immer'
import { temporal, type TemporalState } from 'zundo'
import { create, useStore, type StoreApi } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { canonicalJson } from '@/catalog/revision'
import { subscribeCrossTab, type CrossTabListener, type CrossTabMessage } from '@/db/crossTab'
import { isDbSuperseded } from '@/db/db'
import { errorMessage, PlanConflictError, PlanNotFoundError, StorageFullError } from '@/db/errors'
import { clonePlanWithNewIds, copyName } from '@/db/planCopy'
import {
  createPlan,
  getPlan,
  nowIso,
  savePlan,
  validPlanName,
  type LoadedPlan,
} from '@/db/plansRepo'
import type { StackConflict, StackOpResult } from '@/domain/api'
import { migratePlan } from '@/domain/migrate'
import type { Plan } from '@/domain/schema/plan'
import { clearDbStatus, reportDbStatus } from './dbStatus'
import { localRecovery, type PlanRecovery, type RecoveryEntry } from './recovery'
import { useUiStore } from './uiStore'

export const AUTOSAVE_DELAY_MS = 400
export const HISTORY_LIMIT = 100

export type PlanStatus = 'idle' | 'loading' | 'ready' | 'not-found' | 'error'
/** saved: stored; dirty: a save is due; saving: in flight; error: the last save failed. */
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

export interface PlanConflict {
  /** The revision another tab (or an import) stored, or null when the plan was deleted there. */
  theirRev: number | null
}

/** A plan operation: a domain stack op (`StackOpResult`) or any function returning a new plan. */
export type PlanOp = (plan: Plan) => StackOpResult | { plan: Plan }

/**
 * Runs on the result of every applied `applyOp`, inside the same undo step. The editor uses it to
 * copy the user's own parts a plan starts using into `plan.custom`, so exports and share links
 * stay complete (see EditorPage). Returns the plan unchanged when there is nothing to add.
 */
export type PlanOpFinisher = (plan: Plan) => Plan

export interface ApplyOpResult {
  /** The plan was replaced (one undo step). False when blocked, failed or nothing is open. */
  applied: boolean
  conflicts: StackConflict[]
  error?: string
}

export interface PlanData {
  planId: string | null
  plan: Plan | null
  /** Stored revision this copy is based on: the compare-and-swap of the next save. */
  rev: number
  /** Made by a newer app version: shown, never edited or saved. */
  readOnly: boolean
  status: PlanStatus
  /** Why loading failed (status not-found / error). */
  error: string | null
  /** Notes from loading (migrations, read-only reason). */
  warnings: string[]
  conflict: PlanConflict | null
  saveState: SaveState
  /** Why the last save failed. */
  lastError: string | null
  /** When this tab last saved the plan (ISO date-time). */
  lastSavedAt: string | null
  /**
   * The plan `saveAsCopy` last stored as a new plan. While it is still the open plan, its unsaved
   * edits are safe in that copy, so leaving does not lose them.
   */
  copiedPlan: Plan | null
}

export interface PlanActions {
  /** Opens a plan (flushing the current one first). A no-op when that plan is already open. */
  load: (id: string) => Promise<void>
  /** Flushes and closes the open plan. */
  unload: () => Promise<void>
  /** A direct edit on an immer draft of the plan: one undo step. False when nothing changed. */
  edit: (recipe: (draft: Draft<Plan>) => void) => boolean
  /** Runs a plan operation; conflicts and errors are returned without touching the plan. */
  applyOp: (op: PlanOp) => ApplyOpResult
  /** Sets (or with null clears) what every applied `applyOp` result goes through. */
  setOpFinisher: (finisher: PlanOpFinisher | null) => void
  /** Starts a gesture: edits until `endGesture` become a single undo step. */
  beginGesture: () => void
  endGesture: () => void
  /** Ends a gesture by restoring the plan it started from (no undo step). */
  cancelGesture: () => void
  undo: () => void
  redo: () => void
  /** Renames the plan (an undoable edit). False for an empty or over-long name. */
  renamePlan: (name: string) => boolean
  /** Saves pending changes now; true when nothing is left unsaved. */
  flushSave: () => Promise<boolean>
  /**
   * Keeps a synchronous copy of unsaved changes for the next load (page hidden or closing), or
   * forgets an old copy when everything is saved. A no-op without a recovery store.
   */
  stashUnsaved: () => void
  /** Re-reads the stored plan, dropping local changes and history (resolves a conflict). */
  reloadFromDb: () => Promise<void>
  /** Stores the plan as it is in memory (Have kept) under new ids; returns the new plan id. */
  saveAsCopy: () => Promise<string>
}

export type PlanStoreState = PlanData & PlanActions

/** What undo/redo restores. */
export type PlanHistory = Pick<PlanData, 'plan'>

export interface PlanStoreDeps {
  getPlan: (id: string) => Promise<LoadedPlan>
  savePlan: (plan: Plan, expectedRev: number) => Promise<number>
  createPlan: (plan: Plan) => Promise<Plan>
  /** Other tabs' change notices (the app store listens on BroadcastChannel). */
  subscribeRemote?: (listener: CrossTabListener) => () => void
  /** Unsaved edits kept through a reload or closed tab (the app store uses localStorage). */
  recovery?: PlanRecovery
  autosaveDelayMs: number
  now: () => string
}

const DEFAULT_DEPS: PlanStoreDeps = {
  getPlan,
  savePlan,
  createPlan,
  autosaveDelayMs: AUTOSAVE_DELAY_MS,
  now: nowIso,
}

const INITIAL_DATA: PlanData = {
  planId: null,
  plan: null,
  rev: 0,
  readOnly: false,
  status: 'idle',
  error: null,
  warnings: [],
  conflict: null,
  saveState: 'saved',
  lastError: null,
  lastSavedAt: null,
  copiedPlan: null,
}

function editable(state: PlanData): state is PlanData & { plan: Plan } {
  return state.status === 'ready' && !state.readOnly && state.plan !== null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A plan document without what every save stamps (rev, updatedAt), for comparing contents. */
function unstamped(plan: unknown): string | undefined {
  return isRecord(plan) ? canonicalJson({ ...plan, rev: 0, updatedAt: '' }) : undefined
}

/**
 * The recovered plan when a kept copy still applies to the stored plan: made on the stored
 * revision, or on the one before it while a save was writing exactly what is stored now. Anything
 * else lost to a newer save (as the compare-and-swap would have decided) and is dropped.
 */
export function recoveredPlan(entry: RecoveryEntry, loaded: LoadedPlan): Plan | undefined {
  if (loaded.readOnly) return undefined
  const applies =
    entry.baseRev === loaded.rev ||
    (entry.saving !== undefined &&
      entry.baseRev + 1 === loaded.rev &&
      unstamped(entry.saving) === unstamped(loaded.plan))
  if (!applies) return undefined
  try {
    const { plan } = migratePlan(entry.plan)
    return plan.id === entry.planId && plan.id === loaded.plan.id ? plan : undefined
  } catch {
    return undefined
  }
}

/** A plan store with its own history and autosave (the app uses `usePlanStore`; tests make more). */
export function createPlanStore(overrides: Partial<PlanStoreDeps> = {}) {
  const deps: PlanStoreDeps = { ...DEFAULT_DEPS, ...overrides }

  let historyApi: StoreApi<TemporalState<PlanHistory>> | undefined
  function history(): TemporalState<PlanHistory> {
    if (historyApi === undefined) throw new Error('The plan history is not ready.')
    return historyApi.getState()
  }

  /** The plan as last loaded or saved; `plan === persisted` means nothing to save. */
  let persisted: Plan | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined
  /** What the save in flight is writing (kept with a recovery copy: it may land after a hide). */
  let saving: Plan | undefined
  /** The plan when the running gesture began; undefined outside gestures. */
  let gestureStart: Plan | undefined
  /** Bumped by load/unload/reload so a slower earlier call never overwrites a later one. */
  let session = 0
  /** See `PlanOpFinisher`. */
  let opFinisher: PlanOpFinisher | null = null

  const store = create<PlanStoreState>()(
    temporal(
      immer((set, get, api) => {
        function clearTimer(): void {
          if (timer !== undefined) clearTimeout(timer)
          timer = undefined
        }

        function schedule(): void {
          clearTimer()
          timer = setTimeout(() => {
            timer = undefined
            void saveNow()
          }, deps.autosaveDelayMs)
        }

        function dropGesture(): void {
          if (gestureStart === undefined) return
          gestureStart = undefined
          history().resume()
        }

        function onSaved(planId: string, plan: Plan, rev: number): void {
          if (get().planId !== planId) return
          persisted = plan
          const newer = get().plan !== plan
          set({
            rev,
            lastSavedAt: deps.now(),
            lastError: null,
            saveState: newer ? 'dirty' : 'saved',
          })
          // Everything is stored: a recovery copy kept on an earlier hide is out of date.
          if (!newer) deps.recovery?.remove(planId)
          clearDbStatus('storage-full')
          clearDbStatus('write-error')
          // Edits made while this save was in flight (or an undo back past it) still need saving.
          if (newer && gestureStart === undefined) schedule()
        }

        function onSaveFailed(planId: string, error: unknown): void {
          if (get().planId !== planId) return
          const message = errorMessage(error)
          if (error instanceof PlanConflictError) {
            clearTimer()
            set({ conflict: { theirRev: error.theirRev }, saveState: 'error', lastError: message })
            reportDbStatus({ type: 'conflict', planId, theirRev: error.theirRev })
            return
          }
          set({ saveState: 'error', lastError: message })
          // A full disk and a database closed for another tab's upgrade have their own banners.
          if (!(error instanceof StorageFullError) && !isDbSuperseded()) {
            reportDbStatus({ type: 'write-error', message })
          }
        }

        async function saveNow(): Promise<void> {
          // Saves run one at a time: each needs the revision the previous one produced. The check
          // and the start of the next save happen in one continuation, so concurrent callers
          // (timer, flush, page hide) cannot both start one.
          for (let pending = inFlight; pending !== undefined; pending = inFlight) await pending
          const state = get()
          const { plan, planId } = state
          if (plan === null || planId === null || state.status !== 'ready') return
          if (state.readOnly || state.conflict !== null) return
          if (plan === persisted) {
            if (state.saveState !== 'saved') set({ saveState: 'saved' })
            return
          }
          set({ saveState: 'saving' })
          const attempt = deps.savePlan(plan, state.rev).then(
            (rev) => onSaved(planId, plan, rev),
            (error: unknown) => onSaveFailed(planId, error),
          )
          inFlight = attempt
          saving = plan
          try {
            await attempt
          } finally {
            if (inFlight === attempt) {
              inFlight = undefined
              saving = undefined
            }
          }
        }

        function stashUnsaved(): void {
          const recovery = deps.recovery
          const state = get()
          const { planId, plan } = state
          if (recovery === undefined || planId === null || plan === null) return
          if (state.status !== 'ready') return
          // Nothing unsaved, or nothing this tab may save (a conflict waits for the user).
          if (plan === persisted || state.readOnly || state.conflict !== null) {
            recovery.remove(planId)
            return
          }
          recovery.write({ planId, baseRev: state.rev, plan, saving })
        }

        async function flushSave(): Promise<boolean> {
          clearTimer()
          await saveNow()
          const state = get()
          if (state.plan === null || state.readOnly) return true
          return state.conflict === null && state.plan === persisted
        }

        /**
         * Shows a loaded plan. `recovered` (unsaved edits kept through a reload) becomes the open
         * plan on top of the stored one, so the usual autosave stores it.
         */
        function applyLoaded(planId: string, loaded: LoadedPlan, recovered?: Plan): void {
          persisted = loaded.plan
          set({
            ...INITIAL_DATA,
            planId,
            plan: recovered ?? loaded.plan,
            rev: loaded.rev,
            readOnly: loaded.readOnly,
            warnings: loaded.warnings,
            status: 'ready',
          })
          history().clear()
        }

        /** Takes the kept copy for a plan (it is used at most once) if it still applies. */
        function takeRecovered(planId: string, loaded: LoadedPlan): Plan | undefined {
          const recovery = deps.recovery
          const entry = recovery?.read(planId)
          if (recovery === undefined || entry === undefined) return undefined
          recovery.remove(planId)
          return recoveredPlan(entry, loaded)
        }

        function applyLoadError(planId: string, error: unknown): void {
          persisted = null
          set({
            ...INITIAL_DATA,
            planId,
            status: error instanceof PlanNotFoundError ? 'not-found' : 'error',
            error: errorMessage(error),
          })
          history().clear()
        }

        async function load(id: string): Promise<void> {
          const token = ++session
          const current = get()
          // Already open: keep its history (the bump above cancels a pending unload).
          if (current.planId === id && current.status === 'ready') return
          await flushSave()
          if (token !== session) return
          clearTimer()
          dropGesture()
          persisted = null
          set({ ...INITIAL_DATA, planId: id, status: 'loading' })
          history().clear()
          useUiStore.getState().clearSelection()
          try {
            const loaded = await deps.getPlan(id)
            if (token === session) applyLoaded(id, loaded, takeRecovered(id, loaded))
          } catch (error) {
            // A deleted plan's kept edits have nowhere to go.
            if (error instanceof PlanNotFoundError) deps.recovery?.remove(id)
            if (token === session) applyLoadError(id, error)
          }
        }

        async function unload(): Promise<void> {
          const token = ++session
          await flushSave()
          if (token !== session) return
          clearTimer()
          dropGesture()
          persisted = null
          set({ ...INITIAL_DATA })
          history().clear()
          useUiStore.getState().clearSelection()
        }

        async function reloadFromDb(): Promise<void> {
          const { planId } = get()
          if (planId === null) return
          const token = ++session
          clearTimer()
          dropGesture()
          for (let pending = inFlight; pending !== undefined; pending = inFlight) await pending
          if (token !== session) return
          // The user chose the stored version: local edits kept on an earlier hide go too.
          deps.recovery?.remove(planId)
          try {
            const loaded = await deps.getPlan(planId)
            if (token === session) applyLoaded(planId, loaded)
          } catch (error) {
            if (token === session) applyLoadError(planId, error)
          }
          if (token === session) clearDbStatus('conflict')
        }

        function edit(recipe: (draft: Draft<Plan>) => void): boolean {
          const before = get()
          if (!editable(before)) return false
          set((state) => {
            if (state.plan !== null) recipe(state.plan)
          })
          return get().plan !== before.plan
        }

        function applyOp(op: PlanOp): ApplyOpResult {
          const before = get()
          if (!editable(before)) {
            return { applied: false, conflicts: [], error: 'No editable plan is open.' }
          }
          let result: StackOpResult | { plan: Plan }
          try {
            result = op(before.plan)
          } catch (error) {
            console.error(error)
            return { applied: false, conflicts: [], error: errorMessage(error) }
          }
          const conflicts = 'conflicts' in result ? result.conflicts : []
          const error = 'error' in result ? result.error : undefined
          if (error !== undefined) return { applied: false, conflicts, error }
          if (conflicts.length > 0) return { applied: false, conflicts }
          if (result.plan !== before.plan) set({ plan: finished(result.plan) })
          return { applied: true, conflicts: [] }
        }

        /** The op's plan through the finisher; a failing finisher leaves the op's plan as it is. */
        function finished(plan: Plan): Plan {
          if (opFinisher === null) return plan
          try {
            return opFinisher(plan)
          } catch (error) {
            console.error(error)
            return plan
          }
        }

        function setOpFinisher(finisher: PlanOpFinisher | null): void {
          opFinisher = finisher
        }

        function beginGesture(): void {
          const state = get()
          if (gestureStart !== undefined || !editable(state)) return
          gestureStart = state.plan
          history().pause()
        }

        function endGesture(): void {
          const start = gestureStart
          if (start === undefined) return
          gestureStart = undefined
          const temporalState = history()
          temporalState.resume()
          const { plan, conflict } = get()
          if (plan === null || plan === start) return
          historyApi?.setState({
            pastStates: [...temporalState.pastStates, { plan: start }].slice(-HISTORY_LIMIT),
            futureStates: [],
          })
          if (plan !== persisted && conflict === null) schedule()
        }

        function cancelGesture(): void {
          const start = gestureStart
          if (start === undefined) return
          gestureStart = undefined
          // Still paused, so restoring the start adds no undo step.
          if (get().plan !== start) set({ plan: start })
          history().resume()
        }

        function undo(): void {
          if (gestureStart === undefined && editable(get())) history().undo()
        }

        function redo(): void {
          if (gestureStart === undefined && editable(get())) history().redo()
        }

        function renamePlan(name: string): boolean {
          let trimmed: string
          try {
            trimmed = validPlanName(name)
          } catch {
            return false
          }
          return edit((draft) => {
            draft.name = trimmed
          })
        }

        async function saveAsCopy(): Promise<string> {
          const { plan, planId } = get()
          if (plan === null) throw new Error('No plan is open.')
          const copy = clonePlanWithNewIds(plan, {
            name: copyName(plan.name),
            rackId: plan.rackId,
            resetHave: false,
            now: deps.now(),
          })
          const { id } = await deps.createPlan(copy)
          if (get().planId === planId) set({ copiedPlan: plan })
          return id
        }

        function onRemote(message: CrossTabMessage): void {
          const state = get()
          if (message.id !== state.planId || state.status !== 'ready') return
          // A revision this tab already has (a late or repeated notice) changes nothing.
          if (message.type === 'plan-saved' && message.rev <= state.rev) return
          const theirRev = message.type === 'plan-saved' ? message.rev : null
          clearTimer()
          set({ conflict: { theirRev } })
          reportDbStatus({ type: 'conflict', planId: message.id, theirRev })
        }

        // Autosave: react to plan changes within the same plan (loads change planId or set
        // `persisted` first, so they never trigger a save).
        api.subscribe((state, previous) => {
          if (state.plan === previous.plan || state.planId !== previous.planId) return
          if (state.status !== 'ready' || state.readOnly || state.plan === null) return
          if (state.plan === persisted) {
            // Back to what is stored (undo, cancelled gesture): nothing to save.
            clearTimer()
            if (state.saveState === 'dirty') set({ saveState: 'saved' })
            return
          }
          if (state.conflict !== null) {
            // Never saved over the other tab's version, but this edit is unsaved: say so (the
            // banner then offers to keep it as a copy). An earlier failed save stays 'error'.
            if (state.saveState === 'saved') set({ saveState: 'dirty' })
            return
          }
          if (state.saveState !== 'dirty') set({ saveState: 'dirty' })
          if (gestureStart === undefined) schedule()
        })
        deps.subscribeRemote?.(onRemote)

        return {
          ...INITIAL_DATA,
          load,
          unload,
          edit,
          applyOp,
          setOpFinisher,
          beginGesture,
          endGesture,
          cancelGesture,
          undo,
          redo,
          renamePlan,
          flushSave,
          stashUnsaved,
          reloadFromDb,
          saveAsCopy,
        }
      }),
      {
        partialize: (state): PlanHistory => ({ plan: state.plan }),
        equality: (past, current) => past.plan === current.plan,
        limit: HISTORY_LIMIT,
      },
    ),
  )
  historyApi = store.temporal
  return store
}

export type PlanStore = ReturnType<typeof createPlanStore>

/**
 * Edits that cannot be saved because another tab changed or deleted the plan, and that no copy
 * holds either: leaving the editor or closing the tab would lose them.
 */
export function hasStrandedEdits(state: PlanData): boolean {
  return (
    state.conflict !== null &&
    state.saveState !== 'saved' &&
    state.plan !== null &&
    state.plan !== state.copiedPlan
  )
}

/** The app's plan store. */
export const usePlanStore: PlanStore = createPlanStore({
  subscribeRemote: subscribeCrossTab,
  recovery: localRecovery,
})

/** Registries the plan store's flush joins; main.tsx passes the app's own. */
export interface PlanPersistenceHooks {
  /** Work done before an app-initiated reload (the update prompt's registry). */
  registerBeforeReload: (hook: () => unknown) => () => void
  /** Work done before another tab's database upgrade closes this tab's connection. */
  registerDbDrain: (drain: () => unknown) => () => void
}

interface LifecycleEvents {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/** The page events the hide handling listens to (the real document and window by default). */
export interface PageLifecycleTarget {
  document: LifecycleEvents & { readonly visibilityState: DocumentVisibilityState }
  window: LifecycleEvents
}

const installedPersistence = new WeakMap<PlanStore, () => void>()

/**
 * Saves the open plan whenever the page may go away: before an app reload (update prompt, status
 * banners), before another tab's database upgrade, and when the page is hidden or unloaded. On
 * hide it first keeps a synchronous recovery copy, since the asynchronous save may not finish
 * while the page unloads (an edit followed by an immediate reload). Idempotent per store; returns
 * an uninstall function. Call once at startup (main.tsx).
 */
export function installPlanPersistence(
  hooks: PlanPersistenceHooks,
  store: PlanStore = usePlanStore,
  page: PageLifecycleTarget = { document, window },
): () => void {
  const existing = installedPersistence.get(store)
  if (existing !== undefined) return existing

  const flush = (): Promise<boolean> => store.getState().flushSave()
  const onHide = (): void => {
    store.getState().stashUnsaved()
    void flush()
  }
  const onVisibilityChange = (): void => {
    if (page.document.visibilityState === 'hidden') onHide()
  }
  const unregister = [hooks.registerBeforeReload(flush), hooks.registerDbDrain(flush)]
  page.document.addEventListener('visibilitychange', onVisibilityChange)
  page.window.addEventListener('pagehide', onHide)

  const uninstall = (): void => {
    for (const stop of unregister) stop()
    page.document.removeEventListener('visibilitychange', onVisibilityChange)
    page.window.removeEventListener('pagehide', onHide)
    installedPersistence.delete(store)
  }
  installedPersistence.set(store, uninstall)
  return uninstall
}

/** Whether undo has anything to restore (reactive). */
export function useCanUndo(): boolean {
  return useStore(usePlanStore.temporal, (state) => state.pastStates.length > 0)
}

export function useCanRedo(): boolean {
  return useStore(usePlanStore.temporal, (state) => state.futureStates.length > 0)
}

export function canUndo(store: PlanStore = usePlanStore): boolean {
  return store.temporal.getState().pastStates.length > 0
}

export function canRedo(store: PlanStore = usePlanStore): boolean {
  return store.temporal.getState().futureStates.length > 0
}
