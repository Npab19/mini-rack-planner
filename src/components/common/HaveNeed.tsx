/**
 * One vocabulary for owned vs planned, everywhere: "In my rack" (Have) and "To get" (Need). The
 * words carry the meaning; the icon shape (check vs dashed circle) and the fill (solid vs dashed
 * outline) repeat it, so it never depends on colour.
 */
import { CircleCheck, CircleDashed, type LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export const HAVE_TEXT = 'In my rack'
export const NEED_TEXT = 'To get'
export const HaveIcon: LucideIcon = CircleCheck
export const NeedIcon: LucideIcon = CircleDashed

/** "In my rack" / "To get", or with a count: "6 in my rack" / "4 to get". */
export function haveNeedText(have: boolean, count?: number): string {
  const text = have ? HAVE_TEXT : NEED_TEXT
  return count === undefined ? text : `${count} ${text.toLowerCase()}`
}

export function HaveNeedBadge({
  have,
  count,
  className,
}: {
  have: boolean
  count?: number
  className?: string
}) {
  const Icon = have ? HaveIcon : NeedIcon
  return (
    <Badge
      variant={have ? 'secondary' : 'outline'}
      className={cn(!have && 'border-dashed border-foreground/40', className)}
    >
      <Icon aria-hidden />
      {haveNeedText(have, count)}
    </Badge>
  )
}
