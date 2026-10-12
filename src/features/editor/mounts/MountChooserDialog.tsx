/**
 * The mount chooser (M3b): after a device is dropped on the rack (or placed from somewhere that
 * knows the spot but not the mount), it lists what can hold the device there: its own ears
 * (ear-mounted gear), the catalog mounts that take it (frame-specific first, then the least rack
 * space) and a generic shelf. Each says, in words and with an icon, whether it fits where the
 * device was dropped or where the nearest free spot is. Choosing one places the device on it in
 * one undo step (`placeOnChosenMount`); when nothing takes the device, "Needs a mount?" helps
 * design one.
 *
 * Opened through `useMountDialogs.openChooser`; rendered once by the editor (`MountDialogs`).
 * Keyboard: focus starts on the first option's Place button, Tab moves through the options,
 * Escape closes. After a placement the result is announced in the editor's live region, the new
 * part is selected and focused on the rack (the arrow keys then move it).
 *
 * Colour repeats the words and icons: a role dot before each mount, "fits where you dropped it" in
 * green, "not where you dropped it" in the warning tone and the nearest free spot as info.
 */
import {
  CircleCheck,
  CircleSlash,
  MoveVertical,
  PackageSearch,
  TriangleAlert,
  Wrench,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { HAVE_TEXT } from '@/components/common/HaveNeed'
import { RoleDot } from '@/components/common/PartRole'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatU } from '@/domain/geometry'
import { catalogEntryRole, deviceRole, type PartRole } from '@/domain/partRole'
import { deviceName } from '@/domain/schema/catalog'
import type { Face } from '@/domain/schema/common'
import { cn } from '@/lib/utils'
import { usePlanLookup } from '@/state/derived'
import { usePlanStore } from '@/state/planStore'
import { useRecordingMode } from '@/state/uiStore'
import { dimsText } from '../equipment/equipmentView'
import { useSpareContext } from '../inspector/planOps'
import { announce } from '../layout/announcer'
import { positionText } from '../rack/labels'
import { selectInEditor } from '../selection'
import { chooserOptions, type ChooserOption } from './chooserModel'
import { focusPlacement, placeOnChosenMount } from './mountActions'
import {
  useMountDialogs,
  type MountChooserRequest,
  type NeedsAMountRequest,
} from './mountDialogsStore'

const FACE_TEXT: Record<Face, string> = { front: 'front', rear: 'rear' }

function requestKey(request: MountChooserRequest): string {
  return `${request.deviceId}:${request.equipmentId ?? ''}:${request.face}:${request.y}`
}

export function MountChooserDialog() {
  const request = useMountDialogs((state) => state.chooser)
  // Keeps the content on screen while the dialog animates closed.
  const [shown, setShown] = useState(request)
  if (request !== null && request !== shown) setShown(request)
  /** The part placed from the chooser, focused on the rack when the dialog closes. */
  const placed = useRef<string | null>(null)
  /** "Needs a mount?" opens once this dialog has closed, so the two never fight over focus. */
  const thenNeedsAMount = useRef<NeedsAMountRequest | null>(null)

  function closed(open: boolean): void {
    if (open) return
    if (useMountDialogs.getState().chooser === null) setShown(null)
    const next = thenNeedsAMount.current
    thenNeedsAMount.current = null
    if (next !== null) useMountDialogs.getState().openNeedsAMount(next)
  }

  /** After a placement the new part takes focus on the rack; otherwise focus goes back. */
  function finalFocus(): boolean {
    const placementId = placed.current
    placed.current = null
    return !(placementId !== null && focusPlacement(placementId))
  }

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) useMountDialogs.getState().close()
      }}
      onOpenChangeComplete={closed}
    >
      {shown === null ? null : (
        <ChooserContent
          key={requestKey(shown)}
          request={shown}
          finalFocus={finalFocus}
          onPlaced={(placementId) => {
            placed.current = placementId
            useMountDialogs.getState().close()
          }}
          onNeedsAMount={(next) => {
            thenNeedsAMount.current = next
            useMountDialogs.getState().close()
          }}
        />
      )}
    </Dialog>
  )
}

