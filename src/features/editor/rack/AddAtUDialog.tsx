/**
 * "Add at U…": places what the palette (or the equipment tray) is placing without a pointer. It
 * lists every start where the item fits on the chosen face (`canPlace` over its allowed phases)
 * and commits exactly like a click on the rack (`placeAt`): one undo step, Have in Recording mode,
 * and the same announcement.
 *
 * The rack (or the palette, as a fallback) owns `open`; the dialog reads the plan, catalog and face
 * from the stores. `source` defaults to `useEditorState.placing`. Closing returns focus to what
 * opened it. When that is gone after a placement (the placing banner goes once something is
 * placed, the inspector shows the new part instead of the old one), `focusAfterPlacing` decides.
 */
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { Face } from '@/domain/schema/common'
import { usePlanLookup } from '@/state/derived'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { useEditorState, type PlaceSource } from '../editorState'
import { useSpareContext } from '../inspector/planOps'
import { placeAt } from './commit'
import { positionText } from './labels'
import { describeSource, sourceKey, validSpots, type Spot } from './placeActions'

export interface AddAtUDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What to add; defaults to what is being placed (`useEditorState.placing`). */
  source?: PlaceSource | null
  /** Called with the new placement's id after it was added. */
  onPlaced?: (placementId: string) => void
  /**
   * After a placement, once the dialog has closed: called when focus did not find its way back
   * (the control that opened the dialog is gone), so the host can put it somewhere useful.
   */
  focusAfterPlacing?: () => void
}

/** Focus fell to the page: nothing (or the body) has it. */
function focusIsLost(): boolean {
  const active = document.activeElement
  return active === null || active === document.body
}

export function AddAtUDialog({
  open,
  onOpenChange,
  source,
  onPlaced,
  focusAfterPlacing,
}: AddAtUDialogProps) {
  const placing = useEditorState((state) => state.placing)
  const what = source ?? placing
  const [message, announce] = useAnnouncer()
  /** Set when the dialog closes because something was placed. */
  const placed = useRef(false)
  const focusAfter = useRef(focusAfterPlacing)
  useEffect(() => {
    focusAfter.current = focusAfterPlacing
  })

  // After a placement, give the host a say once the dialog has handed focus back.
  useEffect(() => {
    if (open || !placed.current) return
    placed.current = false
    const timer = setTimeout(() => {
      if (focusIsLost()) focusAfter.current?.()
    }, 0)
    return () => clearTimeout(timer)
  }, [open])

  return (
    <>
      <Dialog open={open && what !== null} onOpenChange={onOpenChange}>
        {open && what !== null ? (
          <AddAtUContent
            key={sourceKey(what)}
            source={what}
            onClose={() => onOpenChange(false)}
            onPlaced={(placementId, text) => {
              placed.current = true
              announce(text)
              onOpenChange(false)
              if (placementId !== undefined) onPlaced?.(placementId)
            }}
          />
        ) : null}
      </Dialog>
      {/* Outside the dialog, so the result is still announced after it closes. */}
      <LiveRegion message={message} />
    </>
  )
}

function spotKey(spot: Spot): string {
  return `${spot.y}:${spot.bay}`
}

function spotText(spot: Spot, heightSixths: number, half: boolean): string {
  const where = positionText(spot.y, heightSixths)
  return half ? `${where}, ${spot.bay} half` : where
}

const FACE_TEXT: Record<Face, string> = { front: 'Front', rear: 'Rear' }

