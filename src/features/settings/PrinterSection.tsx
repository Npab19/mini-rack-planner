import { Eraser } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { Settings } from '@/domain/schema/settings'
import { saveSettings } from '@/state/settingsStore'
import { formatDecimal } from './format'
import { NumberField } from './NumberField'
import { SaveStatusText, SettingsSection } from './SettingsSection'
import { useSaveStatus } from './useSaveStatus'

type Axis = 'x' | 'y' | 'z'
type BedDraft = Partial<Record<Axis, number>>
type Bed = NonNullable<Settings['printerBedMm']>

const AXES: ReadonlyArray<{ axis: Axis; label: string }> = [
  { axis: 'x', label: 'Width (X)' },
  { axis: 'y', label: 'Depth (Y)' },
  { axis: 'z', label: 'Height (Z)' },
]

/** Largest bed size accepted (mm): well beyond any desktop printer, catches typos. */
const MAX_BED_MM = 2000

function completeBed(draft: BedDraft): Bed | undefined {
  const { x, y, z } = draft
  return x === undefined || y === undefined || z === undefined ? undefined : { x, y, z }
}

function isEmpty(draft: BedDraft): boolean {
  return AXES.every(({ axis }) => draft[axis] === undefined)
}

function sameBed(a: BedDraft | undefined, b: BedDraft | undefined): boolean {
  return AXES.every(({ axis }) => a?.[axis] === b?.[axis])
}

export interface PrinterSectionProps {
  settings: Settings
  loaded: boolean
}

/**
 * The printer's bed size, for the bed-fit warning. All three sizes or none: a partly filled bed
 * stays a local draft until the last size is in.
 */
export function PrinterSection({ settings, loaded }: PrinterSectionProps) {
  const status = useSaveStatus()
  const stored = settings.printerBedMm
  const [draft, setDraft] = useState<BedDraft>(() => ({ ...stored }))
  const [shown, setShown] = useState(stored)
  const firstFieldRef = useRef<HTMLDivElement>(null)

  if (!sameBed(shown, stored)) {
    // Saved here, in another tab or by an import: the stored bed wins over any draft.
    setShown(stored)
    setDraft({ ...stored })
  }

  const saveBed = (bed: Bed | undefined): Promise<boolean> =>
    status.track(() => saveSettings({ printerBedMm: bed }))

  async function commitAxis(axis: Axis, value: number | undefined): Promise<boolean> {
    const next = { ...draft, [axis]: value }
    setDraft(next)
    const bed = completeBed(next)
    if (bed !== undefined) return saveBed(bed)
    if (isEmpty(next) && stored !== undefined) return saveBed(undefined)
    // Partly filled: wait for the other sizes.
    return true
  }

  function clear(): void {
    setDraft({})
    // The button disappears with the draft: keep focus in the section.
    firstFieldRef.current?.querySelector('input')?.focus()
    if (stored !== undefined) void saveBed(undefined)
  }

  const partial = !isEmpty(draft) && completeBed(draft) === undefined
  const size = (bed: BedDraft): string =>
    AXES.map(({ axis }) => formatDecimal(bed[axis], 1)).join(' × ')
  let summary: string
  if (partial) {
    summary =
      stored === undefined
        ? 'Enter all three sizes to turn on the bed-fit warning.'
        : `Enter all three sizes to save the change; until then ${size(stored)} mm is used.`
  } else {
    summary =
      stored === undefined
        ? 'No bed size: the bed-fit warning is off.'
        : `Parts larger than ${size(stored)} mm get a warning.`
  }

  return (
    <SettingsSection
      id="printer"
      title="Printer"
      description="Your printer's bed size, so parts too big to print get a warning. Optional."
      status={<SaveStatusText state={status.state} />}
    >
      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-1 text-sm font-medium">Bed size</legend>
        <div className="grid grid-cols-3 gap-x-3 gap-y-3">
          {AXES.map(({ axis, label }, index) => (
            <div key={axis} ref={index === 0 ? firstFieldRef : undefined}>
              <NumberField
                id={`printer-bed-${axis}`}
                label={label}
                value={draft[axis]}
                unit="mm"
                optional
                min={1}
                max={MAX_BED_MM}
                decimals={1}
                rangeMessage={`Enter a size from 1 to ${MAX_BED_MM} mm.`}
                disabled={!loaded}
                onCommit={(value) => commitAxis(axis, value)}
              />
            </div>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
        <p role="status" className="min-w-0 flex-1">
          {summary}
        </p>
        {isEmpty(draft) ? null : (
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            <Eraser aria-hidden="true" />
            Clear bed size
          </Button>
        )}
      </div>
    </SettingsSection>
  )
}
