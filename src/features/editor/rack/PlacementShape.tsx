/**
 * One placement on the rack face: the panel across the panel area at its U range, a subtle
 * drawing of what it is (vent slots, keystones, fans, outlets, a shelf deck, a tray, gear ports),
 * the devices in its slots at their true front size, and its label.
 *
 * Colour says what a part is for (`data-role` picks the `--part` tokens): In my rack is filled with
 * the role's tint (devices in a mount a step stronger) inside a solid role outline. Have vs To get
 * never relies on colour: To get is a pale tint with an amber hatch, a dashed outline and an amber
 * "To get" tag. Unknown catalog ids draw as a dotted, labelled placeholder.
 */
import { ArrowUpDown, CircleHelp } from 'lucide-react'
import { memo, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { fitLabel, TAG_FONT_SCALE, TAG_TEXT, textWidthMm } from './labels'
import { SelectionRing, type RackPatterns } from './RackDefs'
import {
  holeColumnsX,
  innerBox,
  openingOriginX,
  panelBox,
  svgYOfSixths,
  visualSide,
  type Box,
  type RackLayout,
  type VisualSide,
} from './rackLayout'
import {
  placementAriaLabel,
  type DeviceView,
  type DrawStyle,
  type PlacementView,
} from './rackModel'

export interface PlacementShapeProps {
  view: PlacementView
  layout: RackLayout
  patterns: RackPatterns
  selected: boolean
  /** A device on it that is selected (drawn with a selection ring). */
  selectedDeviceId: string | null
  /** The one placement in the roving tab order. */
  roving: boolean
  /** Focused and selected: the arrow keys move it. */
  moving: boolean
  /** Being moved with the pointer: drawn faded where it is while the ghost shows where it goes. */
  dragging?: boolean
  /** Id of the keyboard help text. */
  helpId: string
  register: (id: string, node: SVGGElement | null) => void
}

/** Panel fill: the role's tint when it is in my rack, a paler one when it is still to get. */
const PANEL_FILL = {
  have: 'fill-(--part-fill)/80',
  need: 'fill-(--part-soft)/70 dark:fill-(--part-soft)/45',
} as const
/** Device fill: a step stronger than the mount's, so devices stand out on it. */
const DEVICE_FILL = {
  have: 'fill-(--part-strong)',
  need: 'fill-(--part-soft)/70 dark:fill-(--part-soft)/45',
} as const
/** Styles drawn across the middle of the panel. */
const MIDDLE_DECORATION: ReadonlySet<DrawStyle> = new Set([
  'vent',
  'keystone',
  'fan',
  'power',
  'device',
])
/** Height of the label strip along the top of a placement. */
const TOP_STRIP_MM = 12
const HALO = '[paint-order:stroke] stroke-background'

export const PlacementShape = memo(function PlacementShape({
  view,
  layout,
  patterns,
  selected,
  selectedDeviceId,
  roving,
  moving,
  dragging = false,
  helpId,
  register,
}: PlacementShapeProps) {
  const box = panelBox(layout, view.y, view.heightSixths, view.bay, view.face)
  const side = visualSide(view.bay, view.face)
  const inner = innerBox(box, layout, side)
  const bottom = svgYOfSixths(layout, view.y)
  const originX = openingOriginX(layout, view.bay, view.face)
  const unknown = !view.known
  const ref = useCallback(
    (node: SVGGElement | null) => {
      register(view.id, node)
    },
    [register, view.id],
  )

  return (
    <g
      ref={ref}
      data-testid={`rack-placement-${view.id}`}
      data-placement-id={view.id}
      data-u-start={view.uStart}
      data-u-end={view.uEnd}
      data-y={view.y}
      data-have={view.have}
      data-face={view.face}
      data-known={view.known}
      data-role={view.role}
      data-selected={selected || undefined}
      data-dragging={dragging || undefined}
      role="button"
      tabIndex={roving ? 0 : -1}
      aria-label={placementAriaLabel(view)}
      aria-pressed={selected}
      aria-describedby={helpId}
      className={cn('cursor-pointer outline-none', dragging && 'opacity-40')}
    >
      {/* Opaque base: the tints below are translucent and the rails must not show through. */}
      <rect {...box} rx={1.4} className="fill-rack-inner" />
      <rect
        {...box}
        rx={1.4}
        strokeWidth={0.6}
        strokeDasharray={unknown ? '1 1.6' : view.have ? undefined : '3 2'}
        className={
          unknown
            ? 'fill-background stroke-foreground/55'
            : cn(
                // A catalog colour replaces the role tint; the role outline stays.
                view.color === undefined
                  ? PANEL_FILL[view.have ? 'have' : 'need']
                  : 'fill-background',
                'stroke-(--part)',
              )
        }
      />
      {view.color === undefined || unknown ? null : (
        <rect {...box} rx={1.4} fill={view.color} fillOpacity={view.have ? 0.35 : 0.14} />
      )}
      {view.have || unknown ? null : (
        <rect {...box} rx={1.4} fill={`url(#${patterns.need})`} data-pattern="need" />
      )}
      <Decoration style={view.style} inner={inner} box={box} patterns={patterns} />
      <Screws view={view} layout={layout} side={side} bottom={bottom} />
      {view.devices.map((device) => (
        <DeviceShape
          key={device.id}
          device={device}
          rect={{
            x: originX + device.xMm,
            y: bottom - device.yMm - device.hMm,
            width: device.wMm,
            height: device.hMm,
          }}
          patterns={patterns}
          selected={device.id === selectedDeviceId}
        />
      ))}
      <PlacementLabel view={view} inner={inner} box={box} unknown={unknown} />
      {selected ? (
        <SelectionRing
          x={box.x + 1.1}
          y={box.y + 1.1}
          width={Math.max(0, box.width - 2.2)}
          height={Math.max(0, box.height - 2.2)}
          rx={1.2}
          strokeWidth={1.8}
        />
      ) : null}
      {moving ? (
        <ArrowUpDown
          aria-hidden="true"
          x={layout.panelWidthMm + 2}
          y={box.y + box.height / 2 - 4}
          width={8}
          height={8}
          className="text-foreground"
        />
      ) : null}
    </g>
  )
})

/**
 * The keyboard focus ring of a placement, drawn above everything (neighbours would cover a ring
 * drawn with the item) and outside it, dashed, so it never merges with the inset selection ring.
 */
export function PlacementFocusRing({ view, layout }: { view: PlacementView; layout: RackLayout }) {
  const box = panelBox(layout, view.y, view.heightSixths, view.bay, view.face)
  return (
    <rect
      data-focus-ring={view.id}
      aria-hidden="true"
      pointerEvents="none"
      x={box.x - 1.6}
      y={box.y - 1.6}
      width={box.width + 3.2}
      height={box.height + 3.2}
      rx={2.4}
      strokeWidth={1.2}
      strokeDasharray="3 1.5"
      className="fill-none stroke-foreground"
    />
  )
}

// ---------------------------------------------------------------------------------------------
// Label

function PlacementLabel({
  view,
  inner,
  box,
  unknown,
}: {
  view: PlacementView
  inner: Box
  box: Box
  unknown: boolean
}) {
  // With devices, or a drawing across its middle, the label sits in a strip along the top so
  // both stay visible.
  const onTop =
    view.devices.length > 0 || (MIDDLE_DECORATION.has(view.style) && box.height > TOP_STRIP_MM * 2)
  const rowHeight = onTop ? Math.min(box.height, TOP_STRIP_MM) : box.height
  const iconRoom = unknown ? 7 : 0
  const fit = fitLabel({
    name: unknown ? `Unknown part: ${view.name}` : view.name,
    range: view.position,
    tag: !view.have,
    width: inner.width - iconRoom,
    height: rowHeight,
    maxFontSize: onTop ? 6.5 : 9,
    padding: 1,
  })
  if (fit === null) return null
  const f = fit.fontSize
  const cy = box.y + rowHeight / 2
  const left = inner.x + 1 + iconRoom
  const right = inner.x + inner.width - 1
  const gap = 0.8 * f
  const rangeWidth = fit.range === null ? 0 : textWidthMm(fit.range, f)
  const tagRight = right - (fit.range === null ? 0 : rangeWidth + gap)
  const tagHeight = f * 1.3
  return (
    <g pointerEvents="none" aria-hidden="true">
      {unknown ? (
        <CircleHelp
          x={inner.x + 1}
          y={cy - 3}
          width={6}
          height={6}
          className="text-foreground"
          aria-hidden="true"
        />
      ) : null}
      {fit.name === null ? null : (
        <text
          x={left}
          y={cy}
          dominantBaseline="central"
          fontSize={f}
          strokeWidth={f * 0.3}
          strokeLinejoin="round"
          className={cn('fill-foreground font-medium', HALO)}
        >
          {fit.name}
        </text>
      )}
      {fit.tag ? (
        <g data-tag="to-get">
          <rect
            x={tagRight - fit.tagWidth}
            y={cy - tagHeight / 2}
            width={fit.tagWidth}
            height={tagHeight}
            rx={tagHeight / 2}
            strokeWidth={0.45}
            strokeDasharray="1.6 1"
            className="fill-need-soft stroke-need-border"
          />
          <text
            x={tagRight - fit.tagWidth / 2}
            y={cy}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={f * TAG_FONT_SCALE}
            className="fill-need font-medium"
          >
            {TAG_TEXT}
          </text>
        </g>
      ) : null}
      {fit.range === null ? null : (
        <text
          x={right}
          y={cy}
          textAnchor="end"
          dominantBaseline="central"
          fontSize={f}
          strokeWidth={f * 0.3}
          strokeLinejoin="round"
          className={cn('fill-muted-foreground tabular-nums', HALO)}
        >
          {fit.range}
        </text>
      )}
    </g>
  )
}

// ---------------------------------------------------------------------------------------------
// Devices

function DeviceShape({
  device,
  rect,
  patterns,
  selected,
}: {
  device: DeviceView
  rect: Box
  patterns: RackPatterns
  selected: boolean
}) {
  const fit = fitLabel({
    name: device.known ? device.name : `Unknown device: ${device.name}`,
    tag: !device.have,
    width: rect.width,
    height: rect.height,
    maxFontSize: 5.5,
    minFontSize: 3,
    padding: 1.5,
  })
  const f = fit?.fontSize ?? 0
  const cy = rect.y + rect.height / 2
  const tagHeight = f * 1.3
  return (
    <g
      data-device-id={device.id}
      data-have={device.have}
      data-role={device.role}
      data-selected={selected || undefined}
      className="cursor-pointer"
    >
      <rect
        {...rect}
        rx={1.2}
        strokeWidth={0.5}
        strokeDasharray={device.known ? (device.have ? undefined : '2.5 1.5') : '1 1.5'}
        className={
          device.known
            ? cn(DEVICE_FILL[device.have ? 'have' : 'need'], 'stroke-(--part)')
            : 'fill-background stroke-foreground/70'
        }
      />
      {device.have ? null : <rect {...rect} rx={1.2} fill={`url(#${patterns.need})`} />}
      {fit === null ? null : (
        <g pointerEvents="none" aria-hidden="true">
          {fit.name === null ? null : (
            <text
              x={rect.x + 1.5}
              y={cy}
              dominantBaseline="central"
              fontSize={f}
              strokeWidth={f * 0.3}
              strokeLinejoin="round"
              className={cn('fill-foreground', HALO)}
            >
              {fit.name}
            </text>
          )}
          {fit.tag ? (
            <g data-tag="to-get">
              <rect
                x={rect.x + rect.width - 1.5 - fit.tagWidth}
                y={cy - tagHeight / 2}
                width={fit.tagWidth}
                height={tagHeight}
                rx={tagHeight / 2}
                strokeWidth={0.4}
                strokeDasharray="1.6 1"
                className="fill-need-soft stroke-need-border"
              />
              <text
                x={rect.x + rect.width - 1.5 - fit.tagWidth / 2}
                y={cy}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={f * TAG_FONT_SCALE}
                className="fill-need font-medium"
              >
                {TAG_TEXT}
              </text>
            </g>
          ) : null}
        </g>
      )}
      {selected ? (
        <SelectionRing
          x={rect.x + 0.8}
          y={rect.y + 0.8}
          width={Math.max(0, rect.width - 1.6)}
          height={Math.max(0, rect.height - 1.6)}
          rx={0.8}
          strokeWidth={1.4}
        />
      ) : null}
    </g>
  )
}

// ---------------------------------------------------------------------------------------------
// Screws and decorations

/** Screw heads at the item's ear holes, when the catalog knows where they are. */
function Screws({
  view,
  layout,
  side,
  bottom,
}: {
  view: PlacementView
  layout: RackLayout
  side: VisualSide
  bottom: number
}) {
  if (view.holeOffsetsMm.length === 0) return null
  const [leftX, rightX] = holeColumnsX(layout)
  const columns = side === 'full' ? [leftX, rightX] : side === 'left' ? [leftX] : [rightX]
  return (
    <g aria-hidden="true">
      {view.holeOffsetsMm.flatMap((offset) =>
        columns.map((x) => (
          <circle
            key={`${offset}-${x}`}
            cx={x}
            cy={bottom - offset}
            r={1.6}
            className="fill-foreground/45"
          />
        )),
      )}
    </g>
  )
}

/** Decorations take the part's role colour, faintly. */
const DECORATION = 'fill-none stroke-(--part)/45'
const SOCKET = 'fill-background/55 stroke-(--part)/45'

function Decoration({
  style,
  inner,
  box,
  patterns,
}: {
  style: DrawStyle
  inner: Box
  box: Box
  patterns: RackPatterns
}) {
  switch (style) {
    case 'vent':
      return <rect {...inner} fill={`url(#${patterns.vent})`} aria-hidden="true" />
    case 'keystone':
      return <Keystones inner={inner} />
    case 'fan':
      return <Fans inner={inner} />
    case 'power':
      return <Outlets inner={inner} />
    case 'shelf':
      return (
        <rect
          x={inner.x}
          y={box.y + box.height - 3.4}
          width={inner.width}
          height={1.8}
          rx={0.6}
          className="fill-(--part)/55"
          aria-hidden="true"
        />
      )
    case 'tray':
      return <rect {...inner} rx={2} strokeWidth={0.6} className={DECORATION} aria-hidden="true" />
    case 'device':
      return <Ports inner={inner} />
    case 'blank':
    case 'other':
    case 'unknown':
      return null
  }
}

/** Evenly spaced positions of `count` things `size` wide, centred in `inner`. */
function spread(inner: Box, size: number, gap: number, count: number): number[] {
  const total = count * size + (count - 1) * gap
  const start = inner.x + (inner.width - total) / 2
  return Array.from({ length: count }, (_, index) => start + index * (size + gap))
}

function Keystones({ inner }: { inner: Box }) {
  const size = Math.min(14, inner.height - 4)
  if (size < 4) return null
  const gap = 3
  const count = Math.min(12, Math.floor((inner.width + gap) / (size + gap)))
  if (count < 1) return null
  const y = inner.y + (inner.height - size) / 2
  return (
    <g aria-hidden="true">
      {spread(inner, size, gap, count).map((x) => (
        <rect
          key={x}
          x={x}
          y={y}
          width={size}
          height={size}
          rx={1}
          strokeWidth={0.5}
          className={SOCKET}
        />
      ))}
    </g>
  )
}

function Fans({ inner }: { inner: Box }) {
  const diameter = Math.min(inner.height - 3, 80)
  if (diameter < 8) return null
  const gap = 8
  const count = Math.max(1, Math.min(4, Math.floor((inner.width + gap) / (diameter + gap))))
  const r = diameter / 2
  const cy = inner.y + inner.height / 2
  return (
    <g aria-hidden="true">
      {spread(inner, diameter, gap, count).map((x) => {
        const cx = x + r
        return (
          <g key={x}>
            <circle cx={cx} cy={cy} r={r} strokeWidth={0.6} className={DECORATION} />
            <circle cx={cx} cy={cy} r={r * 0.62} strokeWidth={0.4} className={DECORATION} />
            <circle cx={cx} cy={cy} r={r * 0.16} className="fill-(--part)/45" />
          </g>
        )
      })}
    </g>
  )
}

function Outlets({ inner }: { inner: Box }) {
  const height = Math.min(16, inner.height - 6)
  if (height < 6) return null
  const width = height * 1.3
  const gap = 8
  const count = Math.min(6, Math.floor((inner.width + gap) / (width + gap)))
  if (count < 1) return null
  const y = inner.y + (inner.height - height) / 2
  return (
    <g aria-hidden="true">
      {spread(inner, width, gap, count).map((x) => (
        <g key={x}>
          <rect
            x={x}
            y={y}
            width={width}
            height={height}
            rx={height * 0.25}
            strokeWidth={0.5}
            className={SOCKET}
          />
          <rect
            x={x + width * 0.3}
            y={y + height * 0.3}
            width={0.9}
            height={height * 0.4}
            className="fill-foreground/45"
          />
          <rect
            x={x + width * 0.7 - 0.9}
            y={y + height * 0.3}
            width={0.9}
            height={height * 0.4}
            className="fill-foreground/45"
          />
        </g>
      ))}
    </g>
  )
}

function Ports({ inner }: { inner: Box }) {
  const height = Math.min(5, inner.height * 0.35)
  if (height < 2) return null
  const width = height * 1.4
  const gap = height * 0.5
  const count = Math.min(8, Math.floor((inner.width * 0.5 + gap) / (width + gap)))
  if (count < 1) return null
  const y = inner.y + (inner.height - height) / 2
  const right = { ...inner, x: inner.x + inner.width * 0.45, width: inner.width * 0.5 }
  return (
    <g aria-hidden="true">
      <circle cx={inner.x + 3} cy={y + height / 2} r={0.9} className="fill-foreground/50" />
      <circle cx={inner.x + 6} cy={y + height / 2} r={0.9} className="fill-foreground/30" />
      {spread(right, width, gap, count).map((x) => (
        <rect
          key={x}
          x={x}
          y={y}
          width={width}
          height={height}
          rx={0.5}
          strokeWidth={0.4}
          className={SOCKET}
        />
      ))}
    </g>
  )
}
