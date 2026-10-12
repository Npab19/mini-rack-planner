/**
 * "Equipment to fit" (M3a, M3b): devices the plan needs room for that are not placed yet. Shows
 * how much rack space they need against what is free ("Needs ~10U · rack 9U, 2U free → add 3U"),
 * and for each device its size, Have / To get, the space it takes and up to three mounts to place
 * it on (click-to-place in the rack view), or "Needs a mount?" when no catalog mount takes it.
 *
 * - "Fit it for me" places everything in one undo step, adding sections at the top or the bottom
 *   only when needed (`runFitItForMe`); what it could not place stays here with the reason.
 * - "Add 3U at top / at the bottom" only grows the rack by the shortfall.
 * - Rows can be dragged onto the rack when the rack's drag and drop provides `TrayDragContext`
 *   (the drop opens the mount chooser); placing never needs a drag.
 * - Each row carries `data-equipment-id` and shows when it is selected, so a check on a tray
 *   entry can select and focus it (`focusEquipmentEntry`).
 *
 * Announcements go to the shell's live region (on small screens the shell closes this sheet once
 * placing starts). Inside a sheet, the sheet's title stands in for the panel heading.
 *
 * Colour repeats the words: rows are In my rack (soft green, solid outline) or To get (soft amber,
 * dashed outline) cards with a role dot before the name; the space summary is amber while the rack
 * is short of space and green once it fits; Fit it for me reports in green (placed) or in the
 * warning tone (left over); "Needs a mount?" and the placing note are info.
 */
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  CircleCheck,
  CircleDashed,
  Crosshair,
  GripVertical,
  Info,
  Ruler,
  Trash2,
  TriangleAlert,
  WandSparkles,
  Wrench,
  X,
} from 'lucide-react'
import { useId, useMemo, useRef, useState, type Ref } from 'react'
import { HAVE_NEED_CLASSES, HAVE_TEXT, haveNeedKey, NEED_TEXT } from '@/components/common/HaveNeed'
import { HaveNeedToggle } from '@/components/common/HaveNeedToggle'
import { RoleDot } from '@/components/common/PartRole'
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
import { deviceRole, type PartRole } from '@/domain/partRole'
import { deviceName, type CatalogLookup, type Device, type Frame } from '@/domain/schema/catalog'
import type { PlanEquipment, Plan } from '@/domain/schema/plan'
import { cn } from '@/lib/utils'
import { usePlanLookup } from '@/state/derived'
import { usePlanStore } from '@/state/planStore'
import { useRecordingMode, useUiStore } from '@/state/uiStore'
import { useEditorState, type PlaceSource } from '../editorState'
import { applyPlanOp, sparesText, useSpareContext } from '../inspector/planOps'
import { setHeightRequest } from '../inspector/sectionOps'
import { HAVE_NEED_CARD_CLASSES } from '../inspector/StackEditor'
import { announce } from '../layout/announcer'
import { closeSheetThen, focusRackDrawing } from '../layout/shellStore'
import { useMountDialogs } from '../mounts/mountDialogsStore'
import { selectInEditor } from '../selection'
import { DevicePicker } from './DevicePicker'
import {
  dimsText,
  estimateText,
  growPlan,
  summaryText,
  trayNeedText,
  type FitReport,
} from './equipmentView'
import { runFitItForMe } from './fitActions'
import { useTrayDragSupport, type TrayDraggableComponent } from './trayDrag'

/** Mounts offered per device. */
const SUGGESTIONS_PER_DEVICE = 3

const PLACE_BUTTON_CLASS = 'h-auto min-h-7 py-1 text-left whitespace-normal'

/** The space summary: amber while the rack is short of space, green once everything fits. */
const SUMMARY_TONES = {
  short: HAVE_NEED_CLASSES.need,
  fits: HAVE_NEED_CLASSES.have,
  idle: 'border bg-background',
} as const

/** Fit it for me's report: green when everything went in, the warning tone when some did not. */
const FIT_NOTE_TONES = {
  done: 'border-have-border bg-have-soft',
  partial: 'border-warning-border bg-warning-soft',
  none: 'bg-background',
} as const

/** A segmented-control option (top / bottom): the chosen one in the accent tint. */
const SEGMENT_OPTION_CLASS =
  'data-checked:border-primary data-checked:bg-accent data-checked:font-semibold data-checked:text-accent-foreground'

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

/** What "Fit it for me" last did, shown while the plan is still the one it left. */
interface LastFit {
  plan: Plan | null
  report: FitReport
}

// ---------------------------------------------------------------------------------------------
// Rows

