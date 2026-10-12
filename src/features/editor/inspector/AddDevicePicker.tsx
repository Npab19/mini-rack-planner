/**
 * "Add device" for one slot: devices waiting in "Equipment to fit" that fit it first (picking one
 * moves it in, keeping its In my rack / To get: `assignEquipment`), then a searchable list of
 * catalog devices, the ones the slot is made for and that fit first. Picking one assigns it
 * (`assignDevice`: fit-checked, area slots re-pack); when it cannot go in, the domain's reason
 * shows next to the list and the plan is unchanged. In Recording mode a catalog device is marked
 * In my rack. Each device has a role dot next to its name; "Fits" and In my rack / To get repeat
 * their words in colour.
 * Keyboard: ↓ from the search box enters the list, ↑/↓ move, Escape closes.
 */
import { CircleCheck, CircleX, Plus } from 'lucide-react'
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  HAVE_NEED_TEXT_CLASSES,
  HAVE_TEXT,
  HaveIcon,
  haveNeedKey,
  NEED_TEXT,
  NeedIcon,
} from '@/components/common/HaveNeed'
import { RoleDot } from '@/components/common/PartRole'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createCatalogSearch } from '@/catalog/search'
import { assignDevice, assignEquipment } from '@/domain/devices'
import { deviceRole, type PartRole } from '@/domain/partRole'
import { fitDeviceInSlot, slotAccepts } from '@/domain/placement'
import { deviceName, type Device, type Slot } from '@/domain/schema/catalog'
import type { PlanEquipment } from '@/domain/schema/plan'
import { cn } from '@/lib/utils'
import { dimsText } from '../palette/paletteModel'
import { applyPlanOp, sparesText, type SpareContext } from './planOps'
import type { OpenPlan } from './useOpenPlan'

export interface AddDevicePickerProps {
  placementId: string
  /** The slot's name for labels: "Mini PC". */
  slotName: string
  slot: Slot
  open: OpenPlan
  spares: SpareContext
  announce: (text: string) => void
  /** Called after a device went in (the slot may be full now and this picker gone). */
  onAdded: () => void
}

interface DeviceChoice {
  device: Device
  name: string
  dims: string
  /** The slot is made for it and it fits. */
  fits: boolean
  /** Why not, when it does not. */
  reason?: string
}

/** A device from "Equipment to fit" that fits the slot. */
interface TrayChoice {
  entry: PlanEquipment
  name: string
  dims: string
  role: PartRole
}

function trayChoicesFor(
  equipment: readonly PlanEquipment[],
  lookup: OpenPlan['lookup'],
  slot: Slot,
  query: string,
): TrayChoice[] {
  const wanted = query.trim().toLowerCase()
  return equipment.flatMap((entry) => {
    const device = lookup.device(entry.deviceId)
    if (device === undefined || !fitDeviceInSlot(device, slot).ok) return []
    const name = deviceName(device)
    if (wanted !== '' && !name.toLowerCase().includes(wanted)) return []
    return [{ entry, name, dims: dimsText(device.dims), role: deviceRole(device.category) }]
  })
}

function choicesFor(devices: readonly Device[], slot: Slot): DeviceChoice[] {
  const choices = devices.map((device): DeviceChoice => {
    const fit = fitDeviceInSlot(device, slot)
    return {
      device,
      name: deviceName(device),
      dims: dimsText(device.dims),
      fits: fit.ok,
      ...(fit.ok
        ? {}
        : {
            reason: slotAccepts(slot, device) ? 'Too big for this slot' : 'Not made for this slot',
          }),
    }
  })
  // Made for the slot and fitting first, then made for it but too big, then the rest.
  const rank = (choice: DeviceChoice) =>
    choice.fits ? 0 : choice.reason === 'Too big for this slot' ? 1 : 2
  return choices.toSorted((a, b) => rank(a) - rank(b))
}

