import { useDraggable } from '@dnd-kit/react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Toggle } from '@/components/ui/toggle'
import { cn } from '@/lib/utils'
import { PALETTE_DRAGGABLE_TYPE } from './dndConfig'
import { CATALOG, formatHeight, ITEM_KINDS, RACK_UNITS, type ItemKind } from './rackModel'

const SWATCH: Record<ItemKind, string> = {
  '1u': 'bg-sky-200 border-sky-700 dark:bg-sky-900 dark:border-sky-300',
  '2u': 'bg-violet-200 border-violet-700 dark:bg-violet-900 dark:border-violet-300',
  half: 'bg-amber-200 border-amber-700 dark:bg-amber-900 dark:border-amber-300',
}

/** Palette card content; also rendered inside the DragOverlay. */
export function PaletteChip({ kind }: { kind: ItemKind }) {
  const { name, heightSixths } = CATALOG[kind]
  return (
    <span className="flex w-full min-w-0 items-center gap-2 text-left sm:gap-3">
      <span className="flex h-10 w-5 shrink-0 items-end sm:w-7" aria-hidden="true">
        <span
          className={cn('w-full rounded-sm border', SWATCH[kind])}
          style={{ height: `${(heightSixths / 12) * 100}%` }}
        />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {formatHeight(heightSixths)}
          <span className="hidden sm:inline"> · drag or tap</span>
        </span>
      </span>
    </span>
  )
}

function PaletteItem({
  kind,
  pressed,
  onPressedChange,
}: {
  kind: ItemKind
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
}) {
  const { ref, isDragSource } = useDraggable({
    id: `palette:${kind}`,
    type: PALETTE_DRAGGABLE_TYPE,
    data: { kind },
  })
  return (
    <Toggle
      ref={ref}
      variant="outline"
      pressed={pressed}
      onPressedChange={(next, details) => {
        // dnd-kit cancels the click that ends a drag; do not treat it as a selection.
        if (details.event.defaultPrevented) {
          details.cancel()
          return
        }
        onPressedChange(next)
      }}
      data-testid={`palette-item-${kind}`}
      aria-label={`${CATALOG[kind].name}. Drag onto the rack, or select it and then tap a U.`}
      className={cn(
        'h-auto w-full justify-start px-3 py-2 aria-pressed:border-ring aria-pressed:bg-accent',
        isDragSource && 'opacity-50',
      )}
    >
      <PaletteChip kind={kind} />
    </Toggle>
  )
}

export interface PaletteProps {
  armed: ItemKind | null
  onArm: (kind: ItemKind | null) => void
  onAddAtU: (kind: ItemKind, u: number) => void
}

export function Palette({ armed, onArm, onAddAtU }: PaletteProps) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-sm font-semibold">
        Palette
      </h2>
      <div className="grid grid-cols-3 gap-2 lg:grid-cols-1">
        {ITEM_KINDS.map((kind) => (
          <PaletteItem
            key={kind}
            kind={kind}
            pressed={armed === kind}
            onPressedChange={(pressed) => onArm(pressed ? kind : null)}
          />
        ))}
      </div>
      <AddAtUForm onAddAtU={onAddAtU} />
    </section>
  )
}

/** Keyboard path for placing without a pointer (the M3a "Add at U…" command). */
function AddAtUForm({ onAddAtU }: { onAddAtU: (kind: ItemKind, u: number) => void }) {
  const [kind, setKind] = useState<ItemKind>('1u')
  const [u, setU] = useState('1')
  const itemId = useId()
  const uId = useId()
  return (
    <form
      className="hidden flex-col gap-2 rounded-lg border p-3 lg:flex"
      onSubmit={(event) => {
        event.preventDefault()
        const value = Number(u)
        if (Number.isFinite(value)) onAddAtU(kind, value)
      }}
    >
      <Label htmlFor={itemId}>Add item</Label>
      <select
        id={itemId}
        value={kind}
        onChange={(event) => {
          const next = ITEM_KINDS.find((candidate) => candidate === event.target.value)
          if (next) setKind(next)
        }}
        className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
      >
        {ITEM_KINDS.map((option) => (
          <option key={option} value={option}>
            {CATALOG[option].name}
          </option>
        ))}
      </select>
      <Label htmlFor={uId}>at U</Label>
      <div className="flex gap-2">
        <Input
          id={uId}
          type="number"
          inputMode="decimal"
          min={1}
          max={RACK_UNITS}
          step={0.5}
          value={u}
          onChange={(event) => setU(event.target.value)}
        />
        <Button type="submit" variant="secondary">
          Add
        </Button>
      </div>
    </form>
  )
}
