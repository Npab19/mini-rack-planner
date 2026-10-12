/**
 * "Needs a mount?" (M3b): for a device no catalog mount takes, the rack height a mount for it
 * needs and the settings to type into popular parametric generators on MakerWorld, each as a list
 * to copy with a link to the generator's page (plain links: the app never contacts MakerWorld).
 * The main action creates a custom mount of that size in the open plan (the custom part editor,
 * `useAddPart`), ready to place. Once the model is printed, its downloaded 3MF/STL can be dropped
 * on the part later for 3D (files are only ever imported, never uploaded).
 *
 * Opened through `useMountDialogs.openNeedsAMount` (the equipment tray, the mount chooser);
 * rendered once by the editor (`MountDialogs`).
 */
import { Check, Copy, ExternalLink, Ruler, TriangleAlert, Wrench } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { LiveRegion, useAnnouncer } from '@/components/common/LiveRegion'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { formatU } from '@/domain/geometry'
import {
  GENERATOR_TOLERANCE_MM,
  generatorParamsText,
  generatorSuggestions,
  HALF_U_SIXTHS,
  MOUNT_CLEARANCE_MM,
  mountStepSixths,
  mountWarnings,
  suggestedMountSixths,
  type GeneratorSuggestion,
} from '@/domain/mountGenerator'
import { effectiveFrameSize } from '@/domain/recipe'
import { deviceName, type Device, type Frame } from '@/domain/schema/catalog'
import { useAddPart, type AddPartRequest, type AddPartTarget } from '@/features/custom/addPartStore'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { usePlanLookup } from '@/state/derived'
import { usePlanStore } from '@/state/planStore'
import { dimsText } from '../equipment/equipmentView'
import { customMountPrefill } from './chooserModel'
import { useMountDialogs, type NeedsAMountRequest } from './mountDialogsStore'

/** How long a Copy button says "Copied". */
export const COPIED_MS = 2000

const LINK_CLASS =
  'inline-flex items-center gap-1 rounded-sm text-sm font-medium underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50'

function requestKey(request: NeedsAMountRequest): string {
  return `${request.deviceId}:${request.equipmentId ?? ''}`
}

export function NeedsAMountDialog() {
  const request = useMountDialogs((state) => state.needsAMount)
  // Keeps the content on screen while the dialog animates closed.
  const [shown, setShown] = useState(request)
  if (request !== null && request !== shown) setShown(request)
  /** The custom part editor opens once this dialog has closed, so the two never fight over focus. */
  const thenAddPart = useRef<(AddPartRequest & AddPartTarget) | null>(null)

  function closed(open: boolean): void {
    if (open) return
    if (useMountDialogs.getState().needsAMount === null) setShown(null)
    const next = thenAddPart.current
    thenAddPart.current = null
    if (next !== null) useAddPart.getState().open(next)
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
        <NeedsAMountContent
          key={requestKey(shown)}
          request={shown}
          onCreate={(addPart) => {
            thenAddPart.current = addPart
            useMountDialogs.getState().close()
          }}
        />
      )}
    </Dialog>
  )
}

