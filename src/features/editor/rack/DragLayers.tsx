/**
 * The drawing's drag layers, each subscribed to just what it shows (`dragStore.ts`), so the rack
 * itself does not re-render while a ghost follows the pointer:
 * - `DragGhostLayer`: where a palette or tray drop, or a part being moved, would land;
 * - `SlotZones`: while a device is carried, the slots it could go in (drop targets);
 * - `GhostStatusPill` / `DragStatus`: the full verdict pinned to the bottom of the view.
 */
import { memo, useMemo } from 'react'
import type { CatalogLookup } from '@/domain/schema/catalog'
import type { Face } from '@/domain/schema/common'
import { cn } from '@/lib/utils'
import { useRackDrag, type DragGhost, type GhostStatus } from './dragStore'
import { slotZones } from './dropTarget'
import { GhostShape, SlotGhostShape, STATUS_ICON, type GhostView } from './GhostShape'
import { truncateToWidth, uSpan } from './labels'
import type { RackPatterns } from './RackDefs'
import type { RackLayout } from './rackLayout'
import type { PlacementView } from './rackModel'

function spanView(ghost: DragGhost): GhostView {
  return {
    y: ghost.y,
    heightSixths: ghost.heightSixths,
    face: ghost.face,
    bay: ghost.bay,
    status: ghost.status,
    text: ghost.text,
    origin: ghost.origin,
  }
}

/** The drag ghost on this face (none while nothing is carried or moved). */
export const DragGhostLayer = memo(function DragGhostLayer({
  face,
  layout,
  patterns,
}: {
  face: Face
  layout: RackLayout
  patterns: RackPatterns
}) {
  const ghost = useRackDrag((state) => state.ghost)
  if (ghost === null || ghost.face !== face) return null
  if (ghost.kind === 'slot' && ghost.box !== undefined) {
    return (
      <SlotGhostShape
        box={ghost.box}
        status={ghost.status}
        text={ghost.text}
        uStart={uSpan(ghost.y, ghost.heightSixths).start}
        placementId={ghost.placementId}
        slotId={ghost.slotId}
        patterns={patterns}
      />
    )
  }
  return <GhostShape ghost={spanView(ghost)} layout={layout} patterns={patterns} />
})

const ZONE_FONT_MM = 3.6

/** While a device is carried: every slot on this face, outlined and named, as a drop target. */
export const SlotZones = memo(function SlotZones({
  views,
  layout,
  catalog,
}: {
  views: readonly PlacementView[]
  layout: RackLayout
  catalog: CatalogLookup
}) {
  const carryingDevice = useRackDrag((state) => state.subject?.kind === 'device')
  const zones = useMemo(
    () => (carryingDevice ? views.flatMap((view) => slotZones(view, layout, catalog)) : []),
    [carryingDevice, views, layout, catalog],
  )
  if (zones.length === 0) return null
  return (
    <g data-layer="slot-zones" pointerEvents="none" aria-hidden="true">
      {zones.map((zone) => {
        const label = truncateToWidth(zone.label, zone.box.width - 3, ZONE_FONT_MM)
        return (
          <g
            key={`${zone.placementId}:${zone.slot.id}`}
            data-slot-zone={`${zone.placementId}:${zone.slot.id}`}
          >
            <rect
              {...zone.box}
              rx={1.2}
              strokeWidth={0.7}
              strokeDasharray="2 1.4"
              className="fill-none stroke-foreground/70"
            />
            {label === null || zone.box.height < ZONE_FONT_MM + 2 ? null : (
              <text
                x={zone.box.x + 1.5}
                y={zone.box.y + ZONE_FONT_MM + 0.6}
                fontSize={ZONE_FONT_MM}
                strokeWidth={ZONE_FONT_MM * 0.3}
                strokeLinejoin="round"
                className="fill-foreground font-medium [paint-order:stroke] stroke-background"
              >
                {label}
              </text>
            )}
          </g>
        )
      })}
    </g>
  )
})

/**
 * The ghost's verdict in full (the drawing has room for a shortened one), pinned to the bottom of
 * the view. Not announced: the release (or a click, or Enter) says the result.
 */
export function GhostStatusPill({ status, text }: { status: GhostStatus; text: string }) {
  const Icon = STATUS_ICON[status]
  const blocked = status === 'blocked'
  return (
    <p
      aria-hidden="true"
      data-testid="rack-ghost-status"
      data-status={status}
      className={cn(
        'pointer-events-none sticky bottom-2 z-10 mx-auto mt-2 flex w-fit max-w-full items-center gap-1.5 rounded-full border bg-background/95 px-3 py-1 text-sm shadow-sm',
        blocked ? 'border-destructive/40 text-destructive' : 'text-foreground',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span>{text}</span>
    </p>
  )
}

/** The pill for a drag ghost on this face. */
export function DragStatus({ face }: { face: Face }) {
  const ghost = useRackDrag((state) => state.ghost)
  if (ghost === null || ghost.face !== face) return null
  return <GhostStatusPill status={ghost.status} text={ghost.text} />
}
