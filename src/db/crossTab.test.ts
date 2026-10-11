import { afterEach, describe, expect, it } from 'vitest'
import {
  isCrossTabSupported,
  parseCrossTabMessage,
  publishCrossTab,
  subscribeCrossTab,
  TAB_ID,
  type CrossTabMessage,
} from './crossTab'

const opened: BroadcastChannel[] = []

/** Another tab's end of the channel. */
function otherTab(): BroadcastChannel {
  const channel = new BroadcastChannel('mrp')
  opened.push(channel)
  return channel
}

afterEach(() => {
  for (const channel of opened.splice(0)) channel.close()
})

describe('parseCrossTabMessage', () => {
  it('accepts the two message kinds and rejects anything else', () => {
    expect(parseCrossTabMessage({ type: 'plan-saved', id: 'p', rev: 2, tabId: 't' })).toEqual({
      type: 'plan-saved',
      id: 'p',
      rev: 2,
      tabId: 't',
    })
    expect(parseCrossTabMessage({ type: 'plan-deleted', id: 'p', tabId: 't', extra: 1 })).toEqual({
      type: 'plan-deleted',
      id: 'p',
      tabId: 't',
    })
    for (const bad of [
      null,
      'plan-saved',
      { type: 'plan-saved', id: 'p', rev: '2', tabId: 't' },
      { type: 'plan-saved', id: 'p', rev: 1.5, tabId: 't' },
      { type: 'plan-renamed', id: 'p', tabId: 't' },
      { type: 'plan-deleted', id: 1, tabId: 't' },
    ]) {
      expect(parseCrossTabMessage(bad)).toBeUndefined()
    }
  })
})

describe('BroadcastChannel transport', () => {
  it('delivers other tabs’ messages and ignores its own tab id', async () => {
    expect(isCrossTabSupported()).toBe(true)
    const received: CrossTabMessage[] = []
    const arrived = new Promise<void>((resolve) => {
      const stop = subscribeCrossTab((message) => {
        received.push(message)
        stop()
        resolve()
      })
    })
    const other = otherTab()
    other.postMessage({ type: 'plan-saved', id: 'p', rev: 3, tabId: TAB_ID })
    other.postMessage({ type: 'nonsense' })
    other.postMessage({ type: 'plan-deleted', id: 'p', tabId: 'tab-other' })
    await arrived
    expect(received).toEqual([{ type: 'plan-deleted', id: 'p', tabId: 'tab-other' }])
  })

  it('publishes with this tab’s id', async () => {
    const other = otherTab()
    const message = new Promise<unknown>((resolve) => {
      other.addEventListener('message', (event: MessageEvent<unknown>) => resolve(event.data))
    })
    publishCrossTab({ type: 'plan-saved', id: 'plan-1', rev: 7 })
    expect(await message).toEqual({ type: 'plan-saved', id: 'plan-1', rev: 7, tabId: TAB_ID })
  })
})
