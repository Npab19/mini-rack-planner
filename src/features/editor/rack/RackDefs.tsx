/**
 * Shared SVG patterns of the rack drawing. Ids are unique per rack view (several views can be on
 * one page, e.g. compare), and every fill that carries meaning also has a non-colour cue.
 */
import { useId, useMemo } from 'react'

export interface RackPatterns {
  /** "To get": amber diagonal hatch (with a dashed outline and a text tag on the shape). */
  need: string
  /** An invalid ghost: a denser cross-hatch. */
  invalid: string
  /** Vent slots. */
  vent: string
  /** A joint's dead zone. */
  dead: string
}

/** Pattern ids for one rack view; the object is stable, so memoized shapes keep their props. */
export function useRackPatterns(): RackPatterns {
  // useId output is not a valid URL fragment as is.
  const base = `rack-${useId().replace(/[^\w-]/g, '')}`
  return useMemo(
    () => ({
      need: `${base}-need`,
      invalid: `${base}-invalid`,
      vent: `${base}-vent`,
      dead: `${base}-dead`,
    }),
    [base],
  )
}

export function RackDefs({ patterns }: { patterns: RackPatterns }) {
  return (
    <defs>
      <pattern
        id={patterns.need}
        width={4}
        height={4}
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <line
          x1={0}
          y1={0}
          x2={0}
          y2={4}
          strokeWidth={1.1}
          className="stroke-need-border/50 dark:stroke-need-border/35"
        />
      </pattern>
      <pattern
        id={patterns.invalid}
        width={3.2}
        height={3.2}
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(-45)"
      >
        <rect width={3.2} height={3.2} className="fill-destructive/10" />
        <line x1={0} y1={0} x2={0} y2={3.2} strokeWidth={1} className="stroke-destructive/60" />
      </pattern>
      <pattern id={patterns.vent} width={13} height={5.5} patternUnits="userSpaceOnUse">
        <rect x={1.5} y={1.75} width={10} height={2} rx={1} className="fill-foreground/25" />
      </pattern>
      <pattern
        id={patterns.dead}
        width={3}
        height={3}
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <line
          x1={0}
          y1={0}
          x2={0}
          y2={3}
          strokeWidth={0.8}
          className="stroke-muted-foreground/60"
        />
      </pattern>
    </defs>
  )
}

/**
 * The selection ring of a shape: a primary stroke over a wider background-coloured halo, so it
 * stands out on every part colour (the dashed keyboard focus ring stays a foreground colour).
 */
export function SelectionRing({
  strokeWidth,
  ...box
}: {
  x: number
  y: number
  width: number
  height: number
  rx: number
  strokeWidth: number
}) {
  return (
    <>
      <rect
        {...box}
        strokeWidth={strokeWidth * 2.2}
        strokeLinejoin="round"
        className="fill-none stroke-background"
        aria-hidden="true"
      />
      <rect
        {...box}
        strokeWidth={strokeWidth}
        className="fill-none stroke-primary"
        data-selection-ring=""
      />
    </>
  )
}
