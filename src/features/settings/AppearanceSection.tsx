import { Laptop, Moon, Sun, type LucideIcon } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { resolveTheme, useTheme, type ThemePreference } from '@/lib/theme'
import { SaveStatusText, SettingsSection } from './SettingsSection'
import { useSaveStatus } from './useSaveStatus'

const THEMES: ReadonlyArray<{ value: ThemePreference; label: string; icon: LucideIcon }> = [
  { value: 'system', label: 'System', icon: Laptop },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

function isThemePreference(value: unknown): value is ThemePreference {
  return THEMES.some((theme) => theme.value === value)
}

/** Theme: System / Light / Dark. Stored per browser in localStorage by src/lib/theme.ts. */
export function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const status = useSaveStatus()
  // The device's own preference, whatever this app is set to.
  const deviceTheme = resolveTheme('system')
  const labelId = 'appearance-theme-label'
  const hintId = 'appearance-theme-hint'

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
            // The whole tile is the label: a large target, and the checked dot (not just the
            // border colour) shows the choice.
            <Label
              key={value}
              className="cursor-pointer rounded-lg border p-3 font-normal has-data-checked:border-primary has-data-checked:bg-muted/60"
            >
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
    </SettingsSection>
  )
}
