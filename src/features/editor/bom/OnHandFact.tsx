/**
 * "On hand" on a hardware line of the bill of materials: how many of the line's part are on hand,
 * as a button that opens the On hand page's count field in a popover. A change is saved at once
 * and the list follows it live, because every BOM subtracts what is on hand; the popover links to
 * the On hand page. Colour repeats the number: some on hand shows in the In my rack tone.
 */
import { ArrowRight, Pencil } from 'lucide-react'
import { useRef } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { errorMessage } from '@/db/errors'
import type { BomLine } from '@/domain/api'
import { OnHandField } from '@/features/inventory/OnHandField'
import { quantityWithUnit } from '@/features/inventory/inventoryModel'
import { cn } from '@/lib/utils'
import { adjustInventory, setInventoryQty } from '@/state/inventoryStore'
import { announce } from '../layout/announcer'

export const ON_HAND_TEXT = 'On hand'

function failed(error: unknown): void {
  const text = `Could not update what you have on hand: ${errorMessage(error)}`
  announce(text)
  toast.error(text)
}

export function OnHandFact({ line, qty }: { line: BomLine; qty: number }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const said = (next: number) =>
    announce(`${line.label}: ${quantityWithUnit(next, line.unit)} on hand.`)

  async function set(next: number): Promise<boolean> {
    try {
      await setInventoryQty(line.key, next)
      said(next)
      return true
    } catch (error) {
      failed(error)
      return false
    }
  }

  function step(delta: number): void {
    adjustInventory(line.key, delta).then(said, failed)
  }

  return (
    <div className="flex items-center gap-1">
      <dt>{ON_HAND_TEXT}</dt>
      <dd>
        <Popover>
          <PopoverTrigger
            data-testid={`bom-on-hand-${line.key}`}
            aria-label={`${ON_HAND_TEXT}: ${qty}. Change it for ${line.label}`}
            className={cn(
              'inline-flex items-center gap-0.5 rounded-sm font-medium tabular-nums underline decoration-dotted underline-offset-2 outline-none hover:decoration-solid focus-visible:ring-3 focus-visible:ring-ring/50',
              qty > 0 ? 'text-have' : 'text-foreground',
            )}
          >
            {qty}
            <Pencil aria-hidden className="size-3 opacity-70" />
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-80 max-w-[calc(100vw-2rem)]"
            initialFocus={(type) => (type === 'touch' ? true : inputRef.current)}
          >
            <PopoverHeader>
              <PopoverTitle>{ON_HAND_TEXT}</PopoverTitle>
              <PopoverDescription className="text-foreground">{line.label}</PopoverDescription>
            </PopoverHeader>
            <OnHandField
              name={line.label}
              value={qty}
              unit={line.unit}
              inputRef={inputRef}
              testId={`bom-on-hand-qty-${line.key}`}
              className="items-start"
              onSet={set}
              onStep={step}
            />
            <p className="text-xs text-muted-foreground">
              Loose parts you own that are not in a rack. Every plan’s shopping list subtracts them
              before it buys anything.
            </p>
            <Link
              to="/inventory"
              className="inline-flex w-fit items-center gap-1 rounded-sm text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              All hardware on hand
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          </PopoverContent>
        </Popover>
      </dd>
    </div>
  )
}
