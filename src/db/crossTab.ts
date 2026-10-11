/**
 * Tells other tabs of this origin that a plan changed, so an open editor can show "changed in
 * another tab" before its own save fails the rev compare-and-swap. Uses BroadcastChannel("mrp")
 * when the browser has it; without it (old Safari) this is a no-op and the CAS still catches
 * conflicts on the next save.
 *
 * A tab never receives its own messages (`tabId`), and incoming data is validated: another tab
 * may run a different version of the app.
 */
import { newId } from '@/domain/ids'

export type CrossTabMessage =
  | { type: 'plan-saved'; id: string; rev: number; tabId: string }
  | { type: 'plan-deleted'; id: string; tabId: string }

/** A message as published; the sender's tab id is added on the way out. */
export type CrossTabOutgoing =
  { type: 'plan-saved'; id: string; rev: number } | { type: 'plan-deleted'; id: string }

export type CrossTabListener = (message: CrossTabMessage) => void

const CHANNEL_NAME = 'mrp'

/** This tab (page load). */
export const TAB_ID: string = newId('tab')

const listeners = new Set<CrossTabListener>()
/** undefined: not created yet; null: unsupported. */
let channel: BroadcastChannel | null | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseCrossTabMessage(data: unknown): CrossTabMessage | undefined {
  if (!isRecord(data)) return undefined
  const { type, id, rev, tabId } = data
  if (typeof id !== 'string' || typeof tabId !== 'string') return undefined
  if (type === 'plan-saved' && typeof rev === 'number' && Number.isInteger(rev)) {
    return { type, id, rev, tabId }
  }
  if (type === 'plan-deleted') return { type, id, tabId }
  return undefined
}

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel
  channel = null
  if (typeof BroadcastChannel !== 'function') return channel
  try {
    const created = new BroadcastChannel(CHANNEL_NAME)
    created.addEventListener('message', (event: MessageEvent<unknown>) => {
      const message = parseCrossTabMessage(event.data)
      if (message === undefined || message.tabId === TAB_ID) return
      for (const listener of listeners) listener(message)
    })
    // Node (tests) keeps the process alive for an open channel; browsers have no unref.
    if ('unref' in created && typeof created.unref === 'function') created.unref()
    channel = created
  } catch {
    // Some embedded browsers throw instead of leaving the constructor out.
  }
  return channel
}

export function isCrossTabSupported(): boolean {
  return getChannel() !== null
}

export function publishCrossTab(message: CrossTabOutgoing): void {
  const target = getChannel()
  if (target === null) return
  try {
    target.postMessage({ ...message, tabId: TAB_ID })
  } catch {
    // A closed channel (page unloading) cannot post; the CAS still protects the data.
  }
}

/** Listens for other tabs' messages. Returns an unsubscribe function. */
export function subscribeCrossTab(listener: CrossTabListener): () => void {
  getChannel()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
