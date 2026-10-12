import { useEffect } from 'react'
import { useLocation } from 'react-router'
import { useSettingsView } from '@/state/settingsStore'
import { AboutSection } from './AboutSection'
import { AppearanceSection } from './AppearanceSection'
import { BackupSection } from './BackupSection'
import { CostsSection } from './CostsSection'
import { DiagnosticsSection } from './DiagnosticsSection'
import { PrinterSection } from './PrinterSection'
import { StorageSection } from './StorageSection'

const SECTIONS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'costs', label: 'Costs & spares' },
  { id: 'printer', label: 'Printer' },
  { id: 'storage', label: 'Storage' },
  { id: 'backup', label: 'Backup' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'about', label: 'About' },
] as const

function decodeHash(hash: string): string | undefined {
  try {
    return decodeURIComponent(hash.slice(1))
  } catch {
    return undefined
  }
}

/**
 * Links such as /settings#storage (the "storage full" banner) arrive after this lazy route has
 * rendered, when the browser's own jump to the anchor has already failed: scroll to the section
 * here and move focus to its heading, so screen-reader and keyboard users land there too.
 */
function useScrollToHash(): void {
  const { hash } = useLocation()
  useEffect(() => {
    const id = hash.length > 1 ? decodeHash(hash) : undefined
    const section = id === undefined ? null : document.getElementById(id)
    if (section === null) return
    if (typeof section.scrollIntoView === 'function') section.scrollIntoView({ block: 'start' })
    document.getElementById(`${section.id}-heading`)?.focus({ preventScroll: true })
  }, [hash])
}

export function SettingsPage() {
  const { settings, loaded } = useSettingsView()
  useScrollToHash()

  return (
    <div className="mx-auto flex w-full max-w-screen-md flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Changes are saved in this browser as you make them.
        </p>
      </div>
      <nav aria-label="Settings sections">
        <ul className="flex flex-wrap gap-x-1 gap-y-1 text-sm">
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="inline-flex rounded-md px-2 py-1 text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <AppearanceSection />
      <CostsSection settings={settings} loaded={loaded} />
      <PrinterSection settings={settings} loaded={loaded} />
      <StorageSection />
      <BackupSection />
      <DiagnosticsSection />
      <AboutSection />
    </div>
  )
}
