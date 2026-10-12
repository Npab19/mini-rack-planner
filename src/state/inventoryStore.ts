/**
 * The inventory (what is on hand: loose parts not in a rack, by BOM line key) as React state: a
 * live query over the inventory table, empty while loading. Setters write through the repository; the live query brings the
 * change back (in every tab).
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { errorMessage, StorageFullError } from '@/db/errors'
import { adjust, getInventory, replaceAll, setQty } from '@/db/inventoryRepo'
import type { Inventory } from '@/domain/schema/settings'
import { reportDbStatus } from './dbStatus'

/** Stable while loading, so memoized consumers do not recompute. */
const EMPTY: Inventory = Object.freeze({})

export interface InventoryView {
  inventory: Inventory
  loaded: boolean
}

async function readInventory(): Promise<InventoryView> {
  try {
    return { inventory: await getInventory(), loaded: true }
  } catch {
    return { inventory: EMPTY, loaded: true }
  }
}

const LOADING: InventoryView = { inventory: EMPTY, loaded: false }

export function useInventoryView(): InventoryView {
  return useLiveQuery(readInventory, [], LOADING)
}

/** The inventory (empty until loaded). */
export function useInventory(): Inventory {
  return useInventoryView().inventory
}

async function reported<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (!(error instanceof StorageFullError)) {
      reportDbStatus({ type: 'write-error', message: errorMessage(error) })
    }
    throw error
  }
}

/** Sets how many of a line are on hand (0 removes it). */
export function setInventoryQty(key: string, qty: number): Promise<void> {
  return reported(() => setQty(key, qty))
}

/** Adds to what is on hand (or, negative, uses it up); returns the new quantity. */
export function adjustInventory(key: string, delta: number): Promise<number> {
  return reported(() => adjust(key, delta))
}

export function replaceInventory(inventory: Inventory): Promise<void> {
  return reported(() => replaceAll(inventory))
}
