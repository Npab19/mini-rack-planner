/**
 * Facts about a catalog entry, shared by the palette and the inspector: designer and licence as
 * the source page shows them, the "Open page" link (a plain link: the app never fetches it), and
 * how the entry was verified. Unverified entries carry an icon + text badge in the warning tone
 * (measure first); checked ones a check icon in the In my rack green.
 */
import { ExternalLink, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import type { Source, Verified, VerifyMethod } from '@/domain/schema/common'
import { cn } from '@/lib/utils'

const METHOD_TEXT: Record<Exclude<VerifyMethod, 'unverified'>, string> = {
  page: 'from the source page',
  'user-files': 'from the downloaded files',
  calipers: 'measured with calipers',
  'vendor-spec': 'from the maker’s specifications',
}

export function isUnverified(verified: Verified | undefined): boolean {
  return verified?.method === 'unverified'
}

/** "Checked from the source page by … on 2026-10-11", or "Not verified yet". */
export function verifiedText(verified: Verified): string {
  if (verified.method === 'unverified') return 'Not verified yet'
  return `Checked ${METHOD_TEXT[verified.method]} by ${verified.by} on ${verified.date}`
}

export function UnverifiedBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="warning"
      className={cn('border-dashed', className)}
      title="Sizes, holes or prints are not checked yet: measure before you print."
    >
      <ShieldQuestion aria-hidden />
      Unverified
    </Badge>
  )
}

const LINK_CLASS =
  'inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50'

/**
 * "Open page" for an entry's source. The icon-only form (palette rows) names the entry in its
 * accessible name; both say that the page opens in a new tab.
 */
export function OpenPageLink({
  url,
  name,
  iconOnly = false,
  tabIndex,
  className,
}: {
  url: string
  name: string
  iconOnly?: boolean
  tabIndex?: number
  className?: string
}) {
  if (iconOnly) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        tabIndex={tabIndex}
        aria-label={`Open page: ${name} (opens in a new tab)`}
        title="Open page (new tab)"
        className={cn(
          'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
          className,
        )}
      >
        <ExternalLink aria-hidden className="size-4" />
      </a>
    )
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      tabIndex={tabIndex}
      className={cn(LINK_CLASS, className)}
    >
      Open page
      <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only"> for {name} (opens in a new tab)</span>
    </a>
  )
}

export interface Fact {
  label: string
  value: ReactNode
}

/** Label/value pairs in two columns (wraps long values; fine at 360 px). */
export function FactList({ facts, className }: { facts: readonly Fact[]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm', className)}>
      {facts.map((fact) => (
        <Fragment key={fact.label}>
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="min-w-0 break-words">{fact.value}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

/** Designer and licence facts from a source, when it names them. */
export function sourceFacts(source: Source | undefined): Fact[] {
  const facts: Fact[] = []
  if (source?.designer !== undefined) facts.push({ label: 'Designer', value: source.designer })
  if (source?.license !== undefined) facts.push({ label: 'Licence', value: source.license })
  return facts
}

/** How the entry was checked, with the curator's note (folded: notes can be long). */
export function VerifiedFact({ verified }: { verified: Verified }) {
  return (
    <span className="grid gap-0.5">
      {isUnverified(verified) ? (
        <span>
          <UnverifiedBadge />
        </span>
      ) : (
        <span>
          <ShieldCheck aria-hidden className="mr-1 mb-0.5 inline size-3.5 text-have" />
          {verifiedText(verified)}
        </span>
      )}
      {verified.note === undefined ? null : (
        <details className="text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            Curator’s note
          </summary>
          <span className="mt-0.5 block">{verified.note}</span>
        </details>
      )}
    </span>
  )
}
