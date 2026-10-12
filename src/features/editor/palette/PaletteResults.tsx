/**
 * The palette's result rows. Keyboard: the list is one tab stop (the active row's controls);
 * ↑/↓ move between rows, Home/End jump, Enter on a row's main button runs it (Place for mounts
 * and ear-mounted gear, else Add), ↑ on the first row returns to the search box.
 *
 * Pointer (M3b): inside the editor's `RackDndProvider` (lg and up) a row can also be dragged onto
 * the rack by its name or its card (its buttons and links stay buttons and links): mounts, panels
 * and ear-mounted gear land where the ghost says, a device drops into a slot or asks for a mount.
 * Accessories (no rack space) and read-only plans are not draggable. Dragging never replaces a
 * button: Place, Add at U… and Add to Equipment to fit do the same from the keyboard or a tap.
 *
 * Colour: a role dot before each name (the facts line names the category in words), the main
 * action in the primary colour and the rest outlined, Unverified in the warning tone.
 */
import { GripVertical, MousePointerClick, PackagePlus, Plus } from 'lucide-react'
import {
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react'
import { RoleDot } from '@/components/common/PartRole'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { OpenPageLink, UnverifiedBadge } from '../inspector/EntryFacts'
import { useRackDragSource } from '../rack/dragSources'
import { categoryLabel, dragSubjectOf, type PaletteRow } from './paletteModel'

export interface PaletteRowActions {
  place: (row: PaletteRow) => void
  addAtU: (row: PaletteRow) => void
  addToEquipment: (row: PaletteRow) => void
  addExtra: (row: PaletteRow) => void
}

export interface PaletteResultsHandle {
  /** Moves focus to the first row's main button; false when there are no rows. */
  focusFirst: () => boolean
}

type MainAction = 'place' | 'equipment' | 'extra'

function mainAction(row: PaletteRow): MainAction {
  if (row.kind === 'extra') return 'extra'
  if (row.kind === 'device' && !row.placeable) return 'equipment'
  return 'place'
}

export function runMainAction(row: PaletteRow, actions: PaletteRowActions): void {
  const action = mainAction(row)
  if (action === 'place') actions.place(row)
  else if (action === 'equipment') actions.addToEquipment(row)
  else actions.addExtra(row)
}

function rowFacts(row: PaletteRow): string[] {
  const facts: string[] = []
  if (row.heightText !== undefined) {
    facts.push(row.kind === 'device' ? `${row.heightText} rack-mount` : row.heightText)
  }
  if (row.sizeText !== undefined) facts.push(row.sizeText)
  facts.push(categoryLabel(row.category))
  if (row.designer !== undefined) facts.push(`by ${row.designer}`)
  if (row.license !== undefined) facts.push(row.license)
  return facts
}

function RowItem({
  row,
  index,
  active,
  readOnly,
  actions,
  onActivate,
  mainRef,
}: {
  row: PaletteRow
  index: number
  active: boolean
  readOnly: boolean
  actions: PaletteRowActions
  onActivate: () => void
  mainRef: (element: HTMLButtonElement | null) => void
}) {
  const factsId = useId()
  const tabIndex = active ? 0 : -1
  const main = mainAction(row)
  const shared = { size: 'sm', tabIndex, 'aria-describedby': factsId } as const
  const subject = useMemo(
    () => (readOnly ? null : dragSubjectOf({ kind: row.kind, id: row.id })),
    [readOnly, row.kind, row.id],
  )
  const { setElement, draggable, dragging } = useRackDragSource(subject)
  return (
    <li
      ref={setElement}
      data-testid={`palette-item-${row.id}`}
      data-row-index={index}
      data-rack-drag-source={draggable ? 'palette' : undefined}
      data-dragging={dragging || undefined}
      onFocus={onActivate}
      className={cn(
        'rounded-lg border bg-card p-2 transition-colors focus-within:border-ring',
        active && 'bg-muted/40',
        draggable && 'cursor-grab select-none active:cursor-grabbing',
        dragging && 'border-dashed opacity-50',
      )}
    >
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5">
        {draggable ? (
          <GripVertical
            aria-hidden
            data-drag-grip=""
            className="mt-0.5 -mr-1 size-4 shrink-0 text-muted-foreground"
          />
        ) : null}
        <div className="min-w-0 flex-1 basis-36">
          <p className="text-sm leading-snug font-medium break-words">
            <RoleDot role={row.role} className="mr-1.5 mb-px align-middle" />
            {row.name}
          </p>
          <p id={factsId} className="text-xs text-muted-foreground">
            {rowFacts(row).join(' · ')}
            <span className="sr-only">
              {row.unverified ? ' · Unverified' : ''}
              {row.frameSpecific ? ' · Made for this frame' : ''}
              {row.custom ? ' · My part' : ''}
            </span>
          </p>
          {row.unverified || row.frameSpecific || row.custom ? (
            <div className="mt-1 flex flex-wrap gap-1" aria-hidden>
              {row.unverified ? <UnverifiedBadge /> : null}
              {row.frameSpecific ? <Badge variant="info">For this frame</Badge> : null}
              {row.custom ? <Badge variant="outline">My part</Badge> : null}
            </div>
          ) : null}
        </div>
        {readOnly ? null : (
          <div className="flex flex-wrap items-center gap-1">
            {main === 'place' ? (
              <Button
                {...shared}
                ref={mainRef}
                data-primary="true"
                data-testid={`palette-place-${row.id}`}
                aria-label={`Place ${row.name}`}
                onClick={() => actions.place(row)}
              >
                <MousePointerClick aria-hidden />
                Place
              </Button>
            ) : null}
            {row.kind === 'item' ? (
              <Button
                {...shared}
                variant="outline"
                aria-label={`Add at U…: ${row.name}`}
                onClick={() => actions.addAtU(row)}
              >
                Add at U…
              </Button>
            ) : null}
            {row.kind === 'device' ? (
              <Button
                {...shared}
                ref={main === 'equipment' ? mainRef : undefined}
                data-primary={main === 'equipment' ? 'true' : undefined}
                variant={main === 'equipment' ? 'default' : 'outline'}
                aria-label={`Add to Equipment to fit: ${row.name}`}
                onClick={() => actions.addToEquipment(row)}
              >
                <PackagePlus aria-hidden />
                Add to Equipment to fit
              </Button>
            ) : null}
            {row.kind === 'extra' ? (
              <Button
                {...shared}
                ref={mainRef}
                data-primary="true"
                aria-label={`Add to plan: ${row.name}`}
                onClick={() => actions.addExtra(row)}
              >
                <Plus aria-hidden />
                Add to plan
              </Button>
            ) : null}
            {row.url === undefined ? null : (
              <OpenPageLink url={row.url} name={row.name} iconOnly tabIndex={tabIndex} />
            )}
          </div>
        )}
      </div>
    </li>
  )
}

export function PaletteResults({
  rows,
  label,
  readOnly,
  actions,
  onExitTop,
  ref,
}: {
  rows: readonly PaletteRow[]
  /** Names the list, e.g. "Mounts & panels". */
  label: string
  readOnly: boolean
  actions: PaletteRowActions
  /** ↑ on the first row: back to the search box. */
  onExitTop: () => void
  ref?: Ref<PaletteResultsHandle>
}) {
  const hintId = useId()
  const [active, setActive] = useState(0)
  const mains = useRef<Array<HTMLButtonElement | null>>([])
  const activeIndex = Math.min(active, rows.length - 1)

  function focusRow(index: number): boolean {
    if (rows.length === 0) return false
    const target = Math.max(0, Math.min(rows.length - 1, index))
    setActive(target)
    const button = mains.current[target]
    button?.focus()
    return button !== null && button !== undefined
  }

  useImperativeHandle(ref, () => ({ focusFirst: () => focusRow(0) }))

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    if (!(event.target instanceof HTMLElement)) return
    const rowElement = event.target.closest<HTMLElement>('[data-row-index]')
    if (rowElement === null) return
    const index = Number(rowElement.dataset.rowIndex)
    const row = rows[index]
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusRow(index + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        if (index === 0) onExitTop()
        else focusRow(index - 1)
        break
      case 'Home':
        event.preventDefault()
        focusRow(0)
        break
      case 'End':
        event.preventDefault()
        focusRow(rows.length - 1)
        break
      case 'Enter':
        // The row's main button: run it here (one place for keyboard and tests) and stop the
        // browser's own click so it runs once.
        if (event.target.dataset.primary === 'true' && row !== undefined) {
          event.preventDefault()
          runMainAction(row, actions)
        }
        break
    }
  }

  return (
    <>
      <ul
        aria-label={label}
        aria-describedby={hintId}
        onKeyDown={onKeyDown}
        className="grid gap-1.5"
        data-testid="palette-results"
      >
        {rows.map((row, index) => (
          <RowItem
            key={row.id}
            row={row}
            index={index}
            active={index === activeIndex}
            readOnly={readOnly}
            actions={actions}
            onActivate={() => setActive(index)}
            mainRef={(element) => {
              mains.current[index] = element
            }}
          />
        ))}
      </ul>
      <p id={hintId} className="sr-only">
        Up and down arrows move between parts; Enter places the part or adds it.
      </p>
    </>
  )
}
