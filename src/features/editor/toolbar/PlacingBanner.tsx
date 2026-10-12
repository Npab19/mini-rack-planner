import { MousePointerClick, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { deviceName, type CatalogLookup } from '@/domain/schema/catalog'
import type { Plan } from '@/domain/schema/plan'
import { usePlanLookup } from '@/state/derived'
import { usePlanStore } from '@/state/planStore'
import { useEditorState, type PlaceSource } from '../editorState'
import { PLACING_BANNER_ID } from '../layout/shellStore'
import { useCoarsePointer } from '../layout/useMediaQuery'
import { requestAddAtU, useAddAtUAvailable } from './addAtURequest'
import { useEditorActions } from './editorActions'

/**
 * What is being placed, in words: "Lenovo Tiny mount 1U", "Lenovo Tiny mount 1U for Lenovo
 * ThinkCentre M720q Tiny" (a tray device going into a mount), "DeskPi RackMate DC PDU Lite".
 * Unknown catalog ids fall back to the id.
 */
export function placingName(
  source: PlaceSource,
  lookup: CatalogLookup,
  equipment: Plan['equipment'] | undefined,
): string {
  if (source.kind === 'device') {
    const device = lookup.device(source.deviceId)
    return device === undefined ? source.deviceId : deviceName(device)
  }
  const itemName = lookup.item(source.itemId)?.name ?? source.itemId
  if (source.equipmentId === undefined) return itemName
  const entry = equipment?.find((candidate) => candidate.id === source.equipmentId)
  const device = entry === undefined ? undefined : lookup.device(entry.deviceId)
  return device === undefined ? itemName : `${itemName} for ${deviceName(device)}`
}

function PlacingBannerContent({ source }: { source: PlaceSource }) {
  const lookup = usePlanLookup()
  const equipment = usePlanStore((state) => state.plan?.equipment)
  const coarse = useCoarsePointer()
  const addAtU = useAddAtUAvailable()
  const actions = useEditorActions()
  const name = placingName(source, lookup, equipment)
  return (
    <div
      id={PLACING_BANNER_ID}
      data-testid="placing-banner"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-dashed border-info-border bg-info-soft px-3 py-1.5 text-sm"
    >
      <MousePointerClick aria-hidden className="size-4 shrink-0 text-info" />
      <p className="min-w-0 flex-1 basis-48">
        Placing <span className="font-semibold">{name}</span>
        {' – '}
        {coarse ? (
          'tap a free spot on the rack, or Cancel.'
        ) : (
          <>
            click a free spot on the rack, or press <Kbd>Esc</Kbd>.
            {/* A device from the tray goes in once; parts from the palette can go in a row. */}
            {source.equipmentId === undefined ? (
              <span className="text-muted-foreground">
                {' '}
                Hold <Kbd>Shift</Kbd> to place several.
              </span>
            ) : null}
          </>
        )}
      </p>
      <div className="flex shrink-0 flex-wrap gap-2">
        {addAtU ? (
          <Button size="sm" variant="outline" onClick={() => requestAddAtU()}>
            Add at U…
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => actions.cancelPlacing()}>
          <X aria-hidden />
          Cancel
        </Button>
      </div>
    </div>
  )
}

/**
 * "Placing <name> – click a free spot, or press Esc", with Add at U… (when the rack offers it)
 * and Cancel. Shown while something is being placed; the rack itself shows where the ghost would
 * land and whether it fits. One click places one part (and placing ends); Shift-click places
 * several in a row.
 */
export function PlacingBanner() {
  const placing = useEditorState((state) => state.placing)
  return placing === null ? null : <PlacingBannerContent source={placing} />
}
