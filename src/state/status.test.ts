import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitDbEvent } from '@/db/events'
import { registerBeforeReload, runBeforeReload } from './beforeReload'
import { clearDbStatus, getDbStatus, reportDbStatus, resetDbStatusForTests } from './dbStatus'
import { isRecording, useUiStore, ZOOM_MAX } from './uiStore'

beforeEach(() => {
  resetDbStatusForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('dbStatus', () => {
  it('turns database events into banner state', () => {
    emitDbEvent({ type: 'blocked' })
    expect(getDbStatus().blocked).toBe(true)
    emitDbEvent({ type: 'opened' })
    expect(getDbStatus().blocked).toBe(false)
    emitDbEvent({ type: 'version-change', newVersion: 20 })
    emitDbEvent({ type: 'storage-full', message: 'full' })
    expect(getDbStatus()).toMatchObject({ versionChange: true, storageFull: true })
  })

  it('records and clears write errors and conflicts', () => {
    reportDbStatus({ type: 'write-error', message: 'Disk on fire' })
    reportDbStatus({ type: 'conflict', planId: 'plan-1', theirRev: 4 })
    expect(getDbStatus()).toMatchObject({
      writeError: 'Disk on fire',
      conflict: { planId: 'plan-1', theirRev: 4 },
    })
    clearDbStatus('write-error')
    clearDbStatus('conflict')
    clearDbStatus('storage-full')
    expect(getDbStatus()).toMatchObject({ writeError: null, conflict: null, storageFull: false })
  })
})

describe('beforeReload', () => {
  it('runs every hook, tolerates failures and stops waiting after the timeout', async () => {
    const done: string[] = []
    const stops = [
      registerBeforeReload(async () => {
        done.push('flush')
      }),
      registerBeforeReload(() => {
        throw new Error('broken hook')
      }),
    ]
    await runBeforeReload()
    expect(done).toEqual(['flush'])

    vi.useFakeTimers()
    const hanging = registerBeforeReload(() => new Promise(() => {}))
    const run = runBeforeReload(500)
    await vi.advanceTimersByTimeAsync(500)
    await expect(run).resolves.toBeUndefined()
    for (const stop of [...stops, hanging]) stop()
  })
})

describe('uiStore', () => {
  it('tracks Recording mode per plan, selection, zoom and panels', () => {
    const ui = useUiStore.getState()
    ui.setRecordingMode('plan-a', true)
    expect(isRecording('plan-a')).toBe(true)
    expect(isRecording('plan-b')).toBe(false)
    ui.setRecordingMode('plan-a', false)
    expect(isRecording('plan-a')).toBe(false)

    ui.select(['pl-1', 'pl-2', 'pl-1'])
    expect(useUiStore.getState().selection).toEqual(['pl-1', 'pl-2'])
    ui.toggleSelected('pl-1')
    ui.toggleSelected('pl-3')
    expect(useUiStore.getState().selection).toEqual(['pl-2', 'pl-3'])
    ui.clearSelection()
    expect(useUiStore.getState().selection).toEqual([])

    ui.setZoom(100)
    expect(useUiStore.getState().zoom).toBe(ZOOM_MAX)
    ui.setZoom(Number.NaN)
    expect(useUiStore.getState().zoom).toBe(1)
    ui.togglePanel('bom')
    expect(useUiStore.getState().panels.bom).toBe(true)
    ui.setPanelOpen('bom', false)
    expect(useUiStore.getState().panels.bom).toBe(false)
  })
})
