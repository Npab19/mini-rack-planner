/**
 * "Reuse" for a removed part or section: where it goes back. It goes back In my rack, as it was
 * built, in one undo step.
 * - A part lists the free spots for it, its devices counted (`reuseSpots`), lowest first, on the
 *   face picked when it mounts on both; the lowest free spot is chosen to start with.
 * - A section goes on top of the stack or at the bottom (what is above then moves up with it).
 * Errors stay in the dialog. The host closes it and announces the result (`onReused`).
 */
import { ArchiveRestore } from 'lucide-react'
import { useId, useMemo, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { listNames, type StackEnd } from '@/domain/frame'
import { resolvePlaceable, type FreeSpot } from '@/domain/placement'
import {
  reuseRetiredPlacement,
  reuseRetiredSection,
  reuseSpots,
  type RetiredView,
} from '@/domain/retired'
import type { Face } from '@/domain/schema/common'
import { usePlanStore } from '@/state/planStore'
import { NativeSelect } from '../inspector/NativeSelect'
import { applyPlanOp, type SpareContext } from '../inspector/planOps'
import { stackText } from '../inspector/sectionOps'
import { positionText } from '../inspector/stackModel'
import type { OpenPlan } from '../inspector/useOpenPlan'

export interface ReuseDialogProps {
  /** The removed part or section to put back; the dialog is open while it is set. */
  view: RetiredView | null
  open: OpenPlan
  spares: SpareContext
  onClose: () => void
  /** It went back: the new placement's or section's id, and what to announce. */
  onReused: (id: string, message: string) => void
}

export function ReuseDialog({ view, open, spares, onClose, onReused }: ReuseDialogProps) {
  const shown = view !== null && (view.reuse === 'placement' || view.reuse === 'section')
  return (
    <Dialog
      open={shown}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      {shown ? (
        <DialogContent className="sm:max-w-md" data-testid="reuse-dialog">
          {view.reuse === 'placement' ? (
            <PlacementReuse
              key={view.id}
              view={view}
              open={open}
              spares={spares}
              onClose={onClose}
              onReused={onReused}
            />
          ) : (
            <SectionReuse
              key={view.id}
              view={view}
              open={open}
              spares={spares}
              onClose={onClose}
              onReused={onReused}
            />
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

interface ContentProps {
  view: RetiredView
  open: OpenPlan
  spares: SpareContext
  onClose: () => void
  onReused: (id: string, message: string) => void
}

const FACE_TEXT: Readonly<Record<Face, string>> = { front: 'Front', rear: 'Rear' }

function spotKey(spot: FreeSpot): string {
  return `${spot.face}:${spot.y}:${spot.bay}`
}

function spotText(spot: FreeSpot, heightSixths: number, half: boolean): string {
  const where = positionText(spot.y, heightSixths)
  return half ? `${where}, ${spot.bay} half` : where
}

function withDevices(view: RetiredView): string {
  return view.devices.length === 0 ? '' : `, with the ${listNames(view.devices)}`
}

function PlacementReuse({ view, open, spares, onClose, onReused }: ContentProps) {
  const { plan, lookup, readOnly } = open
  const selectId = useId()
  const faceLabelId = useId()
  const errorId = useId()
  const info = useMemo(() => {
    const placeable = view.itemId === undefined ? undefined : resolvePlaceable(lookup, view.itemId)
    const faces: readonly Face[] = placeable?.faces ?? []
    const spots = new Map(faces.map((face) => [face, reuseSpots(plan, lookup, view.id, face)]))
    return { placeable, faces, spots }
  }, [plan, lookup, view.id, view.itemId])
  const firstFace =
    info.faces.find((face) => (info.spots.get(face)?.length ?? 0) > 0) ?? info.faces[0] ?? 'front'
  const [face, setFace] = useState<Face>(firstFace)
  const [chosenKey, setChosenKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const spots = info.spots.get(face) ?? []
  const chosen = spots.find((spot) => spotKey(spot) === chosenKey) ?? spots[0]
  const height = Math.max(info.placeable?.heightSixths ?? 6, 1)
  const half = info.placeable?.bay === 'half'

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (chosen === undefined) return
    let placementId: string | undefined
    const outcome = applyPlanOp((current) => {
      const result = reuseRetiredPlacement(current, lookup, view.id, chosen.y, chosen.face, {
        bay: chosen.bay,
      })
      placementId = result.placementId
      return result
    }, spares)
    if (!outcome.applied || placementId === undefined) {
      setError(outcome.error ?? `${view.name} could not go back.`)
      return
    }
    onReused(
      placementId,
      `Put ${view.name} back at ${spotText(chosen, height, half)} on the ${chosen.face}, In my rack${withDevices(view)}.`,
    )
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Reuse {view.name}</DialogTitle>
        <DialogDescription>
          {spots.length === 0
            ? `No free spot fits it on the ${face}.`
            : `It goes back In my rack, as it was built${withDevices(view)}. Pick where its bottom edge goes.`}
        </DialogDescription>
      </DialogHeader>

      {info.faces.length > 1 ? (
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
            {info.faces.map((candidate) => (
              <label key={candidate} className="flex cursor-pointer items-center gap-2 text-sm">
                <RadioGroupItem value={candidate} aria-label={FACE_TEXT[candidate]} />
                <span>{FACE_TEXT[candidate]}</span>
              </label>
            ))}
          </RadioGroup>
        </div>
      ) : null}

      {spots.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Remove or move something, or add a section under Sections, then try again.
        </p>
      ) : (
        <div className="grid gap-1.5">
          <Label htmlFor={selectId}>Position</Label>
          <NativeSelect
            id={selectId}
            data-testid="reuse-position"
            value={chosen === undefined ? '' : spotKey(chosen)}
            aria-invalid={error === null ? undefined : true}
            aria-describedby={error === null ? undefined : errorId}
            onChange={(event) => {
              setChosenKey(event.target.value)
              setError(null)
            }}
          >
            {spots.map((spot) => (
              <option key={spotKey(spot)} value={spotKey(spot)}>
                {spotText(spot, height, half)}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}

      {error === null ? null : (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={readOnly || chosen === undefined}
          data-testid="reuse-submit"
        >
          <ArchiveRestore aria-hidden />
          {chosen === undefined ? 'Put back' : `Put back at ${spotText(chosen, height, half)}`}
        </Button>
      </DialogFooter>
    </form>
  )
}

const END_TEXT: Readonly<Record<StackEnd, string>> = {
  top: 'On top of the stack',
  bottom: 'At the bottom of the stack',
}

function SectionReuse({ view, open, spares, onClose, onReused }: ContentProps) {
  const { frame, lookup, readOnly } = open
  const endLabelId = useId()
  const [at, setAt] = useState<StackEnd>('top')
  const [error, setError] = useState<string | null>(null)

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    let sectionId: string | undefined
    const outcome = applyPlanOp((current) => {
      const result = reuseRetiredSection(current, lookup, view.id, at)
      sectionId = result.sectionId
      return result
    }, spares)
    if (!outcome.applied || sectionId === undefined) {
      const conflicts = outcome.conflicts.map((conflict) => conflict.message).join(' ')
      setError(outcome.error ?? (conflicts || `${view.name} could not go back.`))
      return
    }
    const after = usePlanStore.getState().plan
    const stack = after === null || frame === undefined ? '' : ` ${stackText(after, frame)}`
    onReused(
      sectionId,
      `Put the ${view.name} back ${at === 'top' ? 'on top' : 'at the bottom'}, In my rack.${stack}`,
    )
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Reuse {view.name}</DialogTitle>
        <DialogDescription>
          It goes back into the stack In my rack, as it was built. At the bottom, everything above
          moves up with its sections.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <span id={endLabelId} className="text-sm font-medium">
          Where
        </span>
        <RadioGroup
          aria-labelledby={endLabelId}
          value={at}
          onValueChange={(next: unknown) => {
            setAt(next === 'bottom' ? 'bottom' : 'top')
            setError(null)
          }}
          className="flex flex-wrap gap-x-4 gap-y-2"
        >
          {(['top', 'bottom'] as const).map((end) => (
            <label key={end} className="flex cursor-pointer items-center gap-2 text-sm">
              <RadioGroupItem value={end} aria-label={END_TEXT[end]} />
              {END_TEXT[end]}
            </label>
          ))}
        </RadioGroup>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={readOnly} data-testid="reuse-submit">
          <ArchiveRestore aria-hidden />
          {at === 'top' ? 'Put back on top' : 'Put back at the bottom'}
        </Button>
      </DialogFooter>
    </form>
  )
}