function ChooserContent({
  request,
  finalFocus,
  onPlaced,
  onNeedsAMount,
}: {
  request: MountChooserRequest
  /** Where focus goes when the dialog closes (see Base UI's `finalFocus`). */
  finalFocus: () => boolean
  onPlaced: (placementId: string) => void
  onNeedsAMount: (request: NeedsAMountRequest) => void
}) {
  const plan = usePlanStore((state) => state.plan)
  const planId = usePlanStore((state) => state.planId)
  const readOnly = usePlanStore((state) => state.readOnly)
  const recording = useRecordingMode(planId)
  const lookup = usePlanLookup()
  const spares = useSpareContext()
  const [error, setError] = useState<string | null>(null)

  const frame = plan === null ? undefined : lookup.frame(plan.frame.frameId)
  const device = lookup.device(request.deviceId)
  const options = useMemo(
    () =>
      plan === null || frame === undefined || device === undefined
        ? []
        : chooserOptions(plan, lookup, frame, device, request.face, request.y),
    [plan, lookup, frame, device, request.face, request.y],
  )
  const name = device === undefined ? request.deviceId : deviceName(device)
  const dropped = `${positionText(request.y, 1)} on the ${FACE_TEXT[request.face]}`

  function choose(option: ChooserOption): void {
    const outcome = placeOnChosenMount(lookup, request, option, spares)
    if (!outcome.ok || outcome.placementId === undefined) {
      setError(outcome.message)
      return
    }
    announce(outcome.message)
    selectInEditor([outcome.placementId])
    onPlaced(outcome.placementId)
  }

  function needsAMount(): void {
    onNeedsAMount({
      deviceId: request.deviceId,
      ...(request.equipmentId === undefined ? {} : { equipmentId: request.equipmentId }),
    })
  }

  const problem =
    plan === null
      ? 'No plan is open.'
      : readOnly
        ? 'This plan is read-only: it was made with a newer version.'
        : frame === undefined
          ? `The frame "${plan.frame.frameId}" is not in the catalog.`
          : device === undefined
            ? `“${request.deviceId}” is not in the catalog, so its size and mounts are unknown.`
            : undefined
  const anyFree = options.some((option) => option.spot !== null)

  return (
    <DialogContent
      data-testid="mount-chooser"
      className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
      finalFocus={finalFocus}
    >
      <DialogHeader>
        <DialogTitle>
          Choose a mount for{' '}
          {device === undefined ? null : (
            <RoleDot role={deviceRole(device.category)} className="mr-1 mb-0.5 align-middle" />
          )}
          {name}
        </DialogTitle>
        <DialogDescription>
          {device === undefined
            ? `Dropped at ${dropped}.`
            : `${dimsText(device)} (W × D × H), dropped at ${dropped}.`}
          {recording ? ` What you place now is marked ${HAVE_TEXT}.` : ''}
        </DialogDescription>
      </DialogHeader>

      {problem !== undefined ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : options.length === 0 ? (
        <NothingTakesIt name={name} onNeedsAMount={needsAMount} />
      ) : (
        <>
          {anyFree ? null : (
            <p className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-soft p-2.5 text-sm">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>
                None of these has a free spot on the {FACE_TEXT[request.face]}. Free some space, or
                add a section with the + handles beside the rack.
              </span>
            </p>
          )}
          <ul aria-label={`Ways to mount ${name}`} className="grid gap-2">
            {options.map((option) => (
              <OptionRow
                key={option.itemId}
                option={option}
                role={catalogEntryRole(lookup, option.itemId)}
                frameName={frame?.name}
                subject={name}
                onChoose={choose}
              />
            ))}
          </ul>
        </>
      )}

      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        {problem === undefined && options.length > 0 ? (
          <Button
            variant="ghost"
            className="h-auto min-h-8 whitespace-normal sm:mr-auto"
            data-testid="mount-chooser-design"
            onClick={needsAMount}
          >
            <Wrench aria-hidden />
            None of these? Needs a mount?
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => useMountDialogs.getState().close()}>
          Cancel
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

function NothingTakesIt({ name, onNeedsAMount }: { name: string; onNeedsAMount: () => void }) {
  return (
    <div className="grid gap-3 rounded-lg border border-info-border bg-info-soft p-3">
      <p className="flex items-start gap-2 text-sm">
        <PackageSearch aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
        <span>
          No mount in the catalog takes the {name} yet. “Needs a mount?” suggests a size and the
          settings for popular mount generators.
        </span>
      </p>
      <Button className="w-fit" data-testid="mount-chooser-needs-a-mount" onClick={onNeedsAMount}>
        <Wrench aria-hidden />
        Needs a mount?
      </Button>
    </div>
  )
}

function OptionRow({
  option,
  role,
  frameName,
  subject,
  onChoose,
}: {
  option: ChooserOption
  /** What the mount (or the ear-mounted device) is for: its dot. */
  role: PartRole
  frameName: string | undefined
  /** The device's name. */
  subject: string
  onChoose: (option: ChooserOption) => void
}) {
  const spot = option.spot
  const where = spot === null ? undefined : positionText(spot.y, option.heightSixths)
  const extra =
    spot === null
      ? ''
      : `${spot.bay === 'full' ? '' : `, ${spot.bay} half`}${spot.face === 'rear' ? ', on the rear' : ''}`
  const title =
    option.kind === 'own-ears'
      ? 'With its own ears'
      : option.kind === 'generic-shelf'
        ? `${option.name} (any shelf of this size)`
        : option.name
  return (
    <li
      data-testid={`mount-option-${option.itemId}`}
      data-fits={option.atDrop}
      className={cn(
        'grid gap-2 rounded-lg border p-3',
        option.atDrop && where !== undefined && 'border-have-border',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium break-words">
          <RoleDot role={role} className="mr-1.5 mb-px align-middle" />
          {title}
        </span>
        <span className="text-xs text-muted-foreground">{formatU(option.heightSixths)}</span>
        {option.frameSpecific && frameName !== undefined ? (
          <Badge variant="info" className="whitespace-normal">
            made for {frameName}
          </Badge>
        ) : null}
      </div>
      {option.atDrop && where !== undefined ? (
        <p className="flex items-start gap-1.5 text-xs font-medium text-have">
          <CircleCheck aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>
            Fits where you dropped it: {where}
            {extra}.
          </span>
        </p>
      ) : (
        <div className="grid gap-1 text-xs">
          <p className="flex items-start gap-1.5">
            <CircleSlash aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
            <span>
              Not where you dropped it
              {option.dropReason === undefined ? '.' : `: ${option.dropReason}`}
            </span>
          </p>
          <p
            className={cn(
              'flex items-start gap-1.5',
              where === undefined ? 'text-muted-foreground' : 'font-medium text-info',
            )}
          >
            <MoveVertical aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>
              {where === undefined
                ? 'There is no free spot for it.'
                : `Nearest free spot: ${where}${extra}.`}
            </span>
          </p>
        </div>
      )}
      {where === undefined ? null : (
        <Button
          size="sm"
          variant={option.atDrop ? 'default' : 'outline'}
          className="h-auto min-h-7 w-fit py-1 text-left whitespace-normal"
          data-testid={`mount-place-${option.itemId}`}
          onClick={() => onChoose(option)}
        >
          {option.kind === 'own-ears'
            ? `Place the ${subject} at ${where}${extra}`
            : `Place on ${option.name} at ${where}${extra}`}
        </Button>
      )}
    </li>
  )
}
