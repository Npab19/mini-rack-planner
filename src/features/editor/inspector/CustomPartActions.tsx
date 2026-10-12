/**
 * Ways into the user's own parts, for places where the catalog has nothing to offer (the palette's
 * no-results state and its My parts tab): "Add a part from a link or file" starts the Add a part
 * wizard and "Create a custom part" the custom part editor, both through `useAddPart` (whoever
 * renders them listens there). The search text names the new part; a pasted link (http or https)
 * starts the wizard from that link instead. The app never opens or fetches the link itself.
 * They are outlined (the row's own Place stays the main action), with icons in the primary colour.
 */
import { FileUp, PencilRuler } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { CustomDeviceInput, CustomItemInput } from '@/domain/customParts'
import { useAddPart, type AddPartRequest, type AddPartTarget } from '@/features/custom/addPartStore'
import { cn } from '@/lib/utils'

export interface CustomPartActionsProps {
  /** What "Create a custom part" makes: a mount, panel or shelf (default) or a device. */
  kind?: 'item' | 'device'
  /** The palette's search text: names the new part, or is the link to start the wizard from. */
  query?: string
  /** Also add the saved part to the open plan (default true: these buttons live in the editor). */
  addToOpenPlan?: boolean
  /** Start placing the new part once it is saved (default false). */
  placeAfterSave?: boolean
  /** Buttons side by side, wrapping (default), or stacked full width. */
  layout?: 'row' | 'stack'
  /** Disabled, e.g. on a read-only plan. */
  disabled?: boolean
  className?: string
}

/** The query when it is a web link: "https://makerworld.com/en/models/…". */
export function linkInQuery(query: string | undefined): string | undefined {
  const text = query?.trim() ?? ''
  return /^https?:\/\/\S+$/i.test(text) ? text : undefined
}

/** What the two buttons ask `useAddPart` to open. */
export function customPartRequests({
  kind = 'item',
  query,
  addToOpenPlan = true,
  placeAfterSave = false,
}: Pick<CustomPartActionsProps, 'kind' | 'query' | 'addToOpenPlan' | 'placeAfterSave'>): {
  fromLink: AddPartRequest & AddPartTarget
  create: AddPartRequest & AddPartTarget
} {
  const target: AddPartTarget = { addToOpenPlan, placeAfterSave }
  const url = linkInQuery(query)
  const name = url === undefined ? (query?.trim() ?? '') : ''
  const create: AddPartRequest & AddPartTarget =
    kind === 'device'
      ? {
          kind: 'device',
          ...(name === '' ? {} : { prefill: { model: name } satisfies Partial<CustomDeviceInput> }),
          ...target,
        }
      : {
          kind: 'item',
          ...(name === '' ? {} : { prefill: { name } satisfies Partial<CustomItemInput> }),
          ...target,
        }
  return { fromLink: { kind: 'wizard', ...(url === undefined ? {} : { url }), ...target }, create }
}

export function CustomPartActions({
  layout = 'row',
  disabled = false,
  className,
  ...request
}: CustomPartActionsProps) {
  const requests = customPartRequests(request)
  return (
    <div
      role="group"
      aria-label="Add your own part"
      className={cn(layout === 'stack' ? 'grid gap-1.5' : 'flex flex-wrap gap-1.5', className)}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        data-testid="custom-part-from-link"
        className={cn(layout === 'stack' && 'justify-start')}
        onClick={() => useAddPart.getState().open(requests.fromLink)}
      >
        <FileUp aria-hidden className="text-primary" />
        Add a part from a link or file
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        data-testid="custom-part-create"
        className={cn(layout === 'stack' && 'justify-start')}
        onClick={() => useAddPart.getState().open(requests.create)}
      >
        <PencilRuler aria-hidden className="text-primary" />
        Create a custom part
      </Button>
    </div>
  )
}
