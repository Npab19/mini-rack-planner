/**
 * One vocabulary for owned vs planned, everywhere: "In my rack" (Have) and "To get" (Need). The
 * words carry the meaning; the icon shape (check vs dashed circle) and the fill (solid vs dashed
 * outline) repeat it, so it never depends on colour. Colour is a third cue: green (`have` tokens)
 * for In my rack, amber (`need` tokens) for To get.
 */
import { CircleCheck, CircleDashed, type LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

export const HAVE_TEXT = 'In my rack'
export const NEED_TEXT = 'To get'
export const HaveIcon: LucideIcon = CircleCheck
export const NeedIcon: LucideIcon = CircleDashed

export type HaveNeedKey = 'have' | 'need'

export function haveNeedKey(have: boolean): HaveNeedKey {
  return have ? 'have' : 'need'
}

/**
 * The badge look for other surfaces (chips, summary pills, list cells): soft background, coloured
 * text and a 1px border, dashed for To get. Shape and size stay with the caller.
 */
export const HAVE_NEED_CLASSES: Readonly<Record<HaveNeedKey, string>> = {
  have: 'border border-have-border bg-have-soft text-have',
  need: 'border border-dashed border-need-border bg-need-soft text-need',
}

/** Just the colour, for icons and numbers on a plain background ("4 to get" in the BOM). */
export const HAVE_NEED_TEXT_CLASSES: Readonly<Record<HaveNeedKey, string>> = {
  have: 'text-have',
  need: 'text-need',
}

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
    <Badge variant={haveNeedKey(have)} className={className}>
      <Icon aria-hidden />
      {haveNeedText(have, count)}
    </Badge>
  )
}
