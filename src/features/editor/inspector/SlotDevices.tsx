/**
 * A placement's slots and the devices in them: name, size, whether it fits (icon + reason, from
 * `fitDeviceInSlot` and the area slot's packing), In my rack / To get, Remove, and "Add device".
 */
import { CircleCheck, CircleX, TriangleAlert, X } from 'lucide-react'
import { useId, useLayoutEffect, useMemo, useRef } from 'react'
import { HAVE_TEXT, NEED_TEXT } from '@/components/common/HaveNeed'
import { HaveNeedToggle } from '@/components/common/HaveNeedToggle'
import { Button } from '@/components/ui/button'
import { markPlacementDevice } from '@/domain/build'
import { removeDevice } from '@/domain/devices'
import { fitDeviceInSlot, packAreaSlot, type PackItem } from '@/domain/placement'
import { deviceName, type Slot } from '@/domain/schema/catalog'
import type { Orientation } from '@/domain/schema/common'
import type { PlacedDevice, Placement } from '@/domain/schema/plan'
import { cn } from '@/lib/utils'
import { dimsText } from '../palette/paletteModel'
import { AddDevicePicker } from './AddDevicePicker'
import { applyPlanOp, sparesText, type SpareContext } from './planOps'
import type { OpenPlan } from './useOpenPlan'

const ORIENTATION_TEXT: Record<Orientation, string> = {
  flat: 'lying flat',
  'flat-rotated': 'turned 90°',
  'on-side': 'on its side',
  upright: 'standing upright',
}

export function slotName(slot: Slot): string {
  return slot.label ?? `Slot “${slot.id}”`
}

function limitsText(slot: Slot): string {
  const height = slot.maxH === undefined ? '' : ` × ${slot.maxH}`
  return `up to ${slot.maxW} × ${slot.maxD}${height} mm`
}

interface DeviceFit {
  ok: boolean
  text: string
}

function deviceFit(
  placed: PlacedDevice,
  slot: Slot,
  open: OpenPlan,
  overflow: ReadonlySet<string>,
): DeviceFit {
  const device = open.lookup.device(placed.deviceId)
  if (device === undefined) {
    return { ok: false, text: 'Not in the catalog, so its fit cannot be checked.' }
  }
  const fit = fitDeviceInSlot(device, slot)
  if (!fit.ok) return { ok: false, text: fit.reason ?? 'It does not fit this slot.' }
  if (overflow.has(placed.id)) {
    return {
      ok: false,
      text: `No room left: the devices in ${slotName(slot)} are wider than ${slot.maxW} mm together.`,
    }
  }
  const orientation = placed.orientation ?? fit.orientation
  return {
    ok: true,
    text: `Fits${orientation === undefined ? '' : `, ${ORIENTATION_TEXT[orientation]}`}`,
  }
}

