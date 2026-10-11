import { useLayoutEffect, useState } from 'react'

export interface ElementSize {
  width: number
  height: number
}

/**
 * The client (padding-box) size of an element, kept current with a ResizeObserver where the
 * browser has one. 0 × 0 until measured (and in test DOMs without layout).
 */
export function useElementSize(element: HTMLElement | null): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 })
  useLayoutEffect(() => {
    if (element === null) return
    const measure = (): void => {
      const width = element.clientWidth
      const height = element.clientHeight
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return size
}
