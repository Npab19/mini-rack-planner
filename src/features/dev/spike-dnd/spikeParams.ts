import type { Placement } from './rackModel'
import type { SvgProbeMode } from './SvgDraggableProbe'
import { isViewMode, isZoom, type ViewMode, type Zoom } from './useRackView'

/** URL parameters of /dev/spike-dnd, so the check script can start each scenario cleanly. */
export interface SpikeParams {
  mode: ViewMode
  zoom: Zoom
  seed: 'default' | 'empty'
  probe: SvgProbeMode | null
}

/** Obstacles for the scenarios: a 1U panel at U8 and a ½U mount in the lower half of U1. */
export const SEED_PLACEMENTS: readonly Placement[] = [
  { id: 'seed-patch', kind: '1u', y: 42 },
  { id: 'seed-pi', kind: 'half', y: 0 },
]

export function readSpikeParams(search: URLSearchParams): SpikeParams {
  const mode = search.get('mode')
  const zoom = Number(search.get('zoom') ?? '100')
  const probe = search.get('probe')
  return {
    mode: isViewMode(mode) ? mode : 'viewbox',
    zoom: isZoom(zoom) ? zoom : 100,
    seed: search.get('seed') === 'empty' ? 'empty' : 'default',
    probe: probe === 'svg-default' ? 'default' : probe === 'svg-guarded' ? 'guarded' : null,
  }
}
