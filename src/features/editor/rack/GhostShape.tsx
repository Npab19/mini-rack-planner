/**
 * Where the part being placed, dropped or moved would land. Fits: a dashed outline, a check and
 * "Fits at U4–U5". Cannot go there: a cross-hatch, a cross and the first reason. A device dropped
 * on empty space: a dotted outline, a dot and "Choose a mount at U7". Icon, pattern and words
 * carry the meaning, so it never depends on colour. Hidden from assistive tech: results are
 * announced instead.
 *
 * Colour is the second cue: fits is green (`have`) over a light tint of the part's role colour
 * (`data-role`), cannot go there red (`destructive`), choose a mount blue (`info`). Outlines sit
 * on a background halo so they stay visible over any part colour.
 *
 * A device over a placement highlights the slot it would go in (`SlotGhostShape`) the same way.
 */
import { CircleCheck, CircleDot, CircleX } from 'lucide-react'
import { memo } from 'react'
import type { PartRole } from '@/domain/partRole'
import type { Face } from '@/domain/schema/common'
import type { PlacementBay } from '@/domain/schema/plan'
import { cn } from '@/lib/utils'
import type { Ghost } from '../editorState'
import type { GhostStatus } from './dragStore'
import { ghostText, truncateToWidth, uSpan } from './labels'
import type { RackPatterns } from './RackDefs'
import { innerBox, panelBox, visualSide, type Box, type RackLayout } from './rackLayout'

/** What a ghost shows, whatever made it. */
export interface GhostView {
  y: number
  heightSixths: number
  face: Face
  bay: PlacementBay
  status: GhostStatus
  text: string
  /** Click-to-place (and its keys), a palette or tray drop, or a part being moved. */
  origin: 'placing' | 'drop' | 'move'
  /** What the part is for: tints a ghost that fits. */
  role: PartRole
}

/** The click-to-place ghost (`useEditorState.ghost`) as a view. */
export function placingGhostView(
  ghost: Ghost,
  bay: PlacementBay,
  role: PartRole = 'neutral',
): GhostView {
  return {
    y: ghost.y,
    heightSixths: ghost.heightSixths,
    face: ghost.face,
    bay,
    status: ghost.ok ? 'ok' : 'blocked',
    text: ghostText(ghost),
    origin: 'placing',
    role,
  }
}

export const STATUS_ICON = { ok: CircleCheck, blocked: CircleX, choose: CircleDot } as const

/** The ghost's outline and fill (blocked also gets the cross-hatch pattern). */
const OUTLINE: Record<GhostStatus, string> = {
  ok: 'fill-(--part-fill)/45 stroke-have-border',
  blocked: 'stroke-destructive',
  choose: 'fill-info-soft/70 stroke-info-border',
}
const CHIP_STROKE: Record<GhostStatus, string> = {
  ok: 'stroke-have-border',
  blocked: 'stroke-destructive',
  choose: 'stroke-info-border',
}
const CHIP_ICON: Record<GhostStatus, string> = {
  ok: 'text-have',
  blocked: 'text-destructive',
  choose: 'text-info',
}
const CHIP_TEXT: Record<GhostStatus, string> = {
  ok: 'fill-foreground',
  blocked: 'fill-destructive',
  choose: 'fill-foreground',
}

/** A ghost's outline: a background halo under the status-coloured (dashed) stroke. */
function GhostOutline({
  box,
  rx,
  strokeWidth,
  dash,
  status,
  hatch,
}: {
  box: Box
  rx: number
  strokeWidth: number
  dash: string
  status: GhostStatus
  hatch: string
}) {
  return (
    <>
      <rect
        {...box}
        rx={rx}
        strokeWidth={strokeWidth * 2.2}
        className="fill-none stroke-background/80"
      />
      <rect
        {...box}
        rx={rx}
        strokeWidth={strokeWidth}
        strokeDasharray={dash}
        fill={status === 'blocked' ? `url(#${hatch})` : undefined}
        className={OUTLINE[status]}
      />
    </>
  )
}

/**
 * The chip inside a ghost: icon and words on a background. Its height follows `box`, its width
 * `inner` (the opening between the rails, for a part across the panel).
 */
