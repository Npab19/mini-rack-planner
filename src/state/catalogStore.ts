/**
 * The catalog the app works with: the bundled catalog (validated once) plus the user's library of
 * custom parts, kept current with a Dexie liveQuery (which also sees changes made in other tabs).
 * A plan's own `custom` entries are layered on top per plan with `lookupForPlan`.
 */
import { liveQuery, type Subscription } from 'dexie'
import { useEffect } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { loadBundledCatalog, type CatalogProblem } from '@/catalog/loader'
import { groupCustomEntries, mergeLookups } from '@/catalog/resolver'
import { errorMessage } from '@/db/errors'
import { listLibrary, type LibraryList } from '@/db/libraryRepo'
import {
  withCustomEntries,
  type CatalogEntry,
  type CatalogLookup,
  type CustomEntries,
} from '@/domain/schema/catalog'
import * as diagnostics from '@/lib/diagnostics'

export interface CatalogView {
  /** Bundled catalog + the user's library. Use `lookupForPlan` to add a plan's own entries. */
  lookup: CatalogLookup
  /** Increments whenever `lookup` changes: a cheap memo dependency. */
  revision: number
  /** Files of the bundled catalog that were skipped, and library rows this version cannot read. */
  problems: readonly CatalogProblem[]
}

export interface CatalogState extends CatalogView {
  /** Hash of the bundled catalog (`plan.catalogRev`, diagnostics). */
  catalogRev: string
  /** The library's entries, most recently changed first. */
  library: readonly CatalogEntry[]
  libraryLoaded: boolean
}

const bundled = loadBundledCatalog()
// Diagnostics reports name the catalog they ran with (the report cannot load it on its own).
diagnostics.setReportContext({ catalogRevision: bundled.revision })

export const useCatalogStore = create<CatalogState>()(() => ({
  lookup: bundled.lookup,
  revision: 0,
  problems: bundled.errors,
  catalogRev: bundled.revision,
  library: [],
  libraryLoaded: false,
}))

function applyLibrary(list: LibraryList): void {
  useCatalogStore.setState((state) => ({
    lookup: mergeLookups(bundled.lookup, undefined, groupCustomEntries(list.entries)),
    revision: state.revision + 1,
    problems: [
      ...bundled.errors,
      ...list.problems.map((problem) => ({
        path: `library/${problem.id}`,
        message: problem.message,
      })),
    ],
    library: list.entries,
    libraryLoaded: true,
  }))
}

let librarySync: Subscription | undefined

/** Starts following the library (idempotent). `useCatalog` calls it. */
export function startLibrarySync(): void {
  if (librarySync !== undefined && !librarySync.closed) return
  librarySync = liveQuery(() => listLibrary()).subscribe({
    next: applyLibrary,
    error: (error: unknown) => {
      // The bundled catalog keeps working; the library is reported as a problem.
      useCatalogStore.setState({
        problems: [
          ...bundled.errors,
          { path: 'library', message: `Your parts could not be loaded: ${errorMessage(error)}` },
        ],
        libraryLoaded: true,
      })
    },
  })
}

export function stopLibrarySync(): void {
  librarySync?.unsubscribe()
  librarySync = undefined
}

/** The current catalog outside React. */
export function getCatalog(): CatalogState {
  return useCatalogStore.getState()
}

/** `{ lookup, revision, problems }`; re-renders when the library changes. */
export function useCatalog(): CatalogView {
  useEffect(() => {
    startLibrarySync()
  }, [])
  return useCatalogStore(
    useShallow((state) => ({
      lookup: state.lookup,
      revision: state.revision,
      problems: state.problems,
    })),
  )
}

const planLookups = new WeakMap<CatalogLookup, WeakMap<CustomEntries, CatalogLookup>>()

/**
 * The lookup for one plan: `lookup` plus the plan's own custom entries (they win, so the plan
 * computes the same BOM everywhere, including in share links). Memoized per lookup and per
 * `plan.custom` object, so it is stable across renders while neither changes.
 */
export function lookupForPlan(
  lookup: CatalogLookup,
  plan: { custom: CustomEntries },
): CatalogLookup {
  let byCustom = planLookups.get(lookup)
  if (byCustom === undefined) {
    byCustom = new WeakMap()
    planLookups.set(lookup, byCustom)
  }
  let result = byCustom.get(plan.custom)
  if (result === undefined) {
    result = withCustomEntries(lookup, plan.custom)
    byCustom.set(plan.custom, result)
  }
  return result
}
