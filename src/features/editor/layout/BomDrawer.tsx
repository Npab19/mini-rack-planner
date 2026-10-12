import { ChevronUp } from 'lucide-react'
import { useId } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/state/uiStore'
import { PANEL_SLOTS } from './panels'
import { panelDomId } from './shellStore'

const BomSlot = PANEL_SLOTS.bom

/**
 * Desktop: the bill of materials as a drawer along the bottom. Collapsed it is a header bar; the
 * open state is remembered in `uiStore.panels.bom` (B toggles it too). The BomPanel inside owns
 * its content (views, totals, exports); it is mounted only while the drawer is open.
 */
export function BomDrawer() {
  const open = useUiStore((state) => state.panels.bom)
  const bodyId = useId()
  return (
    <div
      id={panelDomId('bom')}
      data-testid="panel-bom"
      className={cn(
        'flex shrink-0 flex-col border-t bg-background',
        open && 'h-[min(45dvh,32rem)]',
      )}
    >
      <h2 className="shrink-0">
        <button
          type="button"
          data-panel-focus=""
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={() => useUiStore.getState().togglePanel('bom')}
          className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm font-medium outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          <ChevronUp
            aria-hidden
            className={cn(
              'size-4 shrink-0 text-primary transition-transform motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
          Bill of materials
          <span
            aria-hidden
            className="ml-auto flex items-center gap-1.5 text-xs font-normal text-muted-foreground"
          >
            {open ? 'Hide' : 'Show'}
            <Kbd>B</Kbd>
          </span>
        </button>
      </h2>
      {open ? (
        <div
          id={bodyId}
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain border-t"
        >
          <BomSlot />
        </div>
      ) : null}
    </div>
  )
}