function GhostChip({
  box,
  inner = box,
  status,
  text,
}: {
  box: Box
  inner?: Box
  status: GhostStatus
  text: string
}) {
  const Icon = STATUS_ICON[status]
  const fontSize = Math.max(3.5, Math.min(6.5, box.height * 0.42))
  const chipHeight = Math.min(box.height - 1, fontSize * 1.8)
  if (chipHeight <= 2) return null
  const chipY = box.y + (box.height - chipHeight) / 2
  const iconSize = fontSize * 1.2
  const textX = inner.x + 3 + iconSize
  const shown = truncateToWidth(text, inner.x + inner.width - 2 - textX, fontSize)
  return (
    <>
      <rect
        x={inner.x}
        y={chipY}
        width={inner.width}
        height={chipHeight}
        rx={chipHeight / 2}
        strokeWidth={0.5}
        className={cn('fill-background/95', CHIP_STROKE[status])}
      />
      <Icon
        aria-hidden="true"
        x={inner.x + 1.5}
        y={chipY + (chipHeight - iconSize) / 2}
        width={iconSize}
        height={iconSize}
        className={CHIP_ICON[status]}
      />
      {shown === null ? null : (
        <text
          x={textX}
          y={chipY + chipHeight / 2}
          dominantBaseline="central"
          fontSize={fontSize}
          className={cn('font-medium', CHIP_TEXT[status])}
        >
          {shown}
        </text>
      )}
    </>
  )
}

export const GhostShape = memo(function GhostShape({
  ghost,
  layout,
  patterns,
}: {
  ghost: GhostView
  layout: RackLayout
  patterns: RackPatterns
}) {
  const box = panelBox(layout, ghost.y, ghost.heightSixths, ghost.bay, ghost.face)
  const inner = innerBox(box, layout, visualSide(ghost.bay, ghost.face))
  const { start, end } = uSpan(ghost.y, ghost.heightSixths)
  const blocked = ghost.status === 'blocked'
  return (
    <g
      data-testid="rack-ghost"
      data-ok={!blocked}
      data-u-start={start}
      data-u-end={end}
      data-y={ghost.y}
      data-ghost-u-start={start}
      data-ghost-valid={!blocked}
      data-ghost-status={ghost.status}
      data-ghost-origin={ghost.origin}
      data-ghost-bay={ghost.bay}
      data-role={ghost.role}
      pointerEvents="none"
      aria-hidden="true"
    >
      <GhostOutline
        box={box}
        rx={1.4}
        strokeWidth={1.2}
        dash={ghost.status === 'choose' ? '1.2 1.8' : '4 2'}
        status={ghost.status}
        hatch={patterns.invalid}
      />
      <GhostChip box={box} inner={inner} status={ghost.status} text={ghost.text} />
    </g>
  )
})

/** A device over a placement: the slot it would go in, with ✓ / ✗ and the words. */
export const SlotGhostShape = memo(function SlotGhostShape({
  box,
  status,
  text,
  uStart,
  placementId,
  slotId,
  role = 'neutral',
  patterns,
}: {
  box: Box
  status: GhostStatus
  text: string
  /** The carried device's role: tints a slot it fits. */
  role?: PartRole
  /** The holder's lowest U (for tests: `data-ghost-u-start`). */
  uStart: number
  placementId: string | undefined
  slotId: string | undefined
  patterns: RackPatterns
}) {
  const blocked = status === 'blocked'
  const ring = { x: box.x - 1, y: box.y - 1, width: box.width + 2, height: box.height + 2 }
  return (
    <g
      data-testid="rack-slot-ghost"
      data-ok={!blocked}
      data-ghost-valid={!blocked}
      data-ghost-status={status}
      data-ghost-u-start={uStart}
      data-target-placement-id={placementId}
      data-slot-id={slotId}
      data-role={role}
      pointerEvents="none"
      aria-hidden="true"
    >
      <GhostOutline
        box={ring}
        rx={1.6}
        strokeWidth={1.3}
        dash="4 2"
        status={status}
        hatch={patterns.invalid}
      />
      <GhostChip box={ring} status={status} text={text} />
    </g>
  )
})