function AddAtUContent({
  source,
  onClose,
  onPlaced,
}: {
  source: PlaceSource
  onClose: () => void
  onPlaced: (placementId: string | undefined, message: string) => void
}) {
  const plan = usePlanStore((state) => state.plan)
  const readOnly = usePlanStore((state) => state.readOnly)
  const catalog = usePlanLookup()
  const spares = useSpareContext()
  const viewFace = useUiStore((state) => state.face)
  const frame = plan === null ? undefined : catalog.frame(plan.frame.frameId)
  const info = useMemo(
    () =>
      plan === null || frame === undefined
        ? undefined
        : describeSource(plan, catalog, frame, source),
    [plan, catalog, frame, source],
  )
  const faces = info?.faces ?? ['front']
  const [face, setFace] = useState<Face>(
    faces.includes(viewFace) ? viewFace : (faces[0] ?? 'front'),
  )
  const spots = useMemo(
    () =>
      plan === null || frame === undefined || info === undefined
        ? []
        : validSpots(plan, catalog, frame, info, face),
    [plan, catalog, frame, info, face],
  )
  const [chosenKey, setChosenKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const chosen = spots.find((spot) => spotKey(spot) === chosenKey) ?? spots[0]
  const positionsId = useId()
  const faceLabelId = useId()
  const name = info?.name ?? 'this item'
  const height = info?.heightSixths ?? 6
  const half = info?.half ?? false

  function submit(): void {
    if (chosen === undefined) return
    const outcome = placeAt(catalog, source, chosen, spares)
    if (outcome.ok) onPlaced(outcome.createdId, outcome.message)
    else setError(outcome.message)
  }

  const problem =
    plan === null
      ? 'No plan is open.'
      : readOnly
        ? 'This plan is read-only.'
        : frame === undefined
          ? `The frame "${plan.frame.frameId}" is not in the catalog.`
          : info?.problem

  return (
    <DialogContent data-testid="add-at-u-dialog" className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Add {name} at…</DialogTitle>
        <DialogDescription>
          {problem !== undefined
            ? 'It cannot be placed on the rack.'
            : spots.length === 0
              ? `No free spot fits it on the ${face}.`
              : `${spots.length} free ${spots.length === 1 ? 'spot' : 'spots'} on the ${face}. Pick where its bottom edge goes.`}
        </DialogDescription>
      </DialogHeader>

      {problem === undefined && faces.length > 1 ? (
        <div className="grid gap-1.5">
          <span id={faceLabelId} className="text-sm font-medium">
            Face
          </span>
          <RadioGroup
            aria-labelledby={faceLabelId}
            value={face}
            onValueChange={(next: unknown) => {
              if (next === 'front' || next === 'rear') {
                setFace(next)
                setChosenKey(null)
                setError(null)
              }
            }}
            className="flex gap-4"
          >
            {faces.map((candidate) => (
              <label key={candidate} className="flex cursor-pointer items-center gap-2 text-sm">
                <RadioGroupItem value={candidate} aria-label={FACE_TEXT[candidate]} />
                <span>{FACE_TEXT[candidate]}</span>
              </label>
            ))}
          </RadioGroup>
        </div>
      ) : null}

      {problem !== undefined ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : spots.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Remove or move something, or add a section with the + handles beside the rack.
        </p>
      ) : (
        <div className="grid gap-1.5">
          <span id={positionsId} className="text-sm font-medium">
            Position
          </span>
          <div className="max-h-64 overflow-y-auto rounded-lg border p-2">
            <RadioGroup
              aria-labelledby={positionsId}
              value={chosen === undefined ? '' : spotKey(chosen)}
              onValueChange={(next: unknown) => {
                if (typeof next === 'string') {
                  setChosenKey(next)
                  setError(null)
                }
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                submit()
              }}
              className="gap-1"
            >
              {spots.map((spot) => {
                const text = spotText(spot, height, half)
                return (
                  <label
                    key={spotKey(spot)}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted"
                  >
                    <RadioGroupItem value={spotKey(spot)} aria-label={text} />
                    <span className="tabular-nums">{text}</span>
                  </label>
                )
              })}
            </RadioGroup>
          </div>
        </div>
      )}

      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={problem !== undefined || chosen === undefined}
          onClick={submit}
          data-testid="add-at-u-submit"
        >
          {chosen === undefined ? 'Add' : `Add at ${spotText(chosen, height, half)}`}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
