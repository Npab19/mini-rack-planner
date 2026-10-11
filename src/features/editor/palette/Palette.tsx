/**
 * Parts palette: search the catalog (bundled + your library + this plan's own parts), in tabs
 * Mounts & panels / Devices / My parts, with category chips and "Fits this frame".
 *
 * - Place starts click-to-place on the rack (`useEditorState.startPlacing`) and moves focus there.
 *   Add at U… places the same part through the rack's "Add at U…" dialog (`requestAddAtU` with
 *   the row as the source); without a rack on screen, the palette opens the dialog itself. Either
 *   way the new part is selected, so the inspector shows it.
 * - Devices go to "Equipment to fit"; ear-mounted gear (`rackmount`) can be placed directly.
 * - In Recording mode, what is added is marked In my rack.
 * Keyboard: ↓ from the search box enters the results (see `PaletteResults`). Announcements go to
 * the shell's live region: below lg the palette is a sheet that closes as placing starts.
 */
import { Check, Search } from 'lucide-react'
import { useDeferredValue, useId, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Toggle } from '@/components/ui/toggle'
import { allEntries, createCatalogSearch } from '@/catalog/search'
import { addEquipment } from '@/domain/devices'
import { ID_PREFIX, newId } from '@/domain/ids'
import type { Plan } from '@/domain/schema/plan'
import { cn } from '@/lib/utils'
import { useEditorState, type PlaceSource } from '../editorState'
import { applyPlanOp, sparesText, useSpareContext } from '../inspector/planOps'
import { announce } from '../layout/announcer'
import { focusRackDrawing } from '../layout/shellStore'
import { AddAtUDialog } from '../rack/AddAtUDialog'
import { selectInEditor } from '../selection'
import { requestAddAtU, useAddAtUAvailable } from '../toolbar/addAtURequest'
import { usePalettePlan } from './usePalettePlan'
import {
  categoryLabel,
  PALETTE_TABS,
  paletteRows,
  tabCategories,
  type PaletteRow,
  type PaletteTab,
} from './paletteModel'
import { PaletteResults, type PaletteResultsHandle, type PaletteRowActions } from './PaletteResults'

const EMPTY_CATEGORIES: readonly string[] = []

function sourceFor(row: PaletteRow): PlaceSource {
  return row.kind === 'device'
    ? { kind: 'device', deviceId: row.id }
    : { kind: 'item', itemId: row.id }
}

/** One more of an extra (a non-U accessory); owned too in Recording mode. */
export function withExtraAdded(plan: Plan, itemId: string, owned: boolean): Plan {
  const index = plan.extras.findIndex((extra) => extra.itemId === itemId)
  const existing = plan.extras[index]
  if (existing !== undefined) {
    const updated = {
      ...existing,
      qty: existing.qty + 1,
      haveQty: owned ? existing.haveQty + 1 : existing.haveQty,
    }
    return { ...plan, extras: plan.extras.with(index, updated) }
  }
  const extra = { id: newId(ID_PREFIX.extra), itemId, qty: 1, haveQty: owned ? 1 : 0 }
  return { ...plan, extras: [...plan.extras, extra] }
}

function EmptyResults({ query, tab }: { query: string; tab: PaletteTab }) {
  return (
    <div className="grid gap-1.5 rounded-lg border border-dashed p-3 text-sm">
      <p className="font-medium">
        {query.trim() === ''
          ? tab === 'mine'
            ? 'You have no parts of your own yet.'
            : 'Nothing here with these filters.'
          : `No parts match “${query.trim()}”.`}
      </p>
      <p className="text-muted-foreground">
        Can’t find it? Adding your own parts (by hand, from a MakerWorld link or from a model file)
        is coming soon.
      </p>
    </div>
  )
}

