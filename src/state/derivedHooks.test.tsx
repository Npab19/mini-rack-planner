import 'fake-indexeddb/auto'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadBundledCatalog } from '@/catalog/loader'
import { resetDbForTests } from '@/db/db'
import { createPlan } from '@/db/plansRepo'
import { buildSamplePlan } from '@/features/plans/sample'
import { stopLibrarySync } from './catalogStore'
import { useBom, useChecks } from './derived'
import { usePlanStore } from './planStore'
import { useSettingsView } from './settingsStore'

beforeEach(async () => {
  await resetDbForTests()
  const { plan } = buildSamplePlan(loadBundledCatalog().lookup, '2026-10-11T09:30:00.000Z')
  const stored = await createPlan(plan)
  await act(async () => {
    await usePlanStore.getState().load(stored.id)
  })
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    await usePlanStore.getState().unload()
  })
  stopLibrarySync()
})

describe('useBom and useChecks', () => {
  it('give every component the same result for the same plan, recomputed once per edit', async () => {
    // The toolbar's summary and the panel ask separately; one computation serves both.
    const read = () => ({ bom: useBom(), checks: useChecks(), settings: useSettingsView() })
    const toolbar = renderHook(read)
    const panel = renderHook(read)
    await waitFor(() => {
      expect(toolbar.result.current.settings.loaded).toBe(true)
      expect(panel.result.current.settings.loaded).toBe(true)
    })
    // Each reads the settings through its own live query: equal, but not the same object.
    expect(panel.result.current.settings.settings).not.toBe(
      toolbar.result.current.settings.settings,
    )
    expect(panel.result.current.bom).toBe(toolbar.result.current.bom)
    expect(panel.result.current.checks).toBe(toolbar.result.current.checks)

    const before = toolbar.result.current.bom
    act(() => {
      usePlanStore.getState().renamePlan('Garage rack')
    })
    expect(toolbar.result.current.bom).not.toBe(before)
    expect(panel.result.current.bom).toBe(toolbar.result.current.bom)
  })
})
