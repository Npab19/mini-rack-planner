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
      <p className="text-sm text-muted-foreground">Arrives in {milestone}.</p>
    </div>
  )
}
