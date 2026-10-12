import 'fake-indexeddb/auto'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadBundledCatalog } from '@/catalog/loader'
import { resetDbForTests } from '@/db/db'
import { createPlan } from '@/db/plansRepo'
import type { Placement } from '@/domain/schema/plan'
import { buildSamplePlan } from '@/features/plans/sample'
import { stopLibrarySync } from '@/state/catalogStore'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { RackView } from './RackView'

const lookup = loadBundledCatalog().lookup

function placementOf(itemId: string): Placement {
  const found = usePlanStore.getState().plan?.placements.find((p) => p.itemId === itemId)
  if (found === undefined) throw new Error(`no ${itemId}`)
  return found
}

async function openSample(): Promise<void> {
  const stored = await createPlan(buildSamplePlan(lookup, '2026-10-11T09:30:00.000Z').plan)
  await act(async () => {
    await usePlanStore.getState().load(stored.id)
  })
  render(<RackView />)
  await screen.findByTestId('rack-svg')
}

beforeEach(async () => {
  await resetDbForTests()
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    await usePlanStore.getState().unload()
  })
  stopLibrarySync()
  useUiStore.setState({ selection: [] })
})

describe('PlacementShape colours', () => {
  it('marks each part and device with its role for the --part colours', async () => {
    await openSample()
    const roles: Array<[string, string]> = [
      ['kws-power-supplies-shelf-2u', 'power'],
      ['generic-blank-1u', 'neutral'],
      ['lenovo-tiny-mount-1u', 'compute'],
      ['two-3-5-drive-rack-1u', 'storage'],
    ]
    for (const [itemId, role] of roles) {
      const shape = screen.getByTestId(`rack-placement-${placementOf(itemId).id}`)
      expect(shape).toHaveAttribute('data-role', role)
    }
    const driveRack = screen.getByTestId(
      `rack-placement-${placementOf('two-3-5-drive-rack-1u').id}`,
    )
    const devices = [...driveRack.querySelectorAll('[data-device-id]')]
    expect(devices.map((device) => device.getAttribute('data-role'))).toEqual([
      'storage',
      'storage',
    ])
  })

  it('draws one selection ring over a background halo on the selected part', async () => {
    await openSample()
    const shelf = placementOf('kws-power-supplies-shelf-2u')
    act(() => useUiStore.setState({ selection: [shelf.id] }))
    const shape = screen.getByTestId(`rack-placement-${shelf.id}`)
    const rings = shape.querySelectorAll('[data-selection-ring]')
    expect(rings).toHaveLength(1)
    const halo = rings[0]?.previousElementSibling
    expect(halo).toHaveAttribute('aria-hidden', 'true')
    // The halo is wider than the ring, so the ring shows on any part colour.
    expect(Number(halo?.getAttribute('stroke-width'))).toBeGreaterThan(
      Number(rings[0]?.getAttribute('stroke-width')),
    )
  })
})
