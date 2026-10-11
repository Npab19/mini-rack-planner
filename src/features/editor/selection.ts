/**
 * Selecting things from anywhere in the editor (the rack, its "Rack contents" list, the
 * inspector's lists, the checks, a part that was just placed) goes through `selectInEditor`, so
 * every panel follows the same selection:
 * - the ids are selected (the first is the primary) and the inspector shows its Selection tab;
 * - the rack turns to the face the primary placement is on (a device selects with its mount);
 * - the rack scrolls the primary placement into view (RackView follows the selection).
 */
import type { Placement, Plan } from '@/domain/schema/plan'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { useEditorState } from './editorState'

export interface SelectOptions {
  /** Shift/Ctrl/Cmd-click: add each id to the selection, or take it out, instead of replacing it. */
  toggle?: boolean
}

/** The placement an id names: the placement itself, or the one holding that device entry. */
export function placementForId(plan: Plan, id: string): Placement | undefined {
  return (
    plan.placements.find((placement) => placement.id === id) ??
    plan.placements.find((placement) => placement.devices.some((device) => device.id === id))
  )
}

export function selectInEditor(ids: readonly string[], options: SelectOptions = {}): void {
  const ui = useUiStore.getState()
  if (options.toggle === true) {
    for (const id of ids) ui.toggleSelected(id)
  } else {
    ui.select(ids)
  }
  const [primary] = useUiStore.getState().selection
  if (primary === undefined) return
  useEditorState.getState().setInspectorTab('selection')
  if (options.toggle === true) return
  const plan = usePlanStore.getState().plan
  const placement = plan === null ? undefined : placementForId(plan, primary)
  if (placement !== undefined && placement.face !== ui.face) ui.setFace(placement.face)
}
