/**
 * The frame layer of the rack drawing (decorative, hidden from assistive tech: the "Rack contents"
 * list and the section bands carry the same facts) and the section bands beside the rails.
 */
import { memo, type KeyboardEvent, type MouseEvent } from 'react'
import { HAVE_TEXT, HaveIcon, NEED_TEXT, NeedIcon } from '@/components/common/HaveNeed'
import { rangeText, truncateToWidth } from './labels'
import { SIXTHS_PER_U, U_MM } from '@/domain/geometry'
import { cn } from '@/lib/utils'
import { SelectionRing, type RackPatterns } from './RackDefs'
import { holeColumnsX, railHoleYsMm, svgYOfMm, svgYOfSixths, type RackLayout } from './rackLayout'
import { sectionAriaLabel, type JointView, type SectionView } from './rackModel'

const HOLE_RADIUS_MM = 2.4
const U_LABEL_FONT_MM = 7.5
/** Height of a band's label block (type, Have / To get, range). */
const BAND_LABEL_BLOCK_MM = 28
/** Text halo: legible over hatching. */
const HALO = '[paint-order:stroke] stroke-background'

/** Joints are recomputed on every edit; the frame only redraws when they really change. */
function sameJoints(a: readonly JointView[], b: readonly JointView[]): boolean {
  return (
    a.length === b.length &&
    a.every((joint, index) => {
      const other = b[index]
      return (
        other !== undefined &&
        joint.ySixths === other.ySixths &&
        joint.upperId === other.upperId &&
        joint.lowerId === other.lowerId &&
        joint.deadY0 === other.deadY0 &&
        joint.deadY1 === other.deadY1
      )
    })
  )
}

interface RackFrameProps {
  layout: RackLayout
  joints: readonly JointView[]
  patterns: RackPatterns
}

export const RackFrame = memo(
  function RackFrame({ layout, joints, patterns }: RackFrameProps) {
    const units = Math.floor(layout.topSixths / SIXTHS_PER_U)
    const top = svgYOfSixths(layout, layout.topSixths)
    const bottom = svgYOfSixths(layout, 0)
    const width = layout.panelWidthMm
    const holeXs = holeColumnsX(layout)
    const unitIndexes = Array.from({ length: units }, (_, index) => index)
    return (
      <g aria-hidden="true" data-layer="frame">
        <rect x={0} y={top} width={width} height={bottom - top} className="fill-rack-inner" />
        {unitIndexes.map((u) =>
          u % 2 === 1 ? (
            <rect
              key={`shade-${u}`}
              x={0}
              y={svgYOfMm(layout, (u + 1) * U_MM)}
              width={width}
              height={U_MM}
              className="fill-rack-inner-alt"
            />
          ) : null,
        )}
        {unitIndexes.map((u) => (
          <line
            key={`line-${u}`}
            x1={0}
            x2={width}
            y1={svgYOfMm(layout, u * U_MM)}
            y2={svgYOfMm(layout, u * U_MM)}
            strokeWidth={0.35}
            className="stroke-border"
          />
        ))}
        {[0, width - layout.railWidthMm].map((x) => (
          <rect
            key={`rail-${x}`}
            x={x}
            y={top}
            width={layout.railWidthMm}
            height={bottom - top}
            strokeWidth={0.4}
            className="fill-rack-rail stroke-rack-rail-edge"
          />
        ))}
        {railHoleYsMm(layout).flatMap((yMm) =>
          holeXs.map((x) => (
            <circle
              key={`hole-${yMm}-${x}`}
              cx={x}
              cy={svgYOfMm(layout, yMm)}
              r={HOLE_RADIUS_MM}
              strokeWidth={0.45}
              className="fill-rack-hole stroke-rack-hole-edge"
            />
          )),
        )}
        {unitIndexes.map((u) => (
          <text
            key={`label-${u}`}
            data-u-label={u + 1}
            x={-4}
            y={svgYOfMm(layout, u * U_MM + U_MM / 2)}
            textAnchor="end"
            dominantBaseline="central"
            fontSize={U_LABEL_FONT_MM}
            className="fill-rack-label font-medium tabular-nums"
          >
            U{u + 1}
          </text>
        ))}
        {joints.map((joint) => (
          <JointLine key={joint.upperId} joint={joint} layout={layout} patterns={patterns} />
        ))}
        <rect
          x={0}
          y={top}
          width={width}
          height={bottom - top}
          strokeWidth={0.6}
          className="fill-none stroke-rack-outline"
        />
      </g>
    )
  },
  (previous: RackFrameProps, next: RackFrameProps) =>
    previous.layout === next.layout &&
    previous.patterns === next.patterns &&
    sameJoints(previous.joints, next.joints),
)

