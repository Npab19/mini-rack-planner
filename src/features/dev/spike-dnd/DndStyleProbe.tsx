import { useDragDropMonitor } from '@dnd-kit/react'
import { useMemo, useRef } from 'react'

/**
 * Spike-only probe: records how dnd-kit's injected styles cascade, so
 * scripts/spikes/dnd-check.ts can read it from data attributes without DOM types.
 */

export interface StyleProbe {
  /** dnd-kit prepends its <style> to <head>, so its `@layer dnd-kit` is declared first (lowest). */
  styleFirst: boolean
  /** `visible` means dnd-kit's layered reset beat the UA `[popover]` style (overflow: auto). */
  overlayOverflow: string
  /** The overlay carries `p-0.5`; `2px` means Tailwind utilities beat `@layer dnd-kit`. */
  overlayPaddingTop: string
  overlayInTopLayer: boolean
}

function isPopoverOpen(element: Element): boolean {
  try {
    return element.matches(':popover-open')
  } catch {
    return false
  }
}

export function probeDndStyles(): StyleProbe {
  const first = document.head.firstElementChild
  const overlay = document.querySelector('[data-dnd-overlay]')
  const styles = overlay ? getComputedStyle(overlay) : null
  return {
    styleFirst:
      first instanceof HTMLStyleElement && (first.textContent ?? '').includes('@layer dnd-kit'),
    overlayOverflow: styles?.overflow ?? '',
    overlayPaddingTop: styles?.paddingTop ?? '',
    overlayInTopLayer: overlay ? isPopoverOpen(overlay) : false,
  }
}

/** Probes the injected styles once per palette drag, a frame after the first move. */
export function DndStyleProbe({ onProbe }: { onProbe: (probe: StyleProbe) => void }) {
  const probedRef = useRef(false)
  const handlers = useMemo(
    () => ({
      onDragStart: () => {
        probedRef.current = false
      },
      onDragMove: () => {
        if (probedRef.current) return
        probedRef.current = true
        requestAnimationFrame(() => onProbe(probeDndStyles()))
      },
    }),
    [onProbe],
  )
  useDragDropMonitor(handlers)
  return null
}