function SlotSection({
  placement,
  slot,
  open,
  spares,
  announce,
  highlightId,
}: {
  placement: Placement
  slot: Slot
  open: OpenPlan
  spares: SpareContext
  announce: (text: string) => void
  highlightId?: string
}) {
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusHeading = useRef(false)
  const { lookup, readOnly } = open
  const name = slotName(slot)
  const inSlot = useMemo(
    () => placement.devices.filter((placed) => placed.slotId === slot.id),
    [placement.devices, slot.id],
  )
  const overflow = useMemo(() => {
    if (slot.kind !== 'area') return new Set<string>()
    const items: PackItem[] = []
    for (const placed of inSlot) {
      const device = lookup.device(placed.deviceId)
      if (device === undefined) continue
      items.push({
        id: placed.id,
        device,
        ...(placed.orientation === undefined ? {} : { orientation: placed.orientation }),
      })
    }
    return new Set(packAreaSlot(items, slot).overflowIds)
  }, [inSlot, lookup, slot])
  const full = slot.kind === 'fixed' && inSlot.length > 0

  // After a device goes in or out, focus lands on the slot's heading (the button that did it may
  // be gone: a full fixed slot hides "Add device", a removed device takes its row along).
  useLayoutEffect(() => {
    if (!focusHeading.current) return
    focusHeading.current = false
    headingRef.current?.focus()
  })

  function markDevice(placed: PlacedDevice, deviceLabel: string, have: boolean): void {
    const outcome = applyPlanOp(
      (plan) => ({ plan: markPlacementDevice(plan, placement.id, placed.id, have) }),
      spares,
    )
    announce(
      outcome.applied
        ? `${deviceLabel}: ${have ? HAVE_TEXT : NEED_TEXT}.${sparesText(outcome.sparesUsed)}`
        : (outcome.error ?? `${deviceLabel} could not be marked.`),
    )
  }

  function remove(placed: PlacedDevice, deviceLabel: string): void {
    const outcome = applyPlanOp(
      (plan) => ({ plan: removeDevice(plan, placement.id, placed.id) }),
      spares,
    )
    if (!outcome.applied) {
      announce(outcome.error ?? `${deviceLabel} could not be removed.`)
      return
    }
    focusHeading.current = true
    announce(
      placed.have
        ? `Removed the ${deviceLabel} from ${name}: it is back in Equipment to fit.`
        : `Removed the ${deviceLabel} from ${name}.`,
    )
  }

  return (
    <section aria-labelledby={headingId} className="grid gap-2 rounded-lg border p-2.5">
      <div className="grid gap-0.5">
        <h4
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {name}
        </h4>
        <p className="text-xs text-muted-foreground">
          {slot.kind === 'fixed' ? 'Holds one device' : 'Devices sit side by side'} ·{' '}
          {limitsText(slot)}
        </p>
      </div>
      {inSlot.length === 0 ? (
        <p className="text-sm text-muted-foreground">Empty.</p>
      ) : (
        <ul className="grid gap-1.5" aria-label={`Devices in ${name}`}>
          {inSlot.map((placed) => {
            const device = lookup.device(placed.deviceId)
            const deviceLabel =
              device === undefined ? `unknown device “${placed.deviceId}”` : deviceName(device)
            const fit = deviceFit(placed, slot, open, overflow)
            const FitIcon = fit.ok ? CircleCheck : device === undefined ? TriangleAlert : CircleX
            return (
              <li
                key={placed.id}
                data-testid={`inspector-device-${placed.id}`}
                className={cn(
                  'grid gap-1.5 rounded-md border p-2',
                  !placed.have && 'border-dashed border-foreground/30',
                  highlightId === placed.id && 'ring-2 ring-ring/50',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium break-words">{deviceLabel}</p>
                    {device === undefined ? null : (
                      <p className="text-xs text-muted-foreground">{dimsText(device.dims)}</p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove the ${deviceLabel} from ${name}`}
                    title="Remove from this slot"
                    disabled={readOnly}
                    onClick={() => remove(placed, deviceLabel)}
                  >
                    <X aria-hidden />
                  </Button>
                </div>
                <p
                  className={cn(
                    'flex items-start gap-1.5 text-xs',
                    fit.ok ? 'text-muted-foreground' : 'text-destructive',
                  )}
                >
                  <FitIcon aria-hidden className="mt-px size-3.5 shrink-0" />
                  {fit.text}
                </p>
                <HaveNeedToggle
                  have={placed.have}
                  label={`${deviceLabel}: in my rack or to get`}
                  onChange={(have) => markDevice(placed, deviceLabel, have)}
                  disabled={readOnly}
                  size="sm"
                />
              </li>
            )
          })}
        </ul>
      )}
      {full ? null : (
        <AddDevicePicker
          placementId={placement.id}
          slotName={name}
          slot={slot}
          open={open}
          spares={spares}
          announce={announce}
          onAdded={() => {
            // A fixed slot is full now: its picker goes, so focus moves to the slot's heading.
            if (slot.kind === 'fixed') focusHeading.current = true
          }}
        />
      )}
    </section>
  )
}

export function SlotDevices({
  placement,
  slots,
  open,
  spares,
  announce,
  highlightId,
}: {
  placement: Placement
  slots: readonly Slot[]
  open: OpenPlan
  spares: SpareContext
  announce: (text: string) => void
  /** A device entry to point out (selected on the rack). */
  highlightId?: string
}) {
  const headingId = useId()
  if (slots.length === 0) return null
  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <h3 id={headingId} className="text-sm font-medium">
        Devices
      </h3>
      {slots.map((slot) => (
        <SlotSection
          key={slot.id}
          placement={placement}
          slot={slot}
          open={open}
          spares={spares}
          announce={announce}
          {...(highlightId === undefined ? {} : { highlightId })}
        />
      ))}
    </section>
  )
}