function JointLine({
  joint,
  layout,
  patterns,
}: {
  joint: JointView
  layout: RackLayout
  patterns: RackPatterns
}) {
  const y = svgYOfSixths(layout, joint.ySixths)
  const deadTop = svgYOfSixths(layout, joint.deadY1)
  const deadBottom = svgYOfSixths(layout, joint.deadY0)
  return (
    <g data-joint={joint.ySixths}>
      {joint.deadY1 > joint.deadY0 ? (
        <rect
          x={0}
          y={deadTop}
          width={layout.panelWidthMm}
          height={deadBottom - deadTop}
          fill={`url(#${patterns.dead})`}
        />
      ) : null}
      <line
        x1={-2}
        x2={layout.bandX}
        y1={y}
        y2={y}
        strokeWidth={0.6}
        strokeDasharray="3 2"
        className="stroke-rack-joint"
      />
    </g>
  )
}

/** The connector plate drawn across the band column at each joint (the KWS "Frame connectors"). */
export const JointPlates = memo(
  function JointPlates({ joints, layout }: { joints: readonly JointView[]; layout: RackLayout }) {
    return (
      <g aria-hidden="true" data-layer="joints">
        {joints.map((joint) => {
          const y = svgYOfSixths(layout, joint.ySixths)
          return (
            <rect
              key={joint.upperId}
              x={layout.bandX - 2}
              y={y - 2.4}
              width={layout.bandWidth + 4}
              height={4.8}
              rx={1.2}
              className="fill-rack-joint"
            />
          )
        })}
      </g>
    )
  },
  (previous, next) => previous.layout === next.layout && sameJoints(previous.joints, next.joints),
)

// ---------------------------------------------------------------------------------------------
// Section bands

export interface SectionBandProps {
  section: SectionView
  layout: RackLayout
  patterns: RackPatterns
  selected: boolean
  onActivate: (sectionId: string, event: MouseEvent | KeyboardEvent) => void
}

/** One section beside the rails: its type, Have/To get (icon, words, fill) and U range. */
export const SectionBand = memo(function SectionBand({
  section,
  layout,
  patterns,
  selected,
  onActivate,
}: SectionBandProps) {
  const top = svgYOfSixths(layout, section.endSixths)
  const bottom = svgYOfSixths(layout, section.startSixths)
  const box = {
    x: layout.bandX,
    y: top + 1,
    width: layout.bandWidth,
    height: Math.max(0, bottom - top - 2),
  }
  const have = section.have
  const Icon = have ? HaveIcon : NeedIcon
  const haveText = have ? HAVE_TEXT : NEED_TEXT
  const range = rangeText(section.uStart, section.uEnd)
  const x = box.x + 5
  const textWidth = box.width - 8
  // Centred in the band: the + handles sit on its top and bottom edges at any zoom.
  const blockTop = box.y + Math.max(2, (box.height - BAND_LABEL_BLOCK_MM) / 2)
  return (
    <g
      data-testid={`rack-section-band-${section.id}`}
      data-section-id={section.id}
      data-have={have}
      role="button"
      tabIndex={0}
      aria-label={sectionAriaLabel(section)}
      aria-pressed={selected}
      className="group cursor-pointer outline-none"
      onClick={(event) => onActivate(section.id, event)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onActivate(section.id, event)
      }}
    >
      <rect
        {...box}
        rx={3}
        strokeWidth={0.7}
        strokeDasharray={have ? undefined : '3 2'}
        className={
          have
            ? 'fill-have-soft stroke-have-border dark:fill-have-soft/60'
            : 'fill-background stroke-need-border'
        }
      />
      {have ? null : <rect {...box} rx={3} fill={`url(#${patterns.need})`} />}
      <g pointerEvents="none">
        <text
          x={x}
          y={blockTop + 7}
          fontSize={7}
          strokeWidth={2}
          strokeLinejoin="round"
          className={cn('fill-foreground font-semibold', HALO)}
        >
          {truncateToWidth(section.label, textWidth, 7) ?? ''}
        </text>
        <Icon
          aria-hidden="true"
          x={x}
          y={blockTop + 11}
          width={6.2}
          height={6.2}
          className={have ? 'text-have' : 'text-need'}
        />
        <text
          x={x + 8.5}
          y={blockTop + 16}
          fontSize={5.6}
          strokeWidth={1.7}
          strokeLinejoin="round"
          className={cn('fill-foreground', HALO)}
        >
          {haveText}
        </text>
        <text
          x={x}
          y={blockTop + 25}
          fontSize={5.2}
          strokeWidth={1.6}
          strokeLinejoin="round"
          className={cn('fill-muted-foreground tabular-nums', HALO)}
        >
          {range}
        </text>
      </g>
      {selected ? (
        <SelectionRing
          x={box.x + 1.4}
          y={box.y + 1.4}
          width={Math.max(0, box.width - 2.8)}
          height={Math.max(0, box.height - 2.8)}
          rx={2.4}
          strokeWidth={1.8}
        />
      ) : null}
      <rect
        x={box.x - 1.2}
        y={box.y - 1.2}
        width={box.width + 2.4}
        height={box.height + 2.4}
        rx={4}
        strokeWidth={1.1}
        strokeDasharray="3 1.5"
        className="fill-none stroke-foreground opacity-0 group-focus-visible:opacity-100"
      />
    </g>
  )
})
