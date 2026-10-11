import { TriangleAlert } from 'lucide-react'
import { useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { sparePctFor, type Settings } from '@/domain/schema/settings'
import { saveSettings } from '@/state/settingsStore'
import { roundTo } from './format'
import { NumberField } from './NumberField'
import { SaveStatusText, SettingsSection } from './SettingsSection'
import { useCommitField } from './useCommitField'
import { useSaveStatus } from './useSaveStatus'

const LISTED_CURRENCIES = [
  { value: 'USD', label: 'USD · US dollar' },
  { value: 'EUR', label: 'EUR · Euro' },
  { value: 'GBP', label: 'GBP · British pound' },
  { value: 'CAD', label: 'CAD · Canadian dollar' },
  { value: 'AUD', label: 'AUD · Australian dollar' },
] as const
const OTHER = 'other'
const CURRENCY_ITEMS = [...LISTED_CURRENCIES, { value: OTHER, label: 'Other…' }]
const LISTED = new Set<string>(LISTED_CURRENCIES.map((currency) => currency.value))

/** Always shown; other materials already in the settings (e.g. from an import) follow them. */
export const FILAMENTS = ['PLA', 'PETG', 'ASA', 'ABS', 'TPU'] as const

/**
 * `default` covers every hardware category without its own value (washers, cage nuts, standoffs,
 * the catalog's "other" category, ...), so it is the "Other hardware" field.
 */
export const SPARE_CATEGORIES = [
  { key: 'screw', label: 'Screws' },
  { key: 'nut', label: 'Nuts' },
  { key: 'insert', label: 'Heat-set inserts' },
  { key: 'magnet', label: 'Magnets' },
  { key: 'default', label: 'Other hardware' },
] as const

type Patch = (current: Settings) => Partial<Settings>

/** A copy of `record` with `key` set to `value`, or without `key` when `value` is undefined. */
function withEntry<V>(record: Record<string, V>, key: string, value: V | undefined) {
  const next: Record<string, V> = Object.fromEntries(
    Object.entries(record).filter(([entryKey]) => entryKey !== key),
  )
  if (value !== undefined) next[key] = value
  return next
}

function fieldId(prefix: string, name: string): string {
  return `${prefix}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

function currencyName(code: string): string | undefined {
  try {
    const name = new Intl.DisplayNames(undefined, { type: 'currency' }).of(code)
    return name === undefined || name === code ? undefined : name
  } catch {
    return undefined
  }
}

const CODE_ERROR = 'Enter a three-letter currency code, like CHF or SEK.'

interface CurrencyFieldProps {
  currency: string
  disabled: boolean
  onSave: (code: string) => Promise<boolean>
}

/** The five common currencies in a list, plus "Other…" with a field for any ISO 4217 code. */
function CurrencyField({ currency, disabled, onSave }: CurrencyFieldProps) {
  const [otherChosen, setOtherChosen] = useState(false)
  const codeRef = useRef<HTMLInputElement>(null)
  const focusCodeOnClose = useRef(false)
  const listed = LISTED.has(currency)
  const showCode = otherChosen || !listed

  const code = useCommitField<string>({
    value: listed ? '' : currency,
    format: (value) => value,
    parse: (text) =>
      /^[A-Z]{3}$/.test(text) ? { ok: true, value: text } : { ok: false, message: CODE_ERROR },
    transform: (text) =>
      text
        .toUpperCase()
        .replace(/[^A-Z]/g, '')
        .slice(0, 3),
    onCommit: async (next) => {
      const saved = await onSave(next)
      // A listed code typed by hand: show it in the list again.
      if (saved && LISTED.has(next)) setOtherChosen(false)
      return saved
    },
  })
  const name = showCode && !listed ? currencyName(currency) : undefined

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="settings-currency">Currency</Label>
        <Select
          items={CURRENCY_ITEMS}
          value={showCode ? OTHER : currency}
          disabled={disabled}
          onValueChange={(next: string | null) => {
            if (next === OTHER) {
              setOtherChosen(true)
              focusCodeOnClose.current = true
            } else if (next !== null && LISTED.has(next)) {
              setOtherChosen(false)
              void onSave(next)
            }
          }}
          onOpenChangeComplete={(open) => {
            // The list hands focus back to its button as it closes; move on to the code field
            // only after that.
            if (open || !focusCodeOnClose.current) return
            focusCodeOnClose.current = false
            codeRef.current?.focus()
          }}
        >
          <SelectTrigger id="settings-currency" className="w-full sm:w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CURRENCY_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {showCode ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-currency-code">Currency code</Label>
          <Input
            ref={codeRef}
            id="settings-currency-code"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="done"
            placeholder="e.g. CHF"
            maxLength={3}
            disabled={disabled}
            aria-describedby={
              code.error === null ? 'settings-currency-code-hint' : 'settings-currency-code-error'
            }
            className="w-24"
            {...code.inputProps}
          />
          {code.error === null ? (
            <p id="settings-currency-code-hint" className="text-xs text-muted-foreground">
              {name ?? 'ISO 4217 code, as on your receipts.'}
            </p>
          ) : (
            <p
              id="settings-currency-code-error"
              role="alert"
              className="flex items-start gap-1 text-xs text-destructive"
            >
              <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              {code.error}
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}

export interface CostsSectionProps {
  settings: Settings
  /** False while the stored settings load: the fields wait instead of showing defaults. */
  loaded: boolean
}

/** Currency, filament prices and spare percentages: the BOM's cost estimate and spare lines. */
export function CostsSection({ settings, loaded }: CostsSectionProps) {
  const status = useSaveStatus()
  const save = (patch: Patch): Promise<boolean> => status.track(() => saveSettings(patch))
  const materials = [
    ...FILAMENTS,
    ...Object.keys(settings.filamentCostPerKg)
      .filter((material) => !(FILAMENTS as readonly string[]).includes(material))
      .toSorted(),
  ]

  return (
    <SettingsSection
      id="costs"
      title="Costs & spares"
      description="Used for the shopping list's cost estimate and its spare hardware."
      status={<SaveStatusText state={status.state} />}
    >
      <CurrencyField
        currency={settings.currency}
        disabled={!loaded}
        onSave={(currency) => save(() => ({ currency }))}
      />

      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-1 text-sm font-medium">Filament price per kg</legend>
        <p className="text-xs text-muted-foreground">
          Leave a material empty if you do not know its price; costs then leave it out.
        </p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          {materials.map((material) => (
            <NumberField
              key={material}
              id={fieldId('filament', material)}
              label={material}
              value={settings.filamentCostPerKg[material]}
              unit={`${settings.currency}/kg`}
              optional
              placeholder="Not set"
              max={100_000}
              disabled={!loaded}
              onCommit={(price) =>
                save((current) => ({
                  filamentCostPerKg: withEntry(current.filamentCostPerKg, material, price),
                }))
              }
            />
          ))}
        </div>
      </fieldset>

      <fieldset className="flex min-w-0 flex-col gap-3" aria-describedby="spares-help">
        <legend className="mb-1 text-sm font-medium">Spare hardware</legend>
        <p id="spares-help" className="text-xs text-muted-foreground">
          Added on top of what you need, only when you buy. For example, 10% on 36 inserts adds 4.
        </p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          {SPARE_CATEGORIES.map(({ key, label }) => (
            <NumberField
              key={key}
              id={fieldId('spare', key)}
              label={label}
              value={roundTo(sparePctFor(settings, key) * 100, 1)}
              unit="%"
              max={100}
              decimals={1}
              requiredMessage="Enter a percentage, or 0 for no spares."
              rangeMessage="Enter a percentage from 0 to 100."
              disabled={!loaded}
              onCommit={(percent) =>
                save((current) => {
                  const fraction = percent === undefined ? undefined : roundTo(percent / 100, 4)
                  let sparePct = withEntry(current.sparePct, key, fraction)
                  // An explicit "other" entry would shadow the default for that one category.
                  if (key === 'default') sparePct = withEntry(sparePct, 'other', undefined)
                  return { sparePct }
                })
              }
            />
          ))}
        </div>
      </fieldset>
    </SettingsSection>
  )
}
