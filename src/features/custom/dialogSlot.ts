/**
 * The "Add a part" dialog may be rendered from more than one place at once (the app shell and a
 * page that wants to be sure one exists, like My parts). Each rendered dialog takes a slot; only
 * the first mounted one shows, so a request never opens two dialogs.
 */
import { useEffect, useId, useSyncExternalStore } from 'react'

let slots: readonly string[] = []
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setSlots(next: readonly string[]): void {
  slots = next
  for (const listener of listeners) listener()
}

/** True for the first mounted caller (of those still mounted). */
export function useFirstSlot(): boolean {
  const id = useId()
  useEffect(() => {
    setSlots([...slots, id])
    return () => setSlots(slots.filter((slot) => slot !== id))
  }, [id])
  return useSyncExternalStore(
    subscribe,
    () => slots[0] === id,
    () => false,
  )
}

/** For tests: forget every slot. */
export function resetDialogSlotsForTests(): void {
  setSlots([])
}
