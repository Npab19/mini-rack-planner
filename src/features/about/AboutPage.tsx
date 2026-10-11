import { Link } from 'react-router'

export function AboutPage() {
  return (
    <div className="mx-auto flex w-full max-w-screen-md flex-col gap-4 p-6 text-sm leading-relaxed">
      <h1 className="text-2xl font-semibold tracking-tight">About</h1>
      <p>
        Mini Rack Planner helps you plan 3D-printed 10&quot; homelab racks: lay out your equipment,
        see it in 2D and 3D, and get a shopping list of prints, hardware and gear.
      </p>
      <p>
        Everything stays in your browser. The app never contacts MakerWorld or any other site; model
        files you add are read locally and never uploaded. Catalog entries link to each
        designer&apos;s page and store only facts such as part counts and hardware sizes.
      </p>
      <p>
        Something not working?{' '}
        <Link
          to="/settings#diagnostics"
          className="rounded-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Settings &gt; Diagnostics
        </Link>{' '}
        copies a report without your plan contents, or opens a prefilled GitHub issue.
      </p>
      <p className="text-muted-foreground">
        Version {__APP_VERSION__} ({__GIT_SHA__})
      </p>
    </div>
  )
}
