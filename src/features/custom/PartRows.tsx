/**
 * The print and hardware rows of a mount, panel or shelf, typed from the model page: one row per
 * printed plate (name, how many, grams, time, material) and per piece of hardware, found with a
 * search over the catalog's hardware. Adding or removing a row moves focus to where work goes on
 * and says what happened.
 */
import { Plus, Search, X } from 'lucide-react'
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createCatalogSearch } from '@/catalog/search'
import type { Hardware } from '@/domain/schema/catalog'
import { FieldGroup, NumberField, TextField } from './fields'
import { focusField, type FormView } from './formView'
import { emptyPrintRow, rowKey, type HardwareRowForm, type PrintRowForm } from './partForms'

const MATERIALS = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PLA-CF', 'PETG-CF', 'PA-CF']
const MAX_HITS = 8

/** Focus target after the next render: a field (`data-field`) or a fixed control. */
type FocusTarget = { field: string } | { ref: RefObject<HTMLElement | null> }

/** `focusAfterRender(target)`: moves focus there once the next render has put it on the page. */
function useFocusAfterRender(root: RefObject<HTMLElement | null>): (target: FocusTarget) => void {
  const next = useRef<FocusTarget | null>(null)
  useLayoutEffect(() => {
    const target = next.current
    if (target === null) return
    next.current = null
    if ('field' in target) focusField(root.current, target.field)
    else target.ref.current?.focus()
  })
  return useCallback((target: FocusTarget) => {
    next.current = target
  }, [])
}

// ---------------------------------------------------------------------------------------------
// Prints

