import { Laptop, Moon, Sun, type LucideIcon } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  ACCENTS,
  isAccentPreference,
  resolveTheme,
  useAccent,
  useTheme,
  type AccentPreference,
  type ThemePreference,
} from '@/lib/theme'
import { cn } from '@/lib/utils'
import { SaveStatusText, SettingsSection } from './SettingsSection'
import { useSaveStatus } from './useSaveStatus'

const THEMES: ReadonlyArray<{ value: ThemePreference; label: string; icon: LucideIcon }> = [
  { value: 'system', label: 'System', icon: Laptop },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

/** Each accent's primary colour in the light and dark theme (the values in src/index.css). */
const SWATCHES: Record<AccentPreference, string> = {
  indigo: 'bg-indigo-600 dark:bg-indigo-400',
  blue: 'bg-blue-600 dark:bg-blue-400',
  teal: 'bg-teal-700 dark:bg-teal-400',
  green: 'bg-green-700 dark:bg-green-400',
  orange: 'bg-orange-700 dark:bg-orange-400',
  rose: 'bg-rose-600 dark:bg-rose-400',
  graphite: 'bg-slate-900 dark:bg-slate-100',
}

// The whole tile is the label: a large target, and the checked dot (not just the border colour)
// shows the choice.
const TILE =
  'cursor-pointer rounded-lg border p-3 font-normal hover:bg-accent/60 has-data-checked:border-primary has-data-checked:bg-accent has-data-checked:text-accent-foreground'

function isThemePreference(value: unknown): value is ThemePreference {
  return THEMES.some((theme) => theme.value === value)
}

/**
 * Theme (System / Light / Dark) and accent colour. Both are stored per browser in localStorage by
 * src/lib/theme.ts.
 */
export function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const { accent, setAccent } = useAccent()
  const status = useSaveStatus()
  // The device's own preference, whatever this app is set to.
  const deviceTheme = resolveTheme('system')
  const labelId = 'appearance-theme-label'
  const hintId = 'appearance-theme-hint'
  const accentLabelId = 'appearance-accent-label'
  const accentHintId = 'appearance-accent-hint'

  return (
    <SettingsSection
      id="appearance"
      title="Appearance"
      status={<SaveStatusText state={status.state} />}
    >
      <div className="flex flex-col gap-2">
        <p id={labelId} className="text-sm font-medium">
          Theme
        </p>
        <RadioGroup
          aria-labelledby={labelId}
          aria-describedby={hintId}
          value={theme}
          onValueChange={(next: unknown) => {
            if (!isThemePreference(next)) return
            setTheme(next)
            status.markSaved()
          }}
          className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-3"
        >
          {THEMES.map(({ value, label, icon: Icon }) => (
            <Label key={value} className={TILE}>
              <RadioGroupItem value={value} />
              <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
              {label}
            </Label>
          ))}
        </RadioGroup>
        <p id={hintId} className="text-xs text-muted-foreground">
          System follows your device&apos;s setting (currently {deviceTheme}). Kept in this browser
          only.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <p id={accentLabelId} className="text-sm font-medium">
          Accent colour
        </p>
        <RadioGroup
          aria-labelledby={accentLabelId}
          aria-describedby={accentHintId}
          value={accent}
          onValueChange={(next: unknown) => {
            if (!isAccentPreference(next)) return
            setAccent(next)
            status.markSaved()
          }}
          className="grid grid-cols-2 gap-2 min-[400px]:grid-cols-4"
        >
          {ACCENTS.map(({ id, label }) => (
            <Label key={id} className={TILE}>
              <RadioGroupItem value={id} />
              <span
                aria-hidden="true"
                className={cn('size-4 shrink-0 rounded-full', SWATCHES[id])}
              />
              {label}
            </Label>
          ))}
        </RadioGroup>
        <p id={accentHintId} className="text-xs text-muted-foreground">
          Colours buttons, links, selections and focus rings. Kept in this browser only.
        </p>
      </div>
    </SettingsSection>
  )
}
