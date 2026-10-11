import { Blocks, Server, SlidersHorizontal } from 'lucide-react'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { PanelTabButton } from './PanelTabButton'
import { BomButton, ChecksButton } from './StatusButtons'

function EquipmentTab() {
  const unplaced = usePlanStore((state) => state.plan?.equipment.length ?? 0)
  return (
    <PanelTabButton
      panel="equipment"
      label="Equipment"
      icon={Server}
      badge={unplaced > 0 ? String(unplaced) : undefined}
      detail={unplaced > 0 ? `: ${unplaced} to fit` : undefined}
    />
  )
}

function InspectorTab() {
  const selected = useUiStore((state) => state.selection.length)
  return (
    <PanelTabButton
      panel="inspector"
      label="Inspector"
      icon={SlidersHorizontal}
      badge={selected > 0 ? String(selected) : undefined}
      detail={selected > 0 ? `: ${selected} selected` : undefined}
    />
  )
}

/** Below lg: the panels as buttons, five across (fits 360 px), each opening a sheet. */
export function PanelButtons() {
  return (
    <div role="group" aria-label="Panels" className="grid grid-cols-5 gap-0.5 border-t px-1 py-1">
      <PanelTabButton panel="palette" label="Parts" icon={Blocks} />
      <EquipmentTab />
      <InspectorTab />
      <ChecksButton variant="tab" />
      <BomButton variant="tab" />
    </div>
  )
}
