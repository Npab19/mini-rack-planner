import { Copy, CopyPlus, Download, Ellipsis, FolderOpen, Lock, Pencil, Trash2 } from 'lucide-react'
import { useId } from 'react'
import { Link, useNavigate } from 'react-router'
import { HaveNeedBadge } from '@/components/common/HaveNeed'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { PlanSummary } from '@/db/plansRepo'
import { cn } from '@/lib/utils'
import { sectionSummaryText } from '@/state/derived'
import { formatDateTime, formatRelativeTime } from './format'

export type PlanCardAction = 'rename' | 'duplicate-idea' | 'duplicate-scratch' | 'export' | 'delete'

export interface PlanCardProps {
  summary: PlanSummary
  /** Current time (ms) for "Updated 5 minutes ago"; the page ticks it. */
  now: number
  onAction: (action: PlanCardAction, summary: PlanSummary) => void
}

/**
 * One saved plan: name (opens it), frame, sections, Have/Need counts, age and a menu. Everything
 * comes from the cheap summary, so a page of cards never reads or validates whole plans.
 */
export function PlanCard({ summary, now, onAction }: PlanCardProps) {
  const navigate = useNavigate()
  const titleId = useId()
  const name = summary.name.trim() === '' ? 'Untitled plan' : summary.name
  const frameName = summary.frameName ?? summary.frameId
  const href = `/plan/${encodeURIComponent(summary.id)}`

  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        'relative flex h-full flex-col gap-3 overflow-hidden rounded-xl bg-card p-4 pt-5 text-sm ring-1 ring-foreground/10 transition-shadow has-[a:focus-visible]:ring-3 has-[a:focus-visible]:ring-ring/50 hover:ring-primary/50',
        // A slim accent cap on top: decoration only, the card reads the same without it.
        'before:absolute before:inset-x-0 before:top-0 before:h-1 before:bg-primary/80',
      )}
    >
      <div className="flex items-start gap-2">
        <h3 id={titleId} className="min-w-0 flex-1 text-base leading-snug font-medium break-words">
          {/* The link covers the card (after:), so the whole card opens the plan. */}
          <Link to={href} className="outline-none after:absolute after:inset-0 after:rounded-xl">
            {name}
          </Link>
        </h3>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${name}`}
                className="relative z-10 -mt-1 -mr-1"
              />
            }
          >
            <Ellipsis aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem onClick={() => void navigate(href)}>
              <FolderOpen aria-hidden />
              Open
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={summary.readOnly}
              onClick={() => onAction('rename', summary)}
            >
              <Pencil aria-hidden />
              Rename…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onAction('duplicate-idea', summary)}>
              <CopyPlus aria-hidden />
              <span className="grid">
                <span>Duplicate as new idea</span>
                <span className="text-xs text-muted-foreground">
                  Same rack, keeps what you have
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAction('duplicate-scratch', summary)}>
              <Copy aria-hidden />
              <span className="grid">
                <span>Duplicate from scratch</span>
                <span className="text-xs text-muted-foreground">New rack, everything to get</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAction('export', summary)}>
              <Download aria-hidden />
              Export as file
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => onAction('delete', summary)}>
              <Trash2 aria-hidden />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <dl className="grid gap-1">
        <div>
          <dt className="sr-only">Frame</dt>
          <dd className="text-muted-foreground">{frameName}</dd>
        </div>
        <div>
          <dt className="sr-only">Sections, bottom to top</dt>
          <dd>{sectionSummaryText(summary.sectionHeightsU)}</dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-1.5">
        <HaveNeedBadge have count={summary.haveCount} />
        <HaveNeedBadge have={false} count={summary.needCount} />
        {summary.readOnly ? (
          <Badge variant="outline" title="Made with a newer version of Mini Rack Planner">
            <Lock aria-hidden />
            Read-only
          </Badge>
        ) : null}
      </div>

      <p className="mt-auto text-xs text-muted-foreground">
        Updated{' '}
        <time dateTime={summary.updatedAt} title={formatDateTime(summary.updatedAt)}>
          {formatRelativeTime(summary.updatedAt, now)}
        </time>
      </p>
    </article>
  )
}