export function PrintRows({
  rows,
  onRows,
  view,
  announce,
}: {
  rows: readonly PrintRowForm[]
  onRows: (rows: PrintRowForm[]) => void
  view: FormView
  announce: (text: string) => void
}) {
  const base = useId()
  const datalistId = `${base}-materials`
  const rootRef = useRef<HTMLDivElement>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const focusAfterRender = useFocusAfterRender(rootRef)

  function update(index: number, patch: Partial<PrintRowForm>): void {
    onRows(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  }

  function add(): void {
    onRows([...rows, emptyPrintRow()])
    focusAfterRender({ field: `prints.${rows.length}.plate` })
    announce(`Added print ${rows.length + 1}.`)
  }

  function remove(index: number): void {
    const row = rows[index]
    const next = rows.filter((_, at) => at !== index)
    onRows(next)
    focusAfterRender(
      next.length === 0
        ? { ref: addRef }
        : { field: `prints.${Math.min(index, next.length - 1)}.plate` },
    )
    const plate = row?.plate.trim() ?? ''
    announce(`Removed print ${index + 1}${plate === '' ? '' : ` (${plate})`}.`)
  }

  return (
    <FieldGroup
      title="Prints"
      description="One row per plate you print, from the model page or your slicer. Grams and time are per print and optional; the time takes minutes, 2:30 or 2h 30m."
    >
      <div ref={rootRef} className="grid gap-2">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No prints yet.</p>
        ) : (
          <ol className="grid gap-2">
            {rows.map((row, index) => {
              const id = (name: string) => `${base}-${row.key}-${name}`
              const field = (name: string) => {
                const key = `prints.${index}.${name}`
                return { id: id(name), field: key, ...view.state(key) }
              }
              const done = (name: string) => () => view.done(`prints.${index}.${name}`)
              const titleId = id('title')
              const plate = row.plate.trim()
              return (
                <li key={row.key} className="rounded-lg border bg-muted/20 p-2.5">
                  <div role="group" aria-labelledby={titleId} className="grid gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <p id={titleId} className="text-sm font-medium">
                        Print {index + 1}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove print ${index + 1}${plate === '' ? '' : `: ${plate}`}`}
                        onClick={() => remove(index)}
                      >
                        <X aria-hidden />
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
                      <TextField
                        {...field('plate')}
                        label="Plate name"
                        value={row.plate}
                        onValue={(value) => update(index, { plate: value })}
                        onDone={done('plate')}
                        className="col-span-2"
                        inputProps={{ placeholder: 'Plate 1' }}
                      />
                      <NumberField
                        {...field('count')}
                        label="How many"
                        value={row.count}
                        onValue={(value) => update(index, { count: value })}
                        onDone={done('count')}
                        inputProps={{ inputMode: 'numeric' }}
                      />
                      <NumberField
                        {...field('grams')}
                        label="Grams"
                        unit="g"
                        value={row.grams}
                        onValue={(value) => update(index, { grams: value })}
                        onDone={done('grams')}
                      />
                      <TextField
                        {...field('time')}
                        label="Print time"
                        value={row.time}
                        onValue={(value) => update(index, { time: value })}
                        onDone={done('time')}
                        inputProps={{ placeholder: '2:30', spellCheck: false }}
                      />
                      <TextField
                        {...field('material')}
                        label="Material"
                        value={row.material}
                        onValue={(value) => update(index, { material: value })}
                        onDone={done('material')}
                        inputProps={{ list: datalistId, placeholder: 'PETG' }}
                      />
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
        <datalist id={datalistId}>
          {MATERIALS.map((material) => (
            <option key={material} value={material} />
          ))}
        </datalist>
        <Button
          ref={addRef}
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={add}
        >
          <Plus aria-hidden />
          Add a print
        </Button>
      </div>
    </FieldGroup>
  )
}

// ---------------------------------------------------------------------------------------------
// Hardware

function HardwarePicker({
  hardware,
  onPick,
}: {
  hardware: readonly Hardware[]
  onPick: (entry: Hardware) => void
}) {
  const inputId = useId()
  const hintId = useId()
  const listId = useId()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const search = useMemo(() => createCatalogSearch(hardware), [hardware])
  const hits = useMemo(
    () =>
      query.trim() === ''
        ? []
        : search(query, { kind: 'hardware' })
            .map((hit) => hit.entry)
            .filter((entry): entry is Hardware => entry.kind === 'hardware')
            .slice(0, MAX_HITS),
    [search, query],
  )

  function buttons(): HTMLButtonElement[] {
    return [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  }

  function onInputKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' && hits.length > 0) {
      event.preventDefault()
      buttons()[0]?.focus()
    } else if (event.key === 'Enter') {
      // Enter adds the best match instead of saving the whole part.
      event.preventDefault()
      const [best] = hits
      if (best !== undefined) {
        onPick(best)
        setQuery('')
      }
    } else if (event.key === 'Escape' && query !== '') {
      // Clears the search instead of closing the dialog.
      event.preventDefault()
      event.stopPropagation()
      setQuery('')
    }
  }

  function onListKey(event: KeyboardEvent<HTMLUListElement>): void {
    const all = buttons()
    const index = all.findIndex((button) => button === document.activeElement)
    if (index === -1) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      all[Math.min(all.length - 1, index + 1)]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (index === 0) inputRef.current?.focus()
      else all[index - 1]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      inputRef.current?.focus()
    }
  }

  const trimmed = query.trim()
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={inputId}>Find hardware to add</Label>
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          id={inputId}
          type="search"
          value={query}
          autoComplete="off"
          spellCheck={false}
          placeholder="M3x8, insert, magnet…"
          aria-describedby={hintId}
          aria-controls={trimmed === '' ? undefined : listId}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKey}
          className="pl-8"
        />
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        Type a size or a name, then choose it from the list: ↓ moves into the list, Enter adds the
        first match.
      </p>
      <p role="status" className="sr-only">
        {trimmed === ''
          ? ''
          : `${hits.length === 0 ? 'No' : hits.length} matching hardware${hits.length === MAX_HITS ? ' shown' : ''}.`}
      </p>
      {trimmed === '' ? null : hits.length === 0 ? (
        <p className="text-sm text-muted-foreground">No hardware matches “{trimmed}”.</p>
      ) : (
        <ul
          ref={listRef}
          id={listId}
          aria-label="Matching hardware"
          onKeyDown={onListKey}
          className="grid gap-0.5 rounded-lg border p-1"
        >
          {hits.map((entry) => (
            <li key={entry.id}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto min-h-7 w-full justify-start py-1 text-left whitespace-normal"
                aria-label={`Add ${entry.name}`}
                onClick={() => {
                  onPick(entry)
                  setQuery('')
                }}
              >
                <Plus aria-hidden />
                {entry.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function HardwareRows({
  rows,
  onRows,
  hardware,
  view,
  announce,
}: {
  rows: readonly HardwareRowForm[]
  onRows: (rows: HardwareRowForm[]) => void
  /** Every hardware entry the user can pick (shared catalog and their own). */
  hardware: readonly Hardware[]
  view: FormView
  announce: (text: string) => void
}) {
  const base = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const focusAfterRender = useFocusAfterRender(rootRef)
  const names = useMemo(() => new Map(hardware.map((entry) => [entry.id, entry.name])), [hardware])
  const nameOf = (id: string): string => names.get(id) ?? id

  function pick(entry: Hardware): void {
    const existing = rows.findIndex((row) => row.hardwareId === entry.id)
    if (existing !== -1) {
      // Nothing changes here, so no render follows: focus the row now.
      focusField(rootRef.current, `hardware.${existing}.count`)
      announce(`${entry.name} is already in the list: change how many.`)
      return
    }
    onRows([...rows, { key: rowKey(), hardwareId: entry.id, count: '1' }])
    focusAfterRender({ field: `hardware.${rows.length}.count` })
    announce(`Added ${entry.name}. Set how many.`)
  }

  function remove(index: number): void {
    const row = rows[index]
    const next = rows.filter((_, at) => at !== index)
    onRows(next)
    focusAfterRender(
      next.length === 0
        ? { field: 'hardware.search' }
        : { field: `hardware.${Math.min(index, next.length - 1)}.count` },
    )
    if (row !== undefined) announce(`Removed ${nameOf(row.hardwareId)}.`)
  }

  return (
    <FieldGroup
      title="Hardware"
      description="Screws, inserts, nuts and magnets it needs. Leave out the screws that fix it to the rack: the planner adds those for your frame."
    >
      <div ref={rootRef} className="grid gap-3">
        {rows.length === 0 ? null : (
          <ul className="grid gap-2">
            {rows.map((row, index) => {
              const name = nameOf(row.hardwareId)
              const key = `hardware.${index}.count`
              const titleId = `${base}-${row.key}-name`
              return (
                <li key={row.key} className="rounded-lg border bg-muted/20 p-2.5">
                  <div
                    role="group"
                    aria-labelledby={titleId}
                    className="flex flex-wrap items-end gap-x-3 gap-y-2"
                  >
                    <p id={titleId} className="min-w-0 flex-1 basis-40 self-center text-sm">
                      {name}
                      {names.has(row.hardwareId) ? null : (
                        <span className="block text-xs text-muted-foreground">
                          Not in the catalog here: listed by its id.
                        </span>
                      )}
                    </p>
                    <NumberField
                      id={`${base}-${row.key}-count`}
                      field={key}
                      {...view.state(key)}
                      label="How many"
                      value={row.count}
                      onValue={(count) =>
                        onRows(
                          rows.map((candidate, at) =>
                            at === index ? { ...candidate, count } : candidate,
                          ),
                        )
                      }
                      onDone={() => view.done(key)}
                      className="w-28"
                      inputProps={{ inputMode: 'numeric' }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${name}`}
                      onClick={() => remove(index)}
                      className="mb-0.5"
                    >
                      <X aria-hidden />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        <div data-field="hardware.search">
          <HardwarePicker hardware={hardware} onPick={pick} />
        </div>
      </div>
    </FieldGroup>
  )
}
