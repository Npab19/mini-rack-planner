/**
 * "Equipment to fit" (M3a): devices the plan needs room for that are not placed yet. Shows how
 * much rack space they need against what is free ("Needs ~10U · rack 9U, 2U free → add 3U") with
 * a one-step way to grow the rack, and for each device its size, Have / To get, the space it takes
 * and up to three mounts to place it on (click-to-place in the rack view). Announcements go to the
 * shell's live region (on small screens the shell closes this sheet once placing starts). Inside a
 * sheet, the sheet's title stands in for the panel heading.
 */
import { ArrowDownToLine, ArrowUpToLine, Crosshair, Ruler, Trash2, X } from 'lucide-react'
import { useId, useMemo } from 'react'
import { HAVE_TEXT, NEED_TEXT } from '@/components/common/HaveNeed'
import { HaveNeedToggle } from '@/components/common/HaveNeedToggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { markEquipment } from '@/domain/build'
import {
  addEquipment,
  equipmentUSummary,
  estimateDeviceSixths,
  mountSuggestions,
  removeEquipment,
  type DeviceUEstimate,
  type MountSuggestion,
} from '@/domain/devices'
import type { StackEnd } from '@/domain/frame'
import { formatU } from '@/domain/geometry'
import { deviceName, type CatalogLookup, type Device, type Frame } from '@/domain/schema/catalog'
import type { PlanEquipment, Plan } from '@/domain/schema/plan'
import { cn } from '@/lib/utils'
import { usePlanLookup } from '@/state/derived'
import { usePlanStore } from '@/state/planStore'
import { useRecordingMode } from '@/state/uiStore'
import { useEditorState, type PlaceSource } from '../editorState'
import { applyPlanOp, sparesText, useSpareContext } from '../inspector/planOps'
import { setHeightRequest } from '../inspector/sectionOps'
import { announce } from '../layout/announcer'
import { focusRackDrawing } from '../layout/shellStore'
import { DevicePicker } from './DevicePicker'
import { dimsText, estimateText, growPlan, summaryText, trayNeedText } from './equipmentView'

/** Mounts offered per device. */
const SUGGESTIONS_PER_DEVICE = 3

const PLACE_BUTTON_CLASS = 'h-auto min-h-7 py-1 text-left whitespace-normal'

interface PlaceOption {
  source: PlaceSource
  /** The id in `equipment-place-<equipmentId>-<id>`: the mount, or the device itself. */
  targetId: string
  label: string
  /** "on Lenovo Tiny mount 1U", for announcements. */
  where: string
  heightSixths: number
  frameSpecific: boolean
}

function placeOptions(
  entry: PlanEquipment,
  device: Device,
  suggestions: readonly MountSuggestion[],
  catalog: CatalogLookup,
): PlaceOption[] {
  const options: PlaceOption[] = []
  if (device.rackmount !== undefined) {
    options.push({
      source: { kind: 'device', deviceId: device.id, equipmentId: entry.id },
      targetId: device.id,
      label: 'Place in the rack',
      where: 'with its own ears',
      heightSixths: device.rackmount.heightSixths,
      frameSpecific: false,
    })
  }
  for (const suggestion of suggestions) {
    const name = catalog.item(suggestion.itemId)?.name ?? suggestion.itemId
    options.push({
      source: { kind: 'item', itemId: suggestion.itemId, equipmentId: entry.id },
      targetId: suggestion.itemId,
      label: `Place on ${name}`,
      where: `on ${name}`,
      heightSixths: suggestion.heightSixths,
      frameSpecific: suggestion.frameSpecific,
    })
  }
  return options
}

