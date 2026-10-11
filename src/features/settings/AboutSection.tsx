import { Info } from 'lucide-react'
import { Link } from 'react-router'
import { buttonVariants } from '@/components/ui/button'
import { SettingsSection } from './SettingsSection'

/** The running version and build, as bug reports need them. */
export function AboutSection() {
  return (
    <SettingsSection id="about" title="About">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        <dt className="font-medium">Version</dt>
        <dd>{__APP_VERSION__}</dd>
        <dt className="font-medium">Build</dt>
        <dd>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
            {__GIT_SHA__}
          </code>
        </dd>
      </dl>
      <div>
        <Link to="/about" className={buttonVariants({ variant: 'outline' })}>
          <Info aria-hidden="true" />
          About Mini Rack Planner
        </Link>
      </div>
    </SettingsSection>
  )
}
