import { Radio as RadioPrimitive } from '@base-ui/react/radio'
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group'
import { cn } from '@/lib/utils'
import { useUiStore, type EditorFace } from '@/state/uiStore'
import { useEditorActions } from './editorActions'

const FACES: ReadonlyArray<{ face: EditorFace; label: string; key: string }> = [
  { face: 'front', label: 'Front', key: '1' },
  { face: 'rear', label: 'Rear', key: '2' },
]

/**
 * Front / Rear as a radio group styled like a segmented control (arrow keys switch, as in any
 * radio group). The chosen side is inverted and bold, not only coloured.
 */
export function FaceToggle() {
  const face = useUiStore((state) => state.face)
  const actions = useEditorActions()
  return (
    <RadioGroupPrimitive
      value={face}
      onValueChange={(value) => actions.setFace(value)}
      aria-label="Rack face"
      className="inline-flex shrink-0 rounded-lg border bg-background p-0.5"
    >
      {FACES.map((option) => (
        <RadioPrimitive.Root
          key={option.face}
          value={option.face}
          data-testid={`toolbar-face-${option.face}`}
          aria-keyshortcuts={option.key}
          title={`${option.label} (${option.key})`}
          className={cn(
            'inline-flex h-6 cursor-pointer items-center rounded-md px-2 text-xs text-muted-foreground outline-none select-none',
            'hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
            'data-checked:bg-primary data-checked:font-semibold data-checked:text-primary-foreground',
          )}
        >
          {option.label}
        </RadioPrimitive.Root>
      ))}
    </RadioGroupPrimitive>
  )
}
