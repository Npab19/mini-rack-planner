import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { PANEL_INFO, PANEL_SLOTS } from './panels'
import { closeSheet, panelDomId, sheetClosed, useEditorShell } from './shellStore'

const SIDE_CLASSES = {
  // Full width on phones; a side sheet from sm up.
  left: 'data-[side=left]:w-full data-[side=left]:sm:max-w-md',
  right: 'data-[side=right]:w-full data-[side=right]:sm:max-w-md',
  bottom: 'data-[side=bottom]:h-[85dvh]',
} as const

/**
 * Below lg: the one open panel as a sheet (`data-editor-sheet` lets undo/redo work inside it).
 * The panel stays rendered while the sheet animates closed.
 */
export function PanelSheet() {
  const sheet = useEditorShell((state) => state.sheet)
  const open = useEditorShell((state) => state.sheetOpen)
  const info = sheet === null ? undefined : PANEL_INFO[sheet]
  const Slot = sheet === null ? undefined : PANEL_SLOTS[sheet]
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) closeSheet()
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) sheetClosed()
      }}
    >
      {sheet === null || info === undefined || Slot === undefined ? null : (
        <SheetContent
          side={info.side}
          data-editor-sheet=""
          className={cn('gap-0', SIDE_CLASSES[info.side])}
        >
          <SheetHeader className="shrink-0 border-b bg-accent py-3 pr-12">
            <SheetTitle className="text-accent-foreground">{info.title}</SheetTitle>
          </SheetHeader>
          <div
            id={panelDomId(sheet)}
            data-testid={`panel-${sheet}`}
            className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            <Slot />
          </div>
        </SheetContent>
      )}
    </Sheet>
  )
}
