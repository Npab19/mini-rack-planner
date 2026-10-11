/**
 * Where the editor's panels go.
 *
 * - Desktop (lg+): Parts above Equipment on the left, the rack in the middle (its own scroll
 *   container, so zooming scrolls there), Inspector above Checks on the right, each panel
 *   scrolling on its own; the bill of materials is a drawer along the bottom.
 * - Below lg: the rack fills the screen; the toolbar's panel buttons open the panels as sheets,
 *   one at a time. Starting to place something, or choosing a check, closes the sheet so the
 *   rack is in view.
 */
import { memo, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { useUiStore, type PanelId } from '@/state/uiStore'
import { useEditorState } from '../editorState'
import { BomDrawer } from './BomDrawer'
import { PanelSheet } from './PanelSheet'
import { PANEL_SLOTS, RackSlot } from './panels'
import { RackViewportContext } from './rackViewport'
import { closeSheet, panelDomId, RACK_VIEWPORT_ID, useEditorShell } from './shellStore'

function RackArea() {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  return (
    <div
      ref={setViewport}
      id={RACK_VIEWPORT_ID}
      data-testid="panel-rack"
      tabIndex={-1}
      className="relative min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain bg-muted/30 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
    >
      <RackViewportContext.Provider value={viewport}>
        <RackSlot />
      </RackViewportContext.Provider>
    </div>
  )
}

function PanelBox({ panel, className }: { panel: PanelId; className?: string }) {
  const Slot = PANEL_SLOTS[panel]
  return (
    <div
      id={panelDomId(panel)}
      data-testid={`panel-${panel}`}
      className={cn('overflow-y-auto overscroll-contain', className)}
    >
      <Slot />
    </div>
  )
}

function DesktopLayout() {
  useEffect(() => {
    // A sheet left open below lg has no place here.
    closeSheet()
  }, [])
  return (
    <>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-64 shrink-0 flex-col border-r xl:w-72 2xl:w-80">
          <PanelBox panel="palette" className="min-h-40 flex-1" />
          <PanelBox panel="equipment" className="max-h-[40%] shrink-0 border-t" />
        </div>
        <RackArea />
        <div className="flex w-72 shrink-0 flex-col border-l xl:w-80 2xl:w-96">
          <PanelBox panel="inspector" className="min-h-40 flex-1" />
          <PanelBox panel="checks" className="max-h-[40%] shrink-0 border-t" />
        </div>
      </div>
      <BomDrawer />
    </>
  )
}

function MobileLayout() {
  // The rack comes back into view when it is needed: something starts being placed, or a check
  // was chosen in the Checks sheet (its target is now selected on the rack).
  useEffect(
    () =>
      useEditorState.subscribe((state, previous) => {
        if (state.placing !== null && previous.placing === null) closeSheet()
      }),
    [],
  )
  useEffect(
    () =>
      useUiStore.subscribe((state, previous) => {
        if (state.selection === previous.selection || state.selection.length === 0) return
        const { sheet, sheetOpen } = useEditorShell.getState()
        if (sheetOpen && sheet === 'checks') closeSheet()
      }),
    [],
  )
  return (
    <>
      <RackArea />
      <PanelSheet />
    </>
  )
}

export interface EditorLayoutProps {
  /** lg and up: panels in columns and a BOM drawer; below: the rack alone, panels as sheets. */
  desktop: boolean
}

export const EditorLayout = memo(function EditorLayout({ desktop }: EditorLayoutProps) {
  return desktop ? <DesktopLayout /> : <MobileLayout />
})
