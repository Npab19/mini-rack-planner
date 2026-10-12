/**
 * The inspector's persistent Rack tab: the frame's facts, the section stack editor, Set height,
 * the frame's options (rack, top, bottom, section defaults), the plan's accessories (things that
 * take no rack space) and what was removed but is still owned. Shown whenever nothing is selected.
 */
import { TriangleAlert } from 'lucide-react'
import { useId } from 'react'
import { effectiveFrameSize } from '@/domain/recipe'
import type { Frame } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import { AccessoriesSection } from '../extras/AccessoriesSection'
import { RemovedButOwnedSection } from '../retired/RemovedButOwnedSection'
import { FactList, OpenPageLink, sourceFacts, VerifiedFact, type Fact } from './EntryFacts'
import { FrameOptionsPanel } from './FrameOptionsPanel'
import type { SpareContext } from './planOps'
import { SetHeightForm } from './SetHeightForm'
import { StackEditor } from './StackEditor'
import type { OpenPlan } from './useOpenPlan'
import type { StackOps } from './useStackOps'

export interface RackTabProps {
  open: OpenPlan
  ops: StackOps
  spares: SpareContext
  announce: (text: string) => void
  /** Selects sections from the stack list (focus follows to the Selection tab). */
  onPick: (ids: readonly string[]) => void
}

function frameFacts(frame: Frame, plan: Plan): Fact[] {
  const size = effectiveFrameSize(frame, plan.frame.options)
  const deeper = size.depthMm !== frame.standard.depthMm
  return [
    ...sourceFacts(frame.source),
    {
      label: 'Depth',
      value: `${size.depthMm} mm between the rails${deeper ? ' (with your options)' : ''}`,
    },
    { label: 'Opening', value: `${size.innerWidthMm} mm wide` },
    { label: 'Height', value: `${frame.stack.minU}U to ${frame.stack.maxU}U` },
    { label: 'Checked', value: <VerifiedFact verified={frame.verified} /> },
  ]
}

function FrameFacts({ frame, plan }: { frame: Frame; plan: Plan }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2
          id={headingId}
          tabIndex={-1}
          data-panel-focus=""
          className="text-base font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {frame.name}
        </h2>
        {frame.source === undefined ? null : (
          <OpenPageLink url={frame.source.url} name={frame.name} />
        )}
      </div>
      <FactList facts={frameFacts(frame, plan)} />
    </section>
  )
}

export function RackTab({ open, ops, spares, announce, onPick }: RackTabProps) {
  const { frame } = open
  const planParts = (
    <>
      <AccessoriesSection open={open} spares={spares} announce={announce} />
      <RemovedButOwnedSection open={open} spares={spares} announce={announce} onPick={onPick} />
    </>
  )
  if (frame === undefined) {
    return (
      <div className="grid gap-5">
        <p className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-soft p-3 text-sm">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            This plan uses the frame “{open.plan.frame.frameId}”, which is not in your catalog, so
            its stack cannot be edited here.
          </span>
        </p>
        {planParts}
      </div>
    )
  }
  const withFrame = { ...open, frame }
  return (
    <div className="grid gap-5">
      <FrameFacts frame={frame} plan={open.plan} />
      <StackEditor open={withFrame} ops={ops} spares={spares} announce={announce} onPick={onPick} />
      <SetHeightForm open={withFrame} ops={ops} announce={announce} />
      <FrameOptionsPanel open={withFrame} spares={spares} announce={announce} />
      {planParts}
    </div>
  )
}
