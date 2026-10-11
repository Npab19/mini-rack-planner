import { useEffect, useState, type RefObject } from 'react'

/** Spike-only probe: proves dnd-kit never writes to the SVG drawing during palette drags. */

function isDndMutation(target: Node, attributeName: string | null): boolean {
  if (!(target instanceof SVGElement) || !attributeName) return false
  if (attributeName.startsWith('data-dnd-') || attributeName === 'popover') return true
  return attributeName === 'style' && (target.getAttribute('style') ?? '').includes('--dnd-')
}

/** Counts dnd-kit writes to SVG nodes under `rootRef` (attributes, inline vars, placeholders). */
export function useSvgDndMutationCount(rootRef: RefObject<HTMLElement | null>): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let total = 0
    const observer = new MutationObserver((records) => {
      let found = 0
      for (const record of records) {
        if (record.type === 'attributes' && isDndMutation(record.target, record.attributeName)) {
          found += 1
        }
        for (const node of record.addedNodes) {
          if (node instanceof SVGElement && node.hasAttribute('data-dnd-placeholder')) found += 1
        }
      }
      if (found > 0) {
        total += found
        setCount(total)
      }
    })
    observer.observe(root, { subtree: true, childList: true, attributes: true })
    return () => observer.disconnect()
  }, [rootRef])
  return count
}
