/**
 * The editor's panels as the shell places them. Each is wrapped in its own error boundary, so one
 * panel crashing shows a compact error card in its place and the rest of the editor keeps
 * working. The slots are memoized: the shell re-rendering (a drawer toggled, a sheet opened) never
 * re-renders a panel; panels subscribe to the stores they need themselves.
 */
import { memo, type ComponentType } from 'react'
import { PanelErrorBoundary } from '@/components/common/ErrorBoundary'
import type { PanelId } from '@/state/uiStore'
import { BomPanel } from '../bom/BomPanel'
import { ChecksPanel } from '../checks/ChecksPanel'
import { EquipmentTray } from '../equipment/EquipmentTray'
import { Inspector } from '../inspector/Inspector'
import { Palette } from '../palette/Palette'
import { RackView } from '../rack/RackView'

export interface PanelInfo {
  /** Sheet title below lg. */
  title: string
  /** Sheets slide in from where the panel sits on desktop. */
  side: 'left' | 'right' | 'bottom'
}

export const PANEL_INFO: Readonly<Record<PanelId, PanelInfo>> = {
  palette: { title: 'Parts', side: 'left' },
  equipment: { title: 'Equipment to fit', side: 'left' },
  inspector: { title: 'Inspector', side: 'right' },
  checks: { title: 'Checks', side: 'right' },
  bom: { title: 'Bill of materials', side: 'bottom' },
}

function slot(name: string, Panel: ComponentType) {
  const Slot = memo(function PanelSlot() {
    return (
      <PanelErrorBoundary name={name}>
        <Panel />
      </PanelErrorBoundary>
    )
  })
  Slot.displayName = `PanelSlot(${name})`
  return Slot
}

export const RackSlot = slot('rack', RackView)

export const PANEL_SLOTS: Readonly<Record<PanelId, ComponentType>> = {
  palette: slot('palette', Palette),
  equipment: slot('equipment', EquipmentTray),
  inspector: slot('inspector', Inspector),
  checks: slot('checks', ChecksPanel),
  bom: slot('bom', BomPanel),
}
