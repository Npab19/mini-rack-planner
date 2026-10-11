import { Redo2, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCanRedo, useCanUndo, usePlanStore } from '@/state/planStore'
import { useEditorActions } from './editorActions'
import { modKeyLabel } from './platform'

/** Undo and Redo: icons, with the words from xl up (always the accessible names). */
export function HistoryControls() {
  const readOnly = usePlanStore((state) => state.readOnly)
  const undoable = useCanUndo()
  const redoable = useCanRedo()
  const actions = useEditorActions()
  const mod = modKeyLabel()
  return (
    <div role="group" aria-label="History" className="flex shrink-0 items-center gap-1">
      <Button
        variant="outline"
        size="sm"
        data-testid="toolbar-undo"
        onClick={actions.undo}
        disabled={readOnly || !undoable}
        aria-keyshortcuts="Control+Z Meta+Z"
        title={`Undo (${mod}+Z)`}
        className="max-xl:w-7 max-xl:px-0"
      >
        <Undo2 aria-hidden />
        <span className="sr-only xl:not-sr-only">Undo</span>
      </Button>
      <Button
        variant="outline"
        size="sm"
        data-testid="toolbar-redo"
        onClick={actions.redo}
        disabled={readOnly || !redoable}
        aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
        title={`Redo (${mod}+Shift+Z)`}
        className="max-xl:w-7 max-xl:px-0"
      >
        <Redo2 aria-hidden />
        <span className="sr-only xl:not-sr-only">Redo</span>
      </Button>
    </div>
  )
}