/** The device's name, as a grab handle when the rack's drag and drop is available. */
function RowTitle({
  entry,
  name,
  role,
  DragHandle,
  readOnly,
}: {
  entry: PlanEquipment
  name: string
  role: PartRole
  DragHandle: TrayDraggableComponent | null
  readOnly: boolean
}) {
  const dot = <RoleDot role={role} className="mr-1.5 mb-px align-middle" />
  if (DragHandle === null) {
    return (
      <p className="font-medium break-words">
        {dot}
        {name}
      </p>
    )
  }
  return (
    <DragHandle subject={{ equipmentId: entry.id, deviceId: entry.deviceId }} disabled={readOnly}>
      {({ ref, isDragging }) => (
        <div
          ref={ref}
          data-testid={`equipment-drag-${entry.id}`}
          data-dragging={isDragging || undefined}
          title={readOnly ? undefined : 'Drag onto the rack'}
          className={cn(
            'flex items-start gap-1 rounded-sm select-none',
            !readOnly && 'cursor-grab active:cursor-grabbing',
          )}
        >
          {readOnly ? null : (
            <GripVertical aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <p className="font-medium break-words">
            {dot}
            {name}
            {isDragging ? (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                (drop it on the rack)
              </span>
            ) : null}
          </p>
        </div>
      )}
    </DragHandle>
  )
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
  selected,
  leftOver,
  dragSupport,
  onHave,
  onRemove,
  onPlace,
  onCancelPlace,
  onNeedsAMount,
}: {
  entry: PlanEquipment
  device: Device | undefined
  estimate: DeviceUEstimate | undefined
  options: readonly PlaceOption[]
  frame: Frame | undefined
  catalog: CatalogLookup
  placing: PlaceSource | null
  readOnly: boolean
  selected: boolean
  /** Why "Fit it for me" left it here, while its report is shown. */
  leftOver: string | undefined
  /** The rack's draggable wrapper, when rows can be dragged onto the rack. */
  dragSupport: TrayDraggableComponent | null
  onHave: (entry: PlanEquipment, name: string, have: boolean) => void
  onRemove: (entry: PlanEquipment, name: string) => void
  onPlace: (option: PlaceOption, name: string) => void
  onCancelPlace: () => void
  onNeedsAMount: (entry: PlanEquipment) => void
}) {
  const name = device === undefined ? entry.deviceId : deviceName(device)
  const role = device === undefined ? 'neutral' : deviceRole(device.category)
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
      data-equipment-id={entry.id}
      data-have={entry.have}
      data-selected={selected || undefined}
      aria-current={selected || undefined}
      tabIndex={-1}
      className={cn(
        'grid gap-2 rounded-lg border p-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        HAVE_NEED_CARD_CLASSES[haveNeedKey(entry.have)],
        selected && 'ring-2 ring-primary',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <RowTitle
            entry={entry}
            name={name}
            role={role}
            DragHandle={dragSupport}
            readOnly={readOnly}
          />
          {selected ? (
            <p className="text-xs font-medium text-primary">
              <span className="sr-only">, </span>Selected
            </p>
          ) : null}
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
      {leftOver === undefined ? null : (
        <p
          data-testid={`equipment-left-over-${entry.id}`}
          className="flex items-start gap-1.5 text-xs"
        >
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
          <span>Fit it for me left it here: {leftOver}</span>
        </p>
      )}
      {device === undefined ? null : options.length === 0 ? (
        <div className="grid gap-1.5 rounded-md border border-info-border bg-info-soft p-2">
          <p className="flex items-start gap-1.5 text-xs">
            <Info aria-hidden className="mt-px size-3.5 shrink-0 text-info" />
            No mount in the catalog takes it yet.
          </p>
          <Button
            size="sm"
            variant="outline"
            className={cn(PLACE_BUTTON_CLASS, 'w-fit')}
            data-testid={`equipment-needs-mount-${entry.id}`}
            onClick={() => onNeedsAMount(entry)}
          >
            <Wrench aria-hidden className="text-info" />
            Needs a mount?
          </Button>
        </div>
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
                  <Badge variant="info" className="whitespace-normal">
                    for {frame.name}
                  </Badge>
                ) : null}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {placingOption === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-info-border bg-info-soft px-2 py-1.5 text-xs">
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

// ---------------------------------------------------------------------------------------------
// Fit it for me

const END_TEXT: Record<StackEnd, string> = { top: 'top', bottom: 'bottom' }

/** Top / Bottom: where new sections go. Words and icons carry the choice, never colour alone. */
function EndChoice({
  value,
  disabled,
  onChange,
}: {
  value: StackEnd
  disabled: boolean
  onChange: (at: StackEnd) => void
}) {
  const labelId = useId()
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span id={labelId} className="text-xs text-muted-foreground">
        New sections go at the
      </span>
      <RadioGroup
        value={value}
        onValueChange={(next) => {
          if (next === 'top' || next === 'bottom') onChange(next)
        }}
        aria-labelledby={labelId}
        disabled={disabled}
        className="inline-flex w-fit shrink-0 rounded-lg border bg-background p-0.5"
      >
        {(['top', 'bottom'] as const).map((end) => {
          const Icon = end === 'top' ? ArrowUpToLine : ArrowDownToLine
          return (
            <Radio.Root
              key={end}
              value={end}
              data-testid={`equipment-fit-at-${end}`}
              className={cn(
                'inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-transparent px-2 text-xs whitespace-nowrap text-muted-foreground outline-none select-none',
                'focus-visible:ring-3 focus-visible:ring-ring/50',
                'data-disabled:cursor-not-allowed data-disabled:opacity-60',
                SEGMENT_OPTION_CLASS,
              )}
            >
              <Icon aria-hidden className="size-3.5" />
              {END_TEXT[end]}
            </Radio.Root>
          )
        })}
      </RadioGroup>
    </div>
  )
}

function FitResultNote({ report, noteRef }: { report: FitReport; noteRef: Ref<HTMLDivElement> }) {
  const tone: keyof typeof FIT_NOTE_TONES =
    report.leftOver.length > 0 ? 'partial' : report.placed > 0 ? 'done' : 'none'
  return (
    <div
      ref={noteRef}
      tabIndex={-1}
      data-testid="equipment-fit-result"
      className={cn(
        'grid gap-1 rounded-md border p-2 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        FIT_NOTE_TONES[tone],
      )}
    >
      <p className="flex items-start gap-1.5 font-medium">
        {report.placed > 0 ? (
          <CircleCheck aria-hidden className="mt-px size-3.5 shrink-0 text-have" />
        ) : (
          <CircleDashed aria-hidden className="mt-px size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span>{report.headline}</span>
      </p>
      {report.leftOver.length === 0 ? null : (
        <ul aria-label="Still waiting" className="grid gap-0.5">
          {report.leftOver.map((entry) => (
            <li key={entry.equipmentId} className="flex items-start gap-1.5">
              <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
              <span>
                <span className="font-medium">{entry.name}</span>: {entry.reason}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// The panel

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
  const selection = useUiStore((state) => state.selection)
  const dragSupport = useTrayDragSupport()
  const [fitAt, setFitAt] = useState<StackEnd>('top')
  const [lastFit, setLastFit] = useState<LastFit | null>(null)
  const fitNoteRef = useRef<HTMLDivElement>(null)

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
  // The last fit's report, while nothing has changed since.
  const report = lastFit !== null && lastFit.plan === plan ? lastFit.report : undefined
  const leftOver = useMemo(
    () => new Map(report?.leftOver.map((entry) => [entry.equipmentId, entry.reason]) ?? []),
    [report],
  )

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

  function needsAMount(entry: PlanEquipment): void {
    // Below lg the tray is a sheet: it closes first, so the dialog gets focus to itself.
    closeSheetThen(() =>
      useMountDialogs
        .getState()
        .openNeedsAMount({ deviceId: entry.deviceId, equipmentId: entry.id }),
    )
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

  function fit(): void {
    if (useEditorState.getState().placing?.equipmentId !== undefined) {
      useEditorState.getState().cancelPlacing()
    }
    const outcome = runFitItForMe(lookup, fitAt, spares)
    setLastFit({ plan: outcome.plan, report: outcome.report })
    announce(outcome.report.announcement)
    if (outcome.placementIds.length > 0) selectInEditor(outcome.placementIds)
    // With the tray now empty the button is gone: the report takes focus instead.
    if (outcome.applied && (outcome.plan?.equipment.length ?? 0) === 0) {
      setTimeout(() => fitNoteRef.current?.focus(), 0)
    }
  }

  const trayEmpty = plan.equipment.length === 0
  const summaryTone: keyof typeof SUMMARY_TONES =
    summary === undefined || trayEmpty ? 'idle' : summary.shortfallSixths > 0 ? 'short' : 'fits'

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
          <p
            data-testid="equipment-summary"
            className={cn(
              'flex w-fit max-w-full items-start gap-2 rounded-md px-2 py-1 font-medium',
              SUMMARY_TONES[summaryTone],
            )}
          >
            <Ruler aria-hidden className="mt-0.5 size-4 shrink-0" />
            {summaryText(summary, trayEmpty)}
          </p>
          {trayNeedText(summary) === undefined ? null : (
            <p className="text-xs text-muted-foreground">{trayNeedText(summary)}</p>
          )}
          {trayEmpty ? null : (
            <div className="grid gap-2 border-t pt-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Button size="sm" data-testid="equipment-fit" disabled={readOnly} onClick={fit}>
                  <WandSparkles aria-hidden />
                  Fit it for me
                </Button>
                <EndChoice value={fitAt} disabled={readOnly} onChange={setFitAt} />
              </div>
              <p className="text-xs text-muted-foreground">
                Places every device on its best mount, adding sections only when the free space is
                not enough. One step to undo.
              </p>
            </div>
          )}
          {report === undefined ? null : <FitResultNote report={report} noteRef={fitNoteRef} />}
          {grow === undefined ? null : grow.blocked !== undefined ? (
            <p className="text-xs text-muted-foreground">{grow.blocked}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
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

      {trayEmpty ? (
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
                selected={selection.includes(entry.id)}
                leftOver={leftOver.get(entry.id)}
                dragSupport={dragSupport}
                onHave={setHave}
                onRemove={remove}
                onPlace={place}
                onCancelPlace={cancelPlace}
                onNeedsAMount={needsAMount}
              />
            )
          })}
        </ul>
      )}
    </section>
  )
}