export function AddDevicePicker({
  placementId,
  slotName,
  slot,
  open,
  spares,
  announce,
  onAdded,
}: AddDevicePickerProps) {
  const { plan, lookup, readOnly, recording } = open
  const panelId = useId()
  const errorId = useId()
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const search = useMemo(() => createCatalogSearch(lookup.allDevices()), [lookup])
  const choices = useMemo(() => {
    if (!expanded) return []
    const devices = search(query, { kind: 'device' }).flatMap(({ entry }) =>
      entry.kind === 'device' ? [entry] : [],
    )
    return choicesFor(devices, slot)
  }, [expanded, search, query, slot])
  const trayChoices = useMemo(
    () => (expanded ? trayChoicesFor(plan.equipment, lookup, slot, query) : []),
    [expanded, plan.equipment, lookup, slot, query],
  )

  function close(): void {
    setExpanded(false)
    setQuery('')
    setError(null)
    triggerRef.current?.focus()
  }

  function add(choice: DeviceChoice): void {
    const outcome = applyPlanOp(
      (current) => assignDevice(current, lookup, placementId, slot.id, choice.device.id, recording),
      spares,
    )
    if (!outcome.applied) {
      // Shown (and announced) by the alert next to the list.
      setError(outcome.error ?? `The ${choice.name} could not be added.`)
      return
    }
    setExpanded(false)
    setQuery('')
    setError(null)
    // Ready for the next one (an area slot); a full fixed slot drops this picker (see onAdded).
    triggerRef.current?.focus()
    announce(
      `Added the ${choice.name} to ${slotName}${recording ? ', marked In my rack' : ''}.${sparesText(outcome.sparesUsed)}`,
    )
    onAdded()
  }

  function addFromTray(choice: TrayChoice): void {
    const outcome = applyPlanOp(
      (current) => assignEquipment(current, lookup, placementId, slot.id, choice.entry.id),
      spares,
    )
    if (!outcome.applied) {
      setError(outcome.error ?? `The ${choice.name} could not be moved in.`)
      return
    }
    setExpanded(false)
    setQuery('')
    setError(null)
    triggerRef.current?.focus()
    announce(
      `Moved the ${choice.name} from Equipment to fit into ${slotName} (${choice.entry.have ? HAVE_TEXT : NEED_TEXT}).${sparesText(outcome.sparesUsed)}`,
    )
    onAdded()
  }

  function options(): HTMLButtonElement[] {
    return [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  }

  function onListKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    const buttons = options()
    const index = buttons.findIndex((button) => button === document.activeElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      buttons[Math.min(buttons.length - 1, index + 1)]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (index <= 0) inputRef.current?.focus()
      else buttons[index - 1]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  return (
    <div className="grid gap-2">
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        data-testid="inspector-add-device"
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        disabled={readOnly}
        onClick={() => (expanded ? close() : setExpanded(true))}
      >
        <Plus aria-hidden />
        Add device
      </Button>
      {expanded ? (
        <div id={panelId} className="grid gap-2 rounded-lg border bg-background p-2">
          <Input
            ref={inputRef}
            type="search"
            autoFocus
            aria-label={`Search devices for ${slotName}`}
            aria-describedby={error === null ? undefined : errorId}
            placeholder="Search devices…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                options()[0]?.focus()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                close()
              }
            }}
          />
          {error === null ? null : (
            <p
              id={errorId}
              role="alert"
              className="flex items-start gap-1.5 text-sm text-destructive"
            >
              <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
              {error}
            </p>
          )}
          {choices.length === 0 && trayChoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No devices match.</p>
          ) : (
            <ul
              ref={listRef}
              aria-label={`Devices for ${slotName}`}
              onKeyDown={onListKeyDown}
              className="grid max-h-64 gap-0.5 overflow-y-auto overscroll-contain"
            >
              {trayChoices.length === 0 ? null : (
                <li
                  role="presentation"
                  className="px-2 pt-1 text-xs font-medium text-muted-foreground"
                >
                  Waiting in Equipment to fit
                </li>
              )}
              {trayChoices.map((choice) => (
                <li key={choice.entry.id}>
                  <button
                    type="button"
                    data-testid={`inspector-tray-option-${choice.entry.id}`}
                    aria-label={`From Equipment to fit: ${choice.name}, ${choice.dims}, ${choice.entry.have ? HAVE_TEXT : NEED_TEXT}`}
                    onClick={() => addFromTray(choice)}
                    className="flex w-full items-start justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium break-words">
                        <RoleDot role={choice.role} className="mr-1.5 mb-px align-middle" />
                        {choice.name}
                      </span>
                      <span className="block text-xs text-muted-foreground">{choice.dims}</span>
                    </span>
                    <span
                      className={cn(
                        'flex shrink-0 items-center gap-1 text-xs font-medium',
                        HAVE_NEED_TEXT_CLASSES[haveNeedKey(choice.entry.have)],
                      )}
                    >
                      {choice.entry.have ? (
                        <HaveIcon aria-hidden className="size-3.5" />
                      ) : (
                        <NeedIcon aria-hidden className="size-3.5" />
                      )}
                      {choice.entry.have ? HAVE_TEXT : NEED_TEXT}
                    </span>
                  </button>
                </li>
              ))}
              {trayChoices.length === 0 || choices.length === 0 ? null : (
                <li
                  role="presentation"
                  className="px-2 pt-2 text-xs font-medium text-muted-foreground"
                >
                  From the catalog
                </li>
              )}
              {choices.map((choice) => (
                <li key={choice.device.id}>
                  <button
                    type="button"
                    data-testid={`inspector-device-option-${choice.device.id}`}
                    aria-label={`${choice.name}, ${choice.dims}, ${choice.fits ? 'fits' : choice.reason}`}
                    onClick={() => add(choice)}
                    className={cn(
                      'flex w-full items-start justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
                      !choice.fits && 'text-muted-foreground',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block font-medium break-words text-foreground">
                        <RoleDot
                          role={deviceRole(choice.device.category)}
                          className="mr-1.5 mb-px align-middle"
                        />
                        {choice.name}
                      </span>
                      <span className="block text-xs">{choice.dims}</span>
                    </span>
                    <span
                      className={cn(
                        'flex shrink-0 items-center gap-1 text-xs',
                        choice.fits && 'font-medium text-have',
                      )}
                    >
                      {choice.fits ? (
                        <CircleCheck aria-hidden className="size-3.5" />
                      ) : (
                        <CircleX aria-hidden className="size-3.5" />
                      )}
                      {choice.fits ? 'Fits' : choice.reason}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