function NeedsAMountContent({
  request,
  onCreate,
}: {
  request: NeedsAMountRequest
  onCreate: (request: AddPartRequest & AddPartTarget) => void
}) {
  const plan = usePlanStore((state) => state.plan)
  const readOnly = usePlanStore((state) => state.readOnly)
  const lookup = usePlanLookup()
  const [message, announce] = useAnnouncer()
  const generatorsId = useId()
  const frame = plan === null ? undefined : lookup.frame(plan.frame.frameId)
  const device = lookup.device(request.deviceId)
  const name = device === undefined ? request.deviceId : deviceName(device)
  const rackOptions = plan?.frame.options

  const details = useMemo(() => {
    if (device === undefined || frame === undefined) return undefined
    return {
      heightSixths: suggestedMountSixths(device, frame),
      suggestions: generatorSuggestions(device, frame),
      warnings: mountWarnings(device, frame, effectiveFrameSize(frame, rackOptions)),
    }
  }, [device, frame, rackOptions])

  function create(): void {
    if (device === undefined || frame === undefined) return
    onCreate({
      kind: 'item',
      prefill: customMountPrefill(device, frame),
      addToOpenPlan: true,
      placeAfterSave: true,
      // From the tray: placing the new mount puts this device in it.
      ...(request.equipmentId === undefined ? {} : { placeEquipmentId: request.equipmentId }),
    })
  }

  return (
    <DialogContent
      data-testid="needs-a-mount"
      className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
    >
      <DialogHeader>
        <DialogTitle>Needs a mount?</DialogTitle>
        <DialogDescription>
          {device === undefined
            ? `“${request.deviceId}” is not in the catalog, so its size is unknown.`
            : `No mount in the catalog holds the ${name} (${dimsText(device)}, W × D × H) yet. Make one with a generator, or describe the one you have.`}
        </DialogDescription>
      </DialogHeader>

      {device === undefined || frame === undefined || details === undefined ? (
        <p role="alert" className="text-sm text-destructive">
          {frame === undefined && plan !== null
            ? `The frame "${plan.frame.frameId}" is not in the catalog.`
            : 'A mount can only be sized for a device whose size is known.'}
        </p>
      ) : (
        <>
          <SizeNote device={device} frame={frame} heightSixths={details.heightSixths} />
          {details.warnings.length === 0 ? null : (
            <ul className="grid gap-1 text-sm">
              {details.warnings.map((warning) => (
                <li key={warning} className="flex items-start gap-2">
                  <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <span>
                    <span className="sr-only">Warning: </span>
                    {warning}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <section aria-labelledby={generatorsId} className="grid gap-2">
            <h3 id={generatorsId} className="text-sm font-medium">
              Make one with a generator on MakerWorld
            </h3>
            <p className="text-xs text-muted-foreground">
              Open a generator, enter these settings and download the model it makes. Each size has{' '}
              {GENERATOR_TOLERANCE_MM} mm of room added.
            </p>
            <ul className="grid gap-2">
              {details.suggestions.map((suggestion) => (
                <GeneratorCard
                  key={suggestion.id}
                  suggestion={suggestion}
                  subject={name}
                  announce={announce}
                />
              ))}
            </ul>
          </section>
          <p className="text-xs text-muted-foreground">
            When the model is printed, you can drop the 3MF or STL you downloaded on the part to see
            it in 3D. Files are only read in your browser: they are never uploaded or shared.
          </p>
        </>
      )}

      <LiveRegion message={message} />

      <DialogFooter>
        <Button variant="outline" onClick={() => useMountDialogs.getState().close()}>
          Cancel
        </Button>
        <Button
          data-testid="needs-a-mount-create"
          disabled={device === undefined || frame === undefined || readOnly}
          className="h-auto min-h-8 whitespace-normal"
          onClick={create}
        >
          <Wrench aria-hidden />
          Create a custom mount sized for it
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

function SizeNote({
  device,
  frame,
  heightSixths,
}: {
  device: Device
  frame: Frame
  heightSixths: number
}) {
  const steps = mountStepSixths(frame) === HALF_U_SIXTHS ? 'half-U steps' : 'whole U'
  return (
    <p
      data-testid="needs-a-mount-size"
      className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-sm"
    >
      <Ruler aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>
        <span className="font-medium">A {formatU(heightSixths)} mount would hold it:</span> it is{' '}
        {Math.round(device.dims.h * 10) / 10} mm tall, plus {MOUNT_CLEARANCE_MM} mm of room, rounded
        up to {steps}.
      </span>
    </p>
  )
}

function GeneratorCard({
  suggestion,
  subject,
  announce,
}: {
  suggestion: GeneratorSuggestion
  /** The device's name. */
  subject: string
  announce: (text: string) => void
}) {
  const headingId = useId()
  const [copied, setCopied] = useState(false)
  /** The text to copy by hand when the browser blocks copying. */
  const [manual, setManual] = useState<string | null>(null)
  const manualRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    if (manual === null) return
    manualRef.current?.focus()
    manualRef.current?.select()
  }, [manual])

  async function copy(): Promise<void> {
    const text = generatorParamsText(suggestion)
    if (await copyText(text)) {
      setCopied(true)
      setManual(null)
      announce(`Copied the settings for ${suggestion.name}.`)
    } else {
      setManual(text)
      announce('Copying is blocked in this browser: the settings are selected to copy by hand.')
    }
  }

  return (
    <li data-testid={`generator-${suggestion.id}`} className="grid gap-2 rounded-lg border p-3">
      <div className="grid gap-0.5">
        <h4 id={headingId} className="text-sm font-medium break-words">
          {suggestion.name}
        </h4>
        <p className="text-xs text-muted-foreground">
          by {suggestion.designer}
          {suggestion.license === undefined ? '' : ` · ${suggestion.license}`} ·{' '}
          {formatU(suggestion.heightSixths)} for this device
        </p>
        <p className="text-xs">{suggestion.summary}</p>
      </div>
      <dl
        aria-labelledby={headingId}
        data-testid={`generator-params-${suggestion.id}`}
        className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 rounded-md bg-muted/40 p-2 text-xs"
      >
        {suggestion.params.map((param) => (
          <div key={param.name} className="contents">
            <dt className="min-w-0 break-words">
              {param.label}{' '}
              <code className="font-mono text-[0.7rem] text-muted-foreground">{param.name}</code>
            </dt>
            <dd className="text-right font-mono font-medium tabular-nums">{param.value}</dd>
          </div>
        ))}
      </dl>
      {suggestion.notes === undefined ? null : (
        <ul className="grid gap-0.5 text-xs text-muted-foreground">
          {suggestion.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          size="sm"
          variant="outline"
          data-testid={`generator-copy-${suggestion.id}`}
          onClick={() => void copy()}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          <span>{copied ? 'Copied' : 'Copy settings'}</span>{' '}
          <span className="sr-only">
            {copied ? `the settings for ${suggestion.name}` : `for ${suggestion.name}`}
          </span>
        </Button>
        <a
          href={suggestion.url}
          target="_blank"
          rel="noopener noreferrer"
          className={LINK_CLASS}
          data-testid={`generator-open-${suggestion.id}`}
        >
          Open on MakerWorld
          <ExternalLink aria-hidden className="size-3.5" />
          <span className="sr-only">: {suggestion.name} (opens in a new tab)</span>
        </a>
        {suggestion.sourceCode === undefined ? null : (
          <a
            href={suggestion.sourceCode.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(LINK_CLASS, 'text-muted-foreground')}
          >
            Source code ({suggestion.sourceCode.license})
            <ExternalLink aria-hidden className="size-3.5" />
            <span className="sr-only">: {suggestion.sourceCode.label} (opens in a new tab)</span>
          </a>
        )}
      </div>
      {manual === null ? null : (
        <div className="grid gap-1">
          <p className="text-xs">
            Copying is blocked here, so the settings for the {subject} are selected: press Ctrl+C
            (⌘C on a Mac) or use your device’s Copy.
          </p>
          <Textarea
            ref={manualRef}
            readOnly
            rows={suggestion.params.length + 1}
            spellCheck={false}
            aria-label={`Settings for ${suggestion.name}`}
            value={manual}
            onFocus={(event) => {
              // select() alone does not select on iOS.
              event.currentTarget.select()
              event.currentTarget.setSelectionRange(0, event.currentTarget.value.length)
            }}
            className="field-sizing-fixed font-mono text-xs md:text-xs"
          />
        </div>
      )}
    </li>
  )
}
