/**
 * Storage health for the status banners: another tab upgraded the database (version change), an
 * upgrade is blocked by an older tab, the disk is full, a write failed, or the open plan changed
 * in another tab (conflict). Connection events come from `src/db/events.ts`; the stores report the
 * rest. Not persisted.
 */
import { create } from 'zustand'
import { onDbEvent } from '@/db/events'

export interface DbConflictStatus {
  planId: string
  /** The stored revision, or null when the plan was deleted. */
  theirRev: number | null
}

export interface DbStatusState {
  /** Another tab opened a newer version of the app: this tab must reload. */
  versionChange: boolean
  /** This tab's database upgrade waits for an older tab to close. */
  blocked: boolean
  /** A write failed because browser storage is full. */
  storageFull: boolean
  /** The last failed write (other than storage full or a conflict), for display. */
  writeError: string | null
  conflict: DbConflictStatus | null
}

export type DbStatusEvent =
  | { type: 'version-change' }
  | { type: 'blocked' }
  | { type: 'opened' }
  | { type: 'storage-full' }
  | { type: 'write-error'; message: string }
  | ({ type: 'conflict' } & DbConflictStatus)

export type DbStatusKind =
  'version-change' | 'blocked' | 'storage-full' | 'write-error' | 'conflict'

const INITIAL: DbStatusState = {
  versionChange: false,
  blocked: false,
  storageFull: false,
  writeError: null,
  conflict: null,
}

const useDbStatusStore = create<DbStatusState>()(() => INITIAL)

export function reportDbStatus(event: DbStatusEvent): void {
  const set = useDbStatusStore.setState
  switch (event.type) {
    case 'version-change':
      set({ versionChange: true })
      break
    case 'blocked':
      set({ blocked: true })
      break
    case 'opened':
      set({ blocked: false })
      break
    case 'storage-full':
      set({ storageFull: true })
      break
    case 'write-error':
      set({ writeError: event.message })
      break
    case 'conflict':
      set({ conflict: { planId: event.planId, theirRev: event.theirRev } })
      break
  }
}

/** Clears one status (a dismissed banner, a resolved conflict, a successful save). */
export function clearDbStatus(kind: DbStatusKind): void {
  const set = useDbStatusStore.setState
  switch (kind) {
    case 'version-change':
      set({ versionChange: false })
      break
    case 'blocked':
      set({ blocked: false })
      break
    case 'storage-full':
      set({ storageFull: false })
      break
    case 'write-error':
      set({ writeError: null })
      break
    case 'conflict':
      set({ conflict: null })
      break
  }
}

export function getDbStatus(): DbStatusState {
  return useDbStatusStore.getState()
}

/** The whole status, or a slice of it. */
export function useDbStatus(): DbStatusState
export function useDbStatus<T>(selector: (state: DbStatusState) => T): T
export function useDbStatus<T>(selector?: (state: DbStatusState) => T): T | DbStatusState {
  const select: (state: DbStatusState) => T | DbStatusState = selector ?? ((state) => state)
  return useDbStatusStore(select)
}

export function resetDbStatusForTests(): void {
  useDbStatusStore.setState(INITIAL)
}

onDbEvent((event) => {
  if (event.type === 'version-change') reportDbStatus({ type: 'version-change' })
  else if (event.type === 'blocked') reportDbStatus({ type: 'blocked' })
  else if (event.type === 'opened') reportDbStatus({ type: 'opened' })
  else reportDbStatus({ type: 'storage-full' })
})
