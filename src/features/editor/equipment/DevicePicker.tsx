/**
 * "Add a device": a search field over the catalog's devices (brand, model, type) with the matches
 * as a list of buttons below. Enter adds the best match; the arrow keys move between the field and
 * the matches; Escape goes back to the field.
 */
import { Plus } from 'lucide-react'
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Input } from '@/components/ui/input'
import { createCatalogSearch } from '@/catalog/search'
import { deviceName, type CatalogLookup, type Device } from '@/domain/schema/catalog'
import { dimsText } from './equipmentView'

/** Matches shown at once; the status line says how many there are in all. */
export const MAX_DEVICE_RESULTS = 8

export function DevicePicker({
  lookup,
  disabled,
  onAdd,
}: {
  lookup: CatalogLookup
  disabled?: boolean
  onAdd: (device: Device) => void
}) {
  const inputId = useId()
  const listId = useId()
  const statusId = useId()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const search = useMemo(() => createCatalogSearch(lookup.allDevices()), [lookup])
  const matches = useMemo(() => {
    if (query.trim() === '') return []
    return search(query, { kind: 'device' }).flatMap((hit) =>
      hit.entry.kind === 'device' ? [hit.entry] : [],
    )
  }, [search, query])
  const shown = matches.slice(0, MAX_DEVICE_RESULTS)
  const searching = query.trim() !== ''

  function resultButtons(): HTMLButtonElement[] {
    return [...(listRef.current?.querySelectorAll('button') ?? [])]
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      const best = shown[0]
      if (best !== undefined && !disabled) onAdd(best)
    } else if (event.key === 'ArrowDown') {
      const first = resultButtons()[0]
      if (first !== undefined) {
        event.preventDefault()
        first.focus()
      }
    }
  }

  function onListKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    const buttons = resultButtons()
    const index = buttons.findIndex((button) => button === document.activeElement)
    if (index < 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = buttons[index + (event.key === 'ArrowDown' ? 1 : -1)]
      if (next !== undefined) next.focus()
      else if (event.key === 'ArrowUp') inputRef.current?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      inputRef.current?.focus()
    }
  }

  const status = !searching
    ? `Search ${lookup.allDevices().length} devices by brand, model or type.`
    : matches.length === 0
      ? `No device matches “${query.trim()}”.`
      : matches.length > shown.length
        ? `${matches.length} devices match; the first ${shown.length} are shown.`
        : `${matches.length === 1 ? '1 device matches' : `${matches.length} devices match`}.`

  return (
    <div className="grid gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">
        Add a device
      </label>
      <Input
        id={inputId}
        ref={inputRef}
        type="search"
        data-testid="equipment-search"
        value={query}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        placeholder="Brand, model or type"
        aria-describedby={statusId}
        aria-controls={shown.length > 0 ? listId : undefined}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onInputKeyDown}
      />
      <p id={statusId} role="status" className="text-xs text-muted-foreground">
        {status}
      </p>
      {shown.length === 0 ? null : (
        <ul
          id={listId}
          ref={listRef}
          aria-label="Matching devices"
          className="grid gap-1"
          onKeyDown={onListKeyDown}
        >
          {shown.map((device) => (
            <li key={device.id}>
              <button
                type="button"
                data-testid={`equipment-add-${device.id}`}
                disabled={disabled}
                onClick={() => onAdd(device)}
                className="flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
              >
                <Plus aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0">
                  <span className="sr-only">Add</span>{' '}
                  <span className="block font-medium break-words">{deviceName(device)}</span>{' '}
                  <span className="block text-xs text-muted-foreground">
                    ({device.category}, {dimsText(device)})
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
