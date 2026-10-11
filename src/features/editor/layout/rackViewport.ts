import { createContext, useContext } from 'react'

/**
 * The rack's scroll container, provided by the shell: it fills the space between the panels and
 * scrolls when the zoomed rack is larger. RackView can read its size to fit the rack (see
 * `useFitRequest` in toolbar/fitRequest.ts) or keep a spot in view. Null until it is mounted.
 */
export const RackViewportContext = createContext<HTMLDivElement | null>(null)

export function useRackViewport(): HTMLDivElement | null {
  return useContext(RackViewportContext)
}
