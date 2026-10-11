/**
 * Where the item being placed would land. Valid: a dashed outline, a check and "Fits at U4–U5".
 * Invalid: a cross-hatch, a cross and the first reason. Icon, pattern and words carry the meaning,
 * so it never depends on colour. Hidden from assistive tech: results are announced instead.
 */
import { CircleCheck, CircleX } from 'lucide-react'
import { memo } from 'react'
import type { PlacementBay } from '@/domain/schema/plan'
import { cn } from '@/lib/utils'
import type { Ghost } from '../editorState'
import { ghostText, truncateToWidth, uSpan } from './labels'
import type { RackPatterns } from './RackDefs'
import { innerBox, panelBox, visualSide, type RackLayout } from './rackLayout'

export const GhostShape = memo(function GhostShape({
  ghost,
  bay,
  layout,
  patterns,
}: {
  ghost: Ghost
  bay: PlacementBay
  layout: RackLayout
  patterns: RackPatterns
}) {
  const box = panelBox(layout, ghost.y, ghost.heightSixths, bay, ghost.face)
  const inner = innerBox(box, layout, visualSide(bay, ghost.face))
  const { start, end } = uSpan(ghost.y, ghost.heightSixths)
  const Icon = ghost.ok ? CircleCheck : CircleX
  const fontSize = Math.max(3.5, Math.min(6.5, box.height * 0.42))
  const chipHeight = Math.min(box.height - 1, fontSize * 1.8)
  const chipY = box.y + (box.height - chipHeight) / 2
  const iconSize = fontSize * 1.2
  const textX = inner.x + 3 + iconSize
  const text = truncateToWidth(ghostText(ghost), inner.x + inner.width - 2 - textX, fontSize)
  return (
    <g
      data-testid="rack-ghost"
      data-ok={ghost.ok}
      data-u-start={start}
      data-u-end={end}
      data-y={ghost.y}
      pointerEvents="none"
      aria-hidden="true"
    >
      <rect
        {...box}
        rx={1.4}
        strokeWidth={1.2}
        strokeDasharray="4 2"
        fill={ghost.ok ? undefined : `url(#${patterns.invalid})`}
        className={ghost.ok ? 'fill-foreground/10 stroke-foreground' : 'stroke-destructive'}
      />
      {chipHeight > 2 ? (
        <>
          <rect
            x={inner.x}
            y={chipY}
            width={inner.width}
            height={chipHeight}
            rx={chipHeight / 2}
            className="fill-background/95"
          />
          <Icon
            aria-hidden="true"
            x={inner.x + 1.5}
            y={chipY + (chipHeight - iconSize) / 2}
            width={iconSize}
            height={iconSize}
            className={ghost.ok ? 'text-foreground' : 'text-destructive'}
          />
          {text === null ? null : (
            <text
              x={textX}
              y={chipY + chipHeight / 2}
              dominantBaseline="central"
              fontSize={fontSize}
              className={cn('font-medium', ghost.ok ? 'fill-foreground' : 'fill-destructive')}
            >
              {text}
            </text>
          )}
        </>
      ) : null}
    </g>
  )
})