export function Palette() {
  const open = usePalettePlan()
  const spares = useSpareContext()
  const rackAddAtU = useAddAtUAvailable()
  const headingId = useId()
  const searchId = useId()
  const fitsId = useId()
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [tab, setTab] = useState<PaletteTab>('mounts')
  const [chosen, setChosen] = useState<readonly string[]>(EMPTY_CATEGORIES)
  const [fitsOnly, setFitsOnly] = useState(true)
  /** "Add at U…" opened here because no editor host offers it. */
  const [addAtRow, setAddAtRow] = useState<PaletteRow | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<PaletteResultsHandle>(null)

  const lookup = open?.lookup
  const frameId = open?.frameId
  const entries = useMemo(() => (lookup === undefined ? [] : allEntries(lookup)), [lookup])
  const search = useMemo(() => createCatalogSearch(entries), [entries])
  const categories = useMemo(() => tabCategories(entries, tab), [entries, tab])
  const selected = useMemo(
    () => chosen.filter((category) => categories.includes(category)),
    [chosen, categories],
  )
  const filterFrame = fitsOnly && tab !== 'devices' ? frameId : undefined
  const rows = useMemo(
    () =>
      paletteRows(
        search,
        {
          query: deferredQuery,
          tab,
          categories: selected,
          ...(filterFrame === undefined ? {} : { fitsFrameId: filterFrame }),
        },
        frameId,
      ),
    [search, deferredQuery, tab, selected, filterFrame, frameId],
  )

  if (open === null) {
    return (
      <section aria-label="Parts" className="p-3 text-sm text-muted-foreground">
        Open a plan to add parts.
      </section>
    )
  }
  const { readOnly, recording, frame } = open

  const actions: PaletteRowActions = {
    place(row) {
      useEditorState.getState().startPlacing(sourceFor(row))
      announce(`Placing ${row.name}: choose a free spot on the rack, or press Escape to cancel.`)
      focusRackDrawing()
    },
    addAtU(row) {
      // The rack's dialog when the rack is on screen (it selects what it adds); else this one.
      if (rackAddAtU && requestAddAtU(sourceFor(row))) return
      setAddAtRow(row)
    },
    addToEquipment(row) {
      const outcome = applyPlanOp(
        (plan) => ({ plan: addEquipment(plan, row.id, recording) }),
        spares,
      )
      announce(
        outcome.applied
          ? `Added ${row.name} to Equipment to fit${recording ? ', marked In my rack' : ''}.${sparesText(outcome.sparesUsed)}`
          : (outcome.error ?? `${row.name} could not be added.`),
      )
    },
    addExtra(row) {
      const outcome = applyPlanOp(
        (plan) => ({ plan: withExtraAdded(plan, row.id, recording) }),
        spares,
      )
      announce(
        outcome.applied
          ? `Added 1 × ${row.name} to the plan${recording ? ', marked In my rack' : ''}.${sparesText(outcome.sparesUsed)}`
          : (outcome.error ?? `${row.name} could not be added.`),
      )
    },
  }

  function toggleCategory(category: string, pressed: boolean): void {
    setChosen((current) =>
      pressed ? [...current, category] : current.filter((candidate) => candidate !== category),
    )
  }

  const tabLabel = PALETTE_TABS.find((candidate) => candidate.id === tab)?.label ?? 'Parts'
  const countText = `${rows.length} ${rows.length === 1 ? 'part' : 'parts'}`

  return (
    <section aria-labelledby={headingId} className="@container flex min-w-0 flex-col gap-3 p-3">
      <h2 id={headingId} className="sr-only">
        Parts
      </h2>
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={searchRef}
          id={searchId}
          type="search"
          data-testid="palette-search"
          data-panel-focus=""
          aria-label="Search parts"
          placeholder="Search mounts, panels, devices…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && resultsRef.current?.focusFirst() === true) {
              event.preventDefault()
            }
          }}
          className="pl-8"
        />
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (value === 'mounts' || value === 'devices' || value === 'mine') setTab(value)
        }}
        className="gap-3"
      >
        <TabsList aria-label="Kinds of parts" className="w-full group-data-horizontal/tabs:h-auto">
          {PALETTE_TABS.map((candidate) => (
            <TabsTrigger
              key={candidate.id}
              value={candidate.id}
              className="h-auto min-h-7 py-1 leading-tight whitespace-normal"
            >
              {candidate.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="grid gap-2">
          {categories.length > 1 ? (
            <div role="group" aria-label="Categories" className="flex flex-wrap gap-1">
              {categories.map((category) => {
                const pressed = selected.includes(category)
                return (
                  <Toggle
                    key={category}
                    size="sm"
                    variant="outline"
                    pressed={pressed}
                    onPressedChange={(next) => toggleCategory(category, next)}
                    className={cn('rounded-full', pressed && 'border-foreground/60 font-semibold')}
                  >
                    {pressed ? <Check aria-hidden /> : null}
                    {categoryLabel(category)}
                  </Toggle>
                )
              })}
            </div>
          ) : null}
          {tab === 'devices' ? null : (
            <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
              <span id={fitsId}>
                Fits this frame
                <span className="block text-xs text-muted-foreground">
                  Hides parts made for other frames
                  {frame === undefined ? '' : ` than ${frame.name}`}.
                </span>
              </span>
              <Switch
                checked={fitsOnly}
                onCheckedChange={(checked) => setFitsOnly(checked)}
                aria-labelledby={fitsId}
              />
            </label>
          )}
        </div>

        {PALETTE_TABS.map((candidate) => (
          <TabsContent key={candidate.id} value={candidate.id} className="grid gap-2">
            {candidate.id !== tab ? null : (
              <>
                <p role="status" className="text-xs text-muted-foreground">
                  {countText}
                  {readOnly ? ' · read-only plan: parts cannot be added' : ''}
                </p>
                {rows.length === 0 ? (
                  <EmptyResults query={deferredQuery} tab={tab} />
                ) : (
                  <PaletteResults
                    ref={resultsRef}
                    rows={rows}
                    label={tabLabel}
                    readOnly={readOnly}
                    actions={actions}
                    onExitTop={() => searchRef.current?.focus()}
                  />
                )}
                {rows.length > 0 && deferredQuery.trim() !== '' ? (
                  <p className="text-xs text-muted-foreground">
                    Can’t find it? Adding your own parts is coming soon.
                  </p>
                ) : null}
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>

      <AddAtUDialog
        open={addAtRow !== null}
        onOpenChange={(next) => {
          if (!next) setAddAtRow(null)
        }}
        source={addAtRow === null ? null : sourceFor(addAtRow)}
        onPlaced={(placementId) => selectInEditor([placementId])}
      />
    </section>
  )
}
