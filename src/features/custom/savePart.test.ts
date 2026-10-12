import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb, resetDbForTests } from '@/db/db'
import { LibraryEntryError } from '@/db/errors'
import { getLibraryEntry, listLibrary, putLibraryEntry } from '@/db/libraryRepo'
import { createPlan } from '@/db/plansRepo'
import {
  CustomPartError,
  editCustomDevice,
  newCustomDevice,
  newCustomItem,
  type CustomDeviceInput,
  type CustomItemInput,
} from '@/domain/customParts'
import type { CatalogEntry } from '@/domain/schema/catalog'
import { PlanSchema, type Plan } from '@/domain/schema/plan'
import { useEditorState } from '@/features/editor/editorState'
import { stopLibrarySync } from '@/state/catalogStore'
import { canUndo, usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { takenPartIds } from './partIds'
import { savedMessage, savePart } from './savePart'

const TODAY = '2026-10-11'
const AT = '2026-10-11T09:30:00.000Z'

const SWITCH: CustomDeviceInput = {
  brand: 'Zeta',
  model: 'Switch 8',
  category: 'switch',
  widthMm: 100,
  depthMm: 98,
  heightMm: 26,
  power: 'brick',
  today: TODAY,
}

const SHELF: CustomItemInput = {
  name: 'Zeta shelf 1U',
  category: 'shelf',
  heightSixths: 6,
  depthMm: 150,
  holds: { kind: 'shelf', maxW: 210, maxD: 140 },
  today: TODAY,
}

function emptyPlan(): Plan {
  return PlanSchema.parse({
    schema: 1,
    id: 'plan-save-part',
    rackId: 'rack-save-part',
    name: 'Save part',
    createdAt: AT,
    updatedAt: AT,
    frame: { frameId: 'kws-rack-v2', sections: [{ id: 'sec-1', typeId: 's6' }] },
  })
}

async function openPlan(): Promise<Plan> {
  const stored = await createPlan(emptyPlan())
  await usePlanStore.getState().load(stored.id)
  const open = usePlanStore.getState().plan
  if (open === null) throw new Error('The plan did not open.')
  return open
}

function openPlanNow(): Plan {
  const plan = usePlanStore.getState().plan
  if (plan === null) throw new Error('No plan is open.')
  return plan
}

beforeEach(async () => {
  await resetDbForTests()
  useEditorState.getState().reset()
  useUiStore.setState({ recordingMode: {} })
})

afterEach(async () => {
  await usePlanStore.getState().unload()
  stopLibrarySync()
  vi.restoreAllMocks()
})

describe('savePart', () => {
  it('stores a new part in My parts under an id nobody uses', async () => {
    await putLibraryEntry(newCustomDevice(SWITCH, new Set()))
    // A row this version cannot read still holds its id.
    await getDb()
      .table('library')
      .put({
        id: 'custom:zeta-switch-8-2',
        kind: 'device',
        updatedAt: '2030-01-01T00:00:00.000Z',
        entry: { kind: 'device', id: 'custom:zeta-switch-8-2', category: 'quantum' },
      })
    expect(await takenPartIds()).toEqual(
      new Set(['custom:zeta-switch-8', 'custom:zeta-switch-8-2']),
    )
    const onSaved = vi.fn<(entry: CatalogEntry) => void>()
    const result = await savePart((taken) => newCustomDevice(SWITCH, taken), { onSaved })
    expect(result.entry.id).toBe('custom:zeta-switch-8-3')
    expect(result).toMatchObject({ inPlan: false, placing: false, inTray: false })
    expect(await getLibraryEntry('custom:zeta-switch-8-3')).toEqual(result.entry)
    expect(onSaved).toHaveBeenCalledWith(result.entry)
    expect(savedMessage(result, false)).toBe('Saved “Zeta Switch 8” to My parts.')
  })

  it('saves an edit under the same id', async () => {
    const stored = await putLibraryEntry(newCustomDevice(SWITCH, new Set()))
    if (stored.kind !== 'device') throw new Error('Expected a device')
    const result = await savePart(() =>
      editCustomDevice(stored, { ...SWITCH, model: 'Switch 8 PoE', power: 'ac' }),
    )
    expect(result.entry.id).toBe(stored.id)
    const { entries } = await listLibrary()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: stored.id, model: 'Switch 8 PoE' })
    expect(savedMessage(result, true)).toBe('Saved your changes to “Zeta Switch 8 PoE”.')
  })

  it('stores nothing when the part cannot be built or stored', async () => {
    await expect(
      savePart(() => {
        throw new CustomPartError('This device is not valid.', ['dims.w: too small'])
      }),
    ).rejects.toThrow(CustomPartError)
    const shared = { ...newCustomDevice(SWITCH, new Set()), id: 'zeta-switch' }
    await expect(savePart(() => shared)).rejects.toThrow(LibraryEntryError)
    expect((await listLibrary()).entries).toEqual([])
  })

  it('adds the part to the open plan as one undo step and starts placing it', async () => {
    await openPlan()
    const result = await savePart((taken) => newCustomItem(SHELF, taken), {
      addToOpenPlan: true,
      placeAfterSave: true,
    })
    expect(result).toMatchObject({ inPlan: true, placing: true, inTray: false })
    expect(openPlanNow().custom.items).toEqual([result.entry])
    expect(canUndo()).toBe(true)
    expect(useEditorState.getState().placing).toEqual({ kind: 'item', itemId: result.entry.id })
    expect(savedMessage(result, false)).toBe(
      'Saved “Zeta shelf 1U” to My parts. Choose a free spot on the rack to place it, or press Escape to cancel.',
    )
  })

  it('places a mount made for a tray device with that device in it', async () => {
    await openPlan()
    const device = await savePart((taken) => newCustomDevice(SWITCH, taken), {
      addToOpenPlan: true,
      placeAfterSave: true,
    })
    const entry = openPlanNow().equipment[0]
    expect(entry?.deviceId).toBe(device.entry.id)
    const equipmentId = entry?.id ?? ''
    const mount = await savePart((taken) => newCustomItem(SHELF, taken), {
      addToOpenPlan: true,
      placeAfterSave: true,
      placeEquipmentId: equipmentId,
    })
    expect(mount.placing).toBe(true)
    expect(useEditorState.getState().placing).toEqual({
      kind: 'item',
      itemId: mount.entry.id,
      equipmentId,
    })

    // A tray entry that is gone by then (placed meanwhile): the mount is placed on its own.
    useEditorState.getState().reset()
    const again = await savePart((taken) => newCustomItem({ ...SHELF, name: 'Two' }, taken), {
      addToOpenPlan: true,
      placeAfterSave: true,
      placeEquipmentId: 'eq-gone',
    })
    expect(useEditorState.getState().placing).toEqual({ kind: 'item', itemId: again.entry.id })
  })

  it('puts a device without rack ears in Equipment to fit, owned while recording', async () => {
    const plan = await openPlan()
    useUiStore.getState().setRecordingMode(plan.id, true)
    const result = await savePart((taken) => newCustomDevice(SWITCH, taken), {
      addToOpenPlan: true,
      placeAfterSave: true,
    })
    expect(result).toMatchObject({ inPlan: true, placing: false, inTray: true })
    const open = openPlanNow()
    expect(open.custom.devices).toEqual([result.entry])
    expect(open.equipment).toEqual([
      { id: expect.stringMatching(/^eq-/), deviceId: result.entry.id, have: true },
    ])
    expect(useEditorState.getState().placing).toBeNull()
    expect(savedMessage(result, false)).toMatch(/It is waiting in Equipment to fit\.$/)
  })

  it('places ear-mounted gear directly', async () => {
    await openPlan()
    const result = await savePart(
      (taken) => newCustomDevice({ ...SWITCH, rackmountSixths: 6 }, taken),
      { addToOpenPlan: true, placeAfterSave: true },
    )
    expect(result.placing).toBe(true)
    expect(useEditorState.getState().placing).toEqual({
      kind: 'device',
      deviceId: result.entry.id,
    })
    expect(openPlanNow().equipment).toEqual([])
  })

  it('only embeds when asked to add the part to the plan, and never a frame', async () => {
    await openPlan()
    const result = await savePart((taken) => newCustomItem(SHELF, taken), { addToOpenPlan: true })
    expect(result).toMatchObject({ inPlan: true, placing: false })
    expect(savedMessage(result, false)).toBe(
      'Saved “Zeta shelf 1U” to My parts. This plan has it in its parts too.',
    )
    expect(useEditorState.getState().placing).toBeNull()
    const other = await savePart((taken) => newCustomItem({ ...SHELF, name: 'Other' }, taken))
    expect(other.inPlan).toBe(false)
    expect(openPlanNow().custom.items.map((item) => item.id)).toEqual([result.entry.id])
  })

  it('saves to My parts without a plan open', async () => {
    const result = await savePart((taken) => newCustomItem(SHELF, taken), {
      addToOpenPlan: true,
      placeAfterSave: true,
    })
    expect(result).toMatchObject({ inPlan: false, placing: false })
    expect(useEditorState.getState().placing).toBeNull()
    expect((await listLibrary()).entries.map((entry) => entry.id)).toEqual([result.entry.id])
  })
})
