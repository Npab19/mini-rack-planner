/**
 * Ids in use for new parts: every library row (also rows this version cannot read, so they are
 * never overwritten) and the open plan's own entries.
 */
import { listLibrary } from '@/db/libraryRepo'
import { usePlanStore } from '@/state/planStore'

export async function takenPartIds(): Promise<Set<string>> {
  const { entries, problems } = await listLibrary()
  const ids = new Set<string>()
  for (const entry of entries) ids.add(entry.id)
  for (const problem of problems) ids.add(problem.id)
  const plan = usePlanStore.getState().plan
  if (plan !== null) {
    const { frames, items, devices, hardware } = plan.custom
    for (const entry of [...frames, ...items, ...devices, ...hardware]) ids.add(entry.id)
  }
  return ids
}
