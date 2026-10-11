/**
 * Inventory: loose spares that are not installed, keyed by BOM line key (`ids.ts`: `print:…`,
 * `hw:…`, `device:…`). One row per key; a quantity of 0 removes the row.
 */
import { InventorySchema, type Inventory } from '@/domain/schema/settings'
import type { InventoryRow } from './db'
import { withRetry } from './retry'

function validKey(key: string): string {
  if (key.trim() === '') throw new RangeError('An inventory key cannot be empty.')
  return key
}

function validQty(qty: number): number {
  if (!Number.isFinite(qty)) throw new RangeError(`Not a quantity: ${qty}`)
  return Math.max(0, qty)
}

/** Rows as an Inventory record; unreadable rows (bad key or quantity) are skipped. */
export function inventoryFromRows(rows: readonly InventoryRow[]): Inventory {
  const inventory: Inventory = {}
  for (const row of rows) {
    if (typeof row.key !== 'string' || row.key === '') continue
    if (typeof row.qty !== 'number' || !Number.isFinite(row.qty) || row.qty <= 0) continue
    inventory[row.key] = row.qty
  }
  return inventory
}

export function inventoryRows(inventory: Inventory): InventoryRow[] {
  return Object.entries(inventory)
    .filter(([, qty]) => qty > 0)
    .map(([key, qty]) => ({ key, qty }))
}

export async function getInventory(): Promise<Inventory> {
  return inventoryFromRows(await withRetry((db) => db.inventory.toArray()))
}

/** Sets the quantity for a key (0 or less removes it). */
export async function setQty(key: string, qty: number): Promise<void> {
  const k = validKey(key)
  const n = validQty(qty)
  await withRetry(async (db) => {
    if (n === 0) await db.inventory.delete(k)
    else await db.inventory.put({ key: k, qty: n })
  })
}

/** Adds `delta` (negative to consume) in one transaction, never below 0; returns the new quantity. */
export async function adjust(key: string, delta: number): Promise<number> {
  const k = validKey(key)
  if (!Number.isFinite(delta)) throw new RangeError(`Not a quantity: ${delta}`)
  return withRetry((db) =>
    db.transaction('rw', db.inventory, async () => {
      const current = (await db.inventory.get(k))?.qty ?? 0
      const next = Math.max(0, current + delta)
      if (next === 0) await db.inventory.delete(k)
      else await db.inventory.put({ key: k, qty: next })
      return next
    }),
  )
}

/** Replaces the whole inventory in one transaction. */
export async function replaceAll(inventory: Inventory): Promise<void> {
  const rows = inventoryRows(InventorySchema.parse(inventory))
  await withRetry((db) =>
    db.transaction('rw', db.inventory, async () => {
      await db.inventory.clear()
      await db.inventory.bulkPut(rows)
    }),
  )
}
