import { CircleCheck, CircleX } from 'lucide-react'
import { useId, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import {
  CATALOG,
  EAR_HOLE_SPACING_MM,
  formatSpan,
  HOLE_OFFSETS_IN_U_MM,
  PANEL_CLEARANCE_MM,
  RACK_HEIGHT_MM,
  RACK_UNITS,
  RACK_WIDTH_MM,
  sixthsToMm,
  svgYOfSixths,
  U_MM,
  uNumber,
  type ItemKind,
  type Placement,
  type Sixths,
} from './rackModel'
import type { Ghost } from './useRackDnd'

/** Ear width of a 10" rack: (254 − 222.25) / 2. */
const RAIL_WIDTH_MM = 15.875
const HOLE_RADIUS_MM = 2.6
const HOLE_X_MM = [
  (RACK_WIDTH_MM - EAR_HOLE_SPACING_MM) / 2,
  (RACK_WIDTH_MM + EAR_HOLE_SPACING_MM) / 2,
]
const UNITS = Array.from({ length: RACK_UNITS }, (_, index) => index + 1)

const KIND_STYLES: Record<ItemKind, string> = {
  '1u': 'fill-sky-200 stroke-sky-700 dark:fill-sky-900 dark:stroke-sky-300',
  '2u': 'fill-violet-200 stroke-violet-700 dark:fill-violet-900 dark:stroke-violet-300',
  half: 'fill-amber-200 stroke-amber-700 dark:fill-amber-900 dark:stroke-amber-300',
}

/** Panel rectangle in drawing mm (y grows downwards). */
function panelBox(y: Sixths, height: Sixths): { top: number; height: number } {
  return {
    top: svgYOfSixths(y + height) + PANEL_CLEARANCE_MM / 2,
    height: sixthsToMm(height) - PANEL_CLEARANCE_MM,
  }
}

export interface RackDrawingProps {
  placements: readonly Placement[]
  ghost: Ghost | null
  movingId: string | null
  keyboardHelpId: string
  onItemKeyDown: (placement: Placement, event: KeyboardEvent<SVGGElement>) => void
}

export function RackDrawing({
  placements,
  ghost,
  movingId,
  keyboardHelpId,
  onItemKeyDown,
}: RackDrawingProps) {
  // useId output is not a valid URL fragment as-is (React wraps it in « »).
  const hatchId = `spike-hatch-${useId().replace(/[^\w-]/g, '')}`
  return (
    <>
      <defs>
        <pattern
          id={hatchId}
          width={4}
          height={4}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width={4} height={4} className="fill-red-500/15" />
          <line x1={0} y1={0} x2={0} y2={4} strokeWidth={1.4} className="stroke-red-600/60" />
        </pattern>
      </defs>
      <RackFrame />
      <g data-layer="placements">
        {/* Stable (insertion) order: re-ordering DOM nodes would blur the focused item. */}
        {placements.map((placement) => (
          <PlacedItem
            key={placement.id}
            placement={placement}
            moving={placement.id === movingId}
            keyboardHelpId={keyboardHelpId}
            onKeyDown={onItemKeyDown}
          />
        ))}
      </g>
      {ghost && <GhostShape ghost={ghost} hatchId={hatchId} />}
    </>
  )
}

function RackFrame() {
  return (
    <g data-layer="frame" aria-hidden="true">
      <rect
        data-rack-face=""
        x={0}
        y={0}
        width={RACK_WIDTH_MM}
        height={RACK_HEIGHT_MM}
        className="fill-background"
      />
      {UNITS.map((u) => {
        const top = RACK_HEIGHT_MM - u * U_MM
        return (
          <g key={u}>
            {u % 2 === 0 && (
              <rect x={0} y={top} width={RACK_WIDTH_MM} height={U_MM} className="fill-muted/60" />
            )}
            <line
              x1={0}
              x2={RACK_WIDTH_MM}
              y1={top}
              y2={top}
              strokeWidth={0.4}
              className="stroke-border"
            />
            <text
              data-u-label={u}
              x={-5}
              y={top + U_MM / 2}
              textAnchor="end"
              dominantBaseline="central"
              fontSize={9}
              className="fill-muted-foreground font-medium tabular-nums"
            >
              U{u}
            </text>
          </g>
        )
      })}
      {[0, RACK_WIDTH_MM - RAIL_WIDTH_MM].map((x) => (
        <rect
          key={x}
          x={x}
          y={0}
          width={RAIL_WIDTH_MM}
          height={RACK_HEIGHT_MM}
          className="fill-muted-foreground/15"
        />
      ))}
      {UNITS.flatMap((u) =>
        HOLE_OFFSETS_IN_U_MM.flatMap((offset) =>
          HOLE_X_MM.map((x) => (
            <circle
              key={`${u}-${offset}-${x}`}
              cx={x}
              cy={RACK_HEIGHT_MM - ((u - 1) * U_MM + offset)}
              r={HOLE_RADIUS_MM}
              strokeWidth={0.5}
              className="fill-background stroke-muted-foreground/50"
            />
          )),
        ),
      )}
      <rect
        x={0}
        y={0}
        width={RACK_WIDTH_MM}
        height={RACK_HEIGHT_MM}
        strokeWidth={1}
        className="fill-none stroke-foreground/40"
      />
    </g>
  )
}

function PlacedItem({
  placement,
  moving,
  keyboardHelpId,
  onKeyDown,
}: {
  placement: Placement
  moving: boolean
  keyboardHelpId: string
  onKeyDown: (placement: Placement, event: KeyboardEvent<SVGGElement>) => void
}) {
  const { name, heightSixths } = CATALOG[placement.kind]
  const box = panelBox(placement.y, heightSixths)
  const span = formatSpan(placement.y, heightSixths)
  return (
    <g
      data-placed-id={placement.id}
      data-item-kind={placement.kind}
      data-u-start={uNumber(placement.y)}
      data-y-sixths={placement.y}
      data-height-sixths={heightSixths}
      role="button"
      tabIndex={0}
      aria-roledescription="rack item"
      aria-label={`${name}, ${span}`}
      aria-describedby={keyboardHelpId}
      className={cn('group cursor-grab outline-none', moving && 'opacity-35')}
      onKeyDown={(event) => onKeyDown(placement, event)}
    >
      <rect
        x={0.6}
        y={box.top}
        width={RACK_WIDTH_MM - 1.2}
        height={box.height}
        rx={1.6}
        strokeWidth={0.8}
        className={KIND_STYLES[placement.kind]}
      />
      <rect
        x={-1.2}
        y={box.top - 1.8}
        width={RACK_WIDTH_MM + 2.4}
        height={box.height + 3.6}
        rx={2.6}
        strokeWidth={1.6}
        className="fill-none stroke-foreground opacity-0 group-focus-visible:opacity-100"
      />
      <text
        x={RACK_WIDTH_MM / 2}
        y={box.top + box.height / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={heightSixths < 6 ? 7 : 8.5}
        className="pointer-events-none fill-foreground font-medium"
      >
        {name} · {span}
      </text>
    </g>
  )
}

function GhostShape({ ghost, hatchId }: { ghost: Ghost; hatchId: string }) {
  const { heightSixths } = CATALOG[ghost.kind]
  const box = panelBox(ghost.y, heightSixths)
  const ok = ghost.verdict.ok
  const Icon = ok ? CircleCheck : CircleX
  const chipHeight = 11
  const chipTop = box.top + box.height / 2 - chipHeight / 2
  return (
    <g
      data-ghost=""
      data-ghost-origin={ghost.origin}
      data-ghost-u-start={uNumber(ghost.y)}
      data-ghost-valid={ok}
      data-ghost-reason={ok ? '' : ghost.verdict.code}
      pointerEvents="none"
      aria-hidden="true"
    >
      <rect
        x={0.6}
        y={box.top}
        width={RACK_WIDTH_MM - 1.2}
        height={box.height}
        rx={1.6}
        strokeWidth={1.4}
        strokeDasharray="5 3"
        fill={ok ? undefined : `url(#${hatchId})`}
        className={ok ? 'fill-emerald-500/20 stroke-emerald-600' : 'stroke-red-600'}
      />
      <rect
        x={6}
        y={chipTop}
        width={RACK_WIDTH_MM - 12}
        height={chipHeight}
        rx={2}
        className="fill-background/90"
      />
      <Icon
        x={8}
        y={chipTop + 1.5}
        size={8}
        strokeWidth={2.5}
        className={ok ? 'text-emerald-600' : 'text-red-600'}
      />
      <text
        x={19}
        y={chipTop + chipHeight / 2}
        dominantBaseline="central"
        fontSize={6.5}
        className={cn(
          'font-semibold',
          ok ? 'fill-emerald-800 dark:fill-emerald-300' : 'fill-red-800 dark:fill-red-300',
        )}
      >
        {ok ? ghost.verdict.message : `Blocked: ${ghost.verdict.message}`}
      </text>
    </g>
  )
}
