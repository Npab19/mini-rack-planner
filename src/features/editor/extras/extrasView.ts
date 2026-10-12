/**
 * Words for the Accessories section. Pure.
 */
import type { CatalogLookup, Item } from '@/domain/schema/catalog'
import type { PlanExtra } from '@/domain/schema/plan'

/**
 * What one accessory is made of, from its recipe: "4 × Adhesive rubber foot 10×3 mm, 1 × Clip
 * plate (printed)". Lines with a formula instead of a plain count are left out; undefined when
 * nothing is left.
 */
export function contentsText(item: Item, lookup: CatalogLookup): string | undefined {
  const parts: string[] = []
  for (const line of item.recipe) {
    if (line.role === 'rack-mount' || typeof line.count !== 'number' || !(line.count > 0)) continue
    if ('hardware' in line.ref) {
      const hardwareId = line.ref.hardware
      parts.push(`${line.count} × ${lookup.hardware(hardwareId)?.name ?? hardwareId}`)
    } else {
      const printId = line.ref.print
      const print = item.prints.find((candidate) => candidate.id === printId)
      parts.push(`${line.count} × ${print?.label ?? printId} (printed)`)
    }
  }
  return parts.length === 0 ? undefined : parts.join(', ')
}

export interface HaveStatus {
  /** Everything the plan uses is owned. */
  allHave: boolean
  /** "All 4 in my rack", "1 in my rack · 3 to get", "4 to get". */
  text: string
}

export function haveStatus(extra: Pick<PlanExtra, 'qty' | 'haveQty'>): HaveStatus {
  const owned = Math.min(extra.haveQty, extra.qty)
  const toGet = extra.qty - owned
  if (toGet <= 0) return { allHave: true, text: `All ${extra.qty} in my rack` }
  if (owned === 0) return { allHave: false, text: `${toGet} to get` }
  return { allHave: false, text: `${owned} in my rack · ${toGet} to get` }
}

/** "is" for one, "are" for more: "The 2 you own are kept…". */
export function isAre(count: number): string {
  return count === 1 ? 'is' : 'are'
}
