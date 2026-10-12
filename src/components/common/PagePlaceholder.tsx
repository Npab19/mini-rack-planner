import { Hourglass } from 'lucide-react'
import type { ReactNode } from 'react'

/** Temporary page body for routes whose feature lands in a later milestone. */
export function PagePlaceholder({
  title,
  milestone,
  children,
}: {
  title: string
  milestone: string
  children?: ReactNode
}) {
  return (
    <div className="mx-auto flex w-full max-w-screen-lg flex-col gap-3 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
      <p className="flex items-center gap-2 self-start rounded-lg border border-info-border bg-info-soft px-3 py-2 text-sm">
        <Hourglass aria-hidden="true" className="size-4 shrink-0 text-info" />
        Arrives in {milestone}.
      </p>
    </div>
  )
}
