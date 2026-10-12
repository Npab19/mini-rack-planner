import {
  Check,
  Coins,
  DatabaseBackup,
  HardDrive,
  Info,
  Palette,
  Printer,
  Stethoscope,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import type { SaveState } from './useSaveStatus'

export interface SettingsSectionProps {
  /** The anchor (`/settings#storage`); the heading gets `<id>-heading`. */
  id: string
  title: string
  description?: ReactNode
  /** Right side of the header, e.g. `<SaveStatusText />`. */
  status?: ReactNode
  children: ReactNode
}

/** Each section's header icon, by its anchor id: decoration next to the title. */
const SECTION_ICONS: Readonly<Record<string, LucideIcon>> = {
  appearance: Palette,
  costs: Coins,
  printer: Printer,
  storage: HardDrive,
  backup: DatabaseBackup,
  diagnostics: Stethoscope,
  about: Info,
}

/** One settings card: a named region with an h2 that hash links focus (see SettingsPage). */
export function SettingsSection({
  id,
  title,
  description,
  status,
  children,
}: SettingsSectionProps) {
  const headingId = `${id}-heading`
  const Icon = SECTION_ICONS[id]
  // scroll-mt clears the sticky app header when the browser scrolls to the anchor.
  return (
    <section id={id} aria-labelledby={headingId} className="scroll-mt-16">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {Icon === undefined ? null : (
              <span
                aria-hidden="true"
                className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-primary"
              >
                <Icon className="size-4" />
              </span>
            )}
            <h2 id={headingId} tabIndex={-1} className="outline-none">
              {title}
            </h2>
          </CardTitle>
          {description === undefined ? null : <CardDescription>{description}</CardDescription>}
          {status === undefined ? null : <CardAction>{status}</CardAction>}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
    </section>
  )
}

/**
 * "Saved" / "Not saved" next to a section title. Always rendered, so the live region exists
 * before its text changes (screen readers announce changes, not regions that appear). Saving
 * itself is not announced: it takes milliseconds and would double every announcement.
 */
export function SaveStatusText({ state }: { state: SaveState }) {
  return (
    <p role="status" className="flex min-h-5 items-center gap-1 text-xs text-muted-foreground">
      {state.kind === 'saved' ? (
        <>
          <Check aria-hidden="true" className="size-3.5 text-have" />
          Saved
        </>
      ) : null}
      {state.kind === 'error' ? (
        <>
          <TriangleAlert aria-hidden="true" className="size-3.5 text-destructive" />
          <span className="text-destructive">Not saved</span>
          <span className="sr-only">: {state.message}</span>
        </>
      ) : null}
    </p>
  )
}
