/**
 * Saving a part from the "Add a part" dialog: always into the user's library; with
 * `addToOpenPlan`, into the open plan as well (embedded, so the plan exports and shares complete,
 * as one undo step); with `placeAfterSave`, on to placing it: click-to-place for mounts (with the
 * tray device `placeEquipmentId` names in them) and ear-mounted gear, Equipment to fit for other
 * devices.
 */
import { entryName } from '@/catalog/search'
import { putLibraryEntry } from '@/db/libraryRepo'
import { embedCustomEntries } from '@/domain/customParts'
import { addEquipment } from '@/domain/devices'
import type { CatalogEntry } from '@/domain/schema/catalog'
import { useEditorState } from '@/features/editor/editorState'
import { usePlanStore } from '@/state/planStore'
import { isRecording } from '@/state/uiStore'
import type { AddPartTarget } from './addPartStore'
import { takenPartIds } from './partIds'

export interface SaveResult {
  /** The entry as stored. */
  entry: CatalogEntry
  /** The open plan carries the part now. */
  inPlan: boolean
  /** Why the open plan could not take it (read-only, another tab's version…). */
  planError?: string
  /** Click-to-place started for it. */
  placing: boolean
  /** It went to Equipment to fit. */
  inTray: boolean
}

/** What to call a part in messages: brand and model for devices, else its name. */
export const partName = entryName

/**
 * Builds the entry with the ids in use (`build` throws `CustomPartError` for invalid input),
 * stores it (`putLibraryEntry` throws `LibraryEntryError` or a storage error) and then adds it
 * to the open plan and starts placing it as `target` asks.
 */
export async function savePart(
  build: (taken: ReadonlySet<string>) => CatalogEntry,
  target: AddPartTarget = {},
): Promise<SaveResult> {
  const built = build(await takenPartIds())
  const entry = await putLibraryEntry(built)
  const result: SaveResult = { entry, inPlan: false, placing: false, inTray: false }
  const goesInPlan = entry.kind === 'item' || entry.kind === 'device'
  // Placing a part puts it in the plan too, so the plan carries what it uses.
  const intoPlan = target.addToOpenPlan === true || target.placeAfterSave === true
  const store = usePlanStore.getState()
  if (intoPlan && goesInPlan && store.plan !== null) {
    const planId = store.plan.id
    const toTray =
      target.placeAfterSave === true && entry.kind === 'device' && entry.rackmount === undefined
    const outcome = store.applyOp((plan) => {
      const embedded = embedCustomEntries(plan, [entry])
      return { plan: toTray ? addEquipment(embedded, entry.id, isRecording(planId)) : embedded }
    })
    if (outcome.applied) {
      result.inPlan = true
      result.inTray = toTray
    } else {
      result.planError = outcome.error ?? 'The plan could not be changed.'
    }
  }
  if (target.placeAfterSave === true && result.inPlan) {
    if (entry.kind === 'item') {
      // A mount made for a device waiting in Equipment to fit is placed with that device in it.
      const equipmentId = target.placeEquipmentId
      const waiting =
        equipmentId !== undefined &&
        (usePlanStore
          .getState()
          .plan?.equipment.some((candidate) => candidate.id === equipmentId) ??
          false)
      useEditorState
        .getState()
        .startPlacing(
          waiting
            ? { kind: 'item', itemId: entry.id, equipmentId }
            : { kind: 'item', itemId: entry.id },
        )
      result.placing = true
    } else if (entry.kind === 'device' && entry.rackmount !== undefined) {
      useEditorState.getState().startPlacing({ kind: 'device', deviceId: entry.id })
      result.placing = true
    }
  }
  target.onSaved?.(entry)
  return result
}

/** "Saved “X” to My parts. …" for the toast after saving. */
export function savedMessage(result: SaveResult, edited: boolean): string {
  const name = `“${partName(result.entry)}”`
  const parts = [edited ? `Saved your changes to ${name}.` : `Saved ${name} to My parts.`]
  if (result.inTray) parts.push('It is waiting in Equipment to fit.')
  else if (result.placing) {
    parts.push('Choose a free spot on the rack to place it, or press Escape to cancel.')
  } else if (result.inPlan) {
    parts.push(edited ? 'This plan uses the new version.' : 'This plan has it in its parts too.')
  } else if (result.entry.kind === 'frame' && !edited) {
    parts.push('Choose it under New plan to plan a rack with it.')
  }
  if (result.planError !== undefined) {
    parts.push(`It could not be added to this plan: ${result.planError}`)
  }
  return parts.join(' ')
}