function EquipmentRow({
  entry,
  device,
  estimate,
  options,
  frame,
  catalog,
  placing,
  readOnly,
  onHave,
  onRemove,
  onPlace,
  onCancelPlace,
}: {
  entry: PlanEquipment
  device: Device | undefined
  estimate: DeviceUEstimate | undefined
  options: readonly PlaceOption[]
  frame: Frame | undefined
  catalog: CatalogLookup
  placing: PlaceSource | null
  readOnly: boolean
  onHave: (entry: PlanEquipment, name: string, have: boolean) => void
  onRemove: (entry: PlanEquipment, name: string) => void
  onPlace: (option: PlaceOption, name: string) => void
  onCancelPlace: () => void
}) {
  const name = device === undefined ? entry.deviceId : deviceName(device)
  const placingHere = placing?.equipmentId === entry.id ? placing : undefined
  const placingOption =
    placingHere === undefined
      ? undefined
      : options.find((option) =>
          option.source.kind === 'item'
            ? placingHere.kind === 'item' && placingHere.itemId === option.source.itemId
            : placingHere.kind === 'device',
        )
  return (
    <li
      data-testid={`equipment-item-${entry.id}`}
      data-have={entry.have}
      className={cn(
        'grid gap-2 rounded-lg border p-3',
        entry.have ? 'border-solid' : 'border-dashed border-foreground/40',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium break-words">{name}</p>
          {device === undefined ? (
            <p className="text-xs text-muted-foreground">
              Not in the catalog: its size and mounts are unknown.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{dimsText(device)} (W × D × H)</p>
              {estimate === undefined ? null : (
                <p
                  data-testid={`equipment-estimate-${entry.id}`}
                  className="flex items-start gap-1 text-xs text-muted-foreground"
                >
                  <Ruler aria-hidden className="mt-px size-3.5 shrink-0" />
                  <span>Space: {estimateText(estimate, catalog)}</span>
                </p>
              )}
            </>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${name} from the tray`}
          data-testid={`equipment-remove-${entry.id}`}
          disabled={readOnly}
          onClick={() => onRemove(entry, name)}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
      <HaveNeedToggle
        have={entry.have}
        label={`${name}: ${HAVE_TEXT.toLowerCase()} or ${NEED_TEXT.toLowerCase()}`}
        disabled={readOnly}
        onChange={(have) => onHave(entry, name, have)}
      />
      {device === undefined ? null : options.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No mount in the catalog takes it yet. A mount of about{' '}
          {estimate === undefined ? 'its height' : formatU(estimate.sixths)} would hold it.
        </p>
      ) : (
        <ul aria-label={`Ways to place ${name}`} className="flex flex-wrap gap-1.5">
          {options.map((option) => (
            <li key={option.targetId}>
              <Button
                size="sm"
                variant={placingOption === option ? 'default' : 'outline'}
                className={PLACE_BUTTON_CLASS}
                data-testid={`equipment-place-${entry.id}-${option.targetId}`}
                aria-pressed={placingOption === option}
                disabled={readOnly}
                onClick={() => onPlace(option, name)}
              >
                <Crosshair aria-hidden />
                <span>
                  {option.label}{' '}
                  <span className="font-normal">({formatU(option.heightSixths)})</span>
                </span>
                {option.frameSpecific && frame !== undefined ? (
                  <Badge variant="secondary" className="whitespace-normal">
                    for {frame.name}
                  </Badge>
                ) : null}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {placingOption === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5 text-xs">
          <p className="min-w-40 flex-1">
            Placing {name} {placingOption.where}: choose a spot in the rack.
          </p>
          <Button size="xs" variant="outline" onClick={onCancelPlace}>
            <X aria-hidden />
            Cancel
          </Button>
        </div>
      )}
    </li>
  )
}

export function EquipmentTray() {
  const headingId = useId()
  const plan = usePlanStore((state) => state.plan)
  if (plan === null) {
    return (
      <section aria-labelledby={headingId} className="grid gap-2 p-3 text-sm">
        <h2 id={headingId} className="text-base font-semibold">
          Equipment to fit
        </h2>
        <p className="text-muted-foreground">Open a plan to fit your equipment.</p>
      </section>
    )
  }
  return <TrayContent headingId={headingId} plan={plan} />
}

function TrayContent({ headingId, plan }: { headingId: string; plan: Plan }) {
  const planId = usePlanStore((state) => state.planId)
  const readOnly = usePlanStore((state) => state.readOnly)
  const recording = useRecordingMode(planId)
  const lookup = usePlanLookup()
  const spares = useSpareContext()
  const placing = useEditorState((state) => state.placing)

  const frame = lookup.frame(plan.frame.frameId)
  const summary = useMemo(
    () => (frame === undefined ? undefined : equipmentUSummary(plan, lookup, frame)),
    [plan, lookup, frame],
  )
  const estimates = useMemo(
    () => new Map(summary?.perDevice.map((estimate) => [estimate.equipmentId, estimate]) ?? []),
    [summary],
  )
  // Suggestions per catalog device (the tray may hold the same device twice).
  const suggestions = useMemo(() => {
    const byDevice = new Map<string, MountSuggestion[]>()
    if (frame === undefined) return byDevice
    for (const entry of plan.equipment) {
      const device = lookup.device(entry.deviceId)
      if (device === undefined || byDevice.has(device.id)) continue
      byDevice.set(device.id, mountSuggestions(device, lookup, frame, SUGGESTIONS_PER_DEVICE))
    }
    return byDevice
  }, [plan.equipment, lookup, frame])
  const grow = summary === undefined || frame === undefined ? undefined : growPlan(summary, frame)

  function setHave(entry: PlanEquipment, name: string, have: boolean): void {
    // Marking it In my rack uses up a spare ticked as Got it, like everywhere else.
    const result = applyPlanOp(
      (current) => ({ plan: markEquipment(current, entry.id, have) }),
      spares,
    )
    if (result.applied) {
      announce(`${name}: ${have ? HAVE_TEXT : NEED_TEXT}.${sparesText(result.sparesUsed)}`)
    } else {
      announce(`Could not change ${name}: ${result.error ?? 'nothing changed'}.`)
    }
  }

  function remove(entry: PlanEquipment, name: string): void {
    if (useEditorState.getState().placing?.equipmentId === entry.id) {
      useEditorState.getState().cancelPlacing()
    }
    const result = usePlanStore
      .getState()
      .applyOp((current) => ({ plan: removeEquipment(current, entry.id) }))
    if (result.applied) announce(`Removed ${name} from the tray. Undo brings it back.`)
    else announce(`Could not remove ${name}: ${result.error ?? 'nothing changed'}.`)
  }

  function add(device: Device): void {
    const name = deviceName(device)
    const before = usePlanStore.getState().plan
    const result = usePlanStore
      .getState()
      .applyOp((current) => ({ plan: addEquipment(current, device.id, recording) }))
    if (result.applied && usePlanStore.getState().plan !== before) {
      announce(`Added ${name} to the tray (${recording ? HAVE_TEXT : NEED_TEXT}).`)
    } else {
      announce(`Could not add ${name}: ${result.error ?? 'its id is not valid'}.`)
    }
  }

  function place(option: PlaceOption, name: string): void {
    useEditorState.getState().startPlacing(option.source)
    announce(`Placing ${name} ${option.where}: choose a spot in the rack, or cancel with Escape.`)
    // As Place in the palette: the drawing takes focus, so the arrow keys and Enter place too.
    focusRackDrawing()
  }

  function cancelPlace(): void {
    useEditorState.getState().cancelPlacing()
    announce('Placing cancelled.')
  }

  function growRack(at: StackEnd): void {
    if (grow === undefined || frame === undefined || grow.blocked !== undefined) return
    // The Rack tab's Set height: in Recording mode the new sections are In my rack.
    const request = setHeightRequest({ frame, lookup }, grow.targetU, at, recording)
    const result = applyPlanOp((current) => request.run(current, {}), spares)
    const where = at === 'top' ? 'at the top' : 'at the bottom'
    if (result.applied) {
      const owned = recording ? `, marked ${HAVE_TEXT}` : ''
      announce(`Added ${grow.addText} ${where}${owned}: the rack is now ${grow.targetU}U.`)
    } else {
      const why = result.error ?? result.conflicts.map((conflict) => conflict.message).join(' ')
      announce(`Could not add ${grow.addText} ${where}: ${why}`)
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      data-testid="equipment-tray"
      className="flex min-w-0 flex-col gap-3 p-3 text-sm"
    >
      <h2 id={headingId} className="text-base font-semibold in-[[data-editor-sheet]]:hidden">
        Equipment to fit
      </h2>

      {summary === undefined ? (
        <p className="text-muted-foreground">
          This plan’s frame is not in the catalog, so rack space cannot be worked out.
        </p>
      ) : (
        <div className="grid gap-2 rounded-lg border bg-muted/30 p-3">
          <p data-testid="equipment-summary" className="flex items-start gap-2 font-medium">
            <Ruler aria-hidden className="mt-0.5 size-4 shrink-0" />
            {summaryText(summary, plan.equipment.length === 0)}
          </p>
          {trayNeedText(summary) === undefined ? null : (
            <p className="text-xs text-muted-foreground">{trayNeedText(summary)}</p>
          )}
          {grow === undefined ? null : grow.blocked !== undefined ? (
            <p className="text-xs text-muted-foreground">{grow.blocked}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                data-testid="equipment-grow-top"
                disabled={readOnly}
                onClick={() => growRack('top')}
              >
                <ArrowUpToLine aria-hidden />
                Add {grow.addText} at top
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid="equipment-grow-bottom"
                disabled={readOnly}
                onClick={() => growRack('bottom')}
              >
                <ArrowDownToLine aria-hidden />
                Add {grow.addText} at the bottom
              </Button>
            </div>
          )}
        </div>
      )}

      <DevicePicker lookup={lookup} disabled={readOnly} onAdd={add} />

      {plan.equipment.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-muted-foreground">
          Nothing waiting to be placed. Add the devices you want in the rack: the planner suggests
          mounts and works out how much space they need.
        </p>
      ) : (
        <ul aria-label="Devices waiting to be placed" className="grid gap-2">
          {plan.equipment.map((entry) => {
            const device = lookup.device(entry.deviceId)
            const estimate =
              estimates.get(entry.id) ??
              (device !== undefined && frame !== undefined
                ? estimateDeviceSixths(device, lookup, frame)
                : undefined)
            return (
              <EquipmentRow
                key={entry.id}
                entry={entry}
                device={device}
                estimate={estimate}
                options={
                  device === undefined
                    ? []
                    : placeOptions(entry, device, suggestions.get(device.id) ?? [], lookup)
                }
                frame={frame}
                catalog={lookup}
                placing={placing}
                readOnly={readOnly}
                onHave={setHave}
                onRemove={remove}
                onPlace={place}
                onCancelPlace={cancelPlace}
              />
            )
          })}
        </ul>
      )}
    </section>
  )
}
