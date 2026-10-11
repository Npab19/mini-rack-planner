import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, LocateFixed } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { isViewMode, isZoom, PAN_STEP_PX, VIEW_MODES, ZOOMS, type RackView } from './useRackView'

const MODE_LABEL = { viewbox: 'viewBox', css: 'CSS transform' } as const

/** Pan buttons move the view (the drawing moves the other way), like scrolling. */
const PAN_BUTTONS = [
  { id: 'left', label: 'Pan left', Icon: ArrowLeft, dx: PAN_STEP_PX, dy: 0 },
  { id: 'up', label: 'Pan up', Icon: ArrowUp, dx: 0, dy: PAN_STEP_PX },
  { id: 'down', label: 'Pan down', Icon: ArrowDown, dx: 0, dy: -PAN_STEP_PX },
  { id: 'right', label: 'Pan right', Icon: ArrowRight, dx: -PAN_STEP_PX, dy: 0 },
] as const

export function ViewToolbar({ view }: { view: RackView }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" role="toolbar" aria-label="View">
      <ToggleGroup
        aria-label="Zoom"
        variant="outline"
        size="sm"
        spacing={0}
        value={[String(view.zoom)]}
        onValueChange={(values) => {
          const zoom = Number(values[0])
          if (isZoom(zoom)) view.setZoom(zoom)
        }}
      >
        {ZOOMS.map((zoom) => (
          <ToggleGroupItem key={zoom} value={String(zoom)} data-testid={`zoom-${zoom}`}>
            {zoom}%
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <div className="flex items-center gap-1">
        {PAN_BUTTONS.map(({ id, label, Icon, dx, dy }) => (
          <Button
            key={id}
            variant="outline"
            size="icon-sm"
            aria-label={label}
            data-testid={`pan-${id}`}
            onClick={() => view.panBy(dx, dy)}
          >
            <Icon />
          </Button>
        ))}
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Centre the rack"
          data-testid="pan-reset"
          onClick={view.reset}
        >
          <LocateFixed />
        </Button>
      </div>

      <ToggleGroup
        aria-label="Zoom and pan technique"
        variant="outline"
        size="sm"
        spacing={0}
        value={[view.mode]}
        onValueChange={(values) => {
          const mode = values[0]
          if (isViewMode(mode)) view.setMode(mode)
        }}
      >
        {VIEW_MODES.map((mode) => (
          <ToggleGroupItem key={mode} value={mode} data-testid={`mode-${mode}`}>
            {MODE_LABEL[mode]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}
