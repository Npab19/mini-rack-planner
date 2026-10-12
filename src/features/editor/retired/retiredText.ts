/**
 * Words for the "Removed but owned" section. Pure.
 */
import type { RetiredSpare, RetiredView } from '@/domain/retired'
import type { RetiredKind } from '@/domain/schema/plan'

const KIND_TEXT: Readonly<Record<RetiredKind, string>> = {
  placement: 'Part',
  section: 'Section',
  extra: 'Accessory',
  cap: 'Top or bottom',
}

/** "Part", "Section", "Accessory", "Top or bottom". */
export function retiredKindText(kind: RetiredKind): string {
  return KIND_TEXT[kind]
}

/** "Lenovo Tiny mount", or "Rubber feet × 3" for accessories. */
export function retiredTitle(view: Pick<RetiredView, 'name' | 'qty' | 'kind'>): string {
  return view.kind === 'extra' && view.qty !== undefined ? `${view.name} × ${view.qty}` : view.name
}

/** "11 Oct 2026" in the user's locale; "an unknown day" when it is no date. */
export function removedOnText(iso: string, locale?: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return 'an unknown day'
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(time)
}

/** "1 × Lenovo Tiny mount: Tiny mount (printed)", "4 × M5×10 screw", "120 mm of 2020 rail". */
export function spareText(spare: Pick<RetiredSpare, 'kind' | 'label' | 'qty' | 'unit'>): string {
  if (spare.unit === 'mm') return `${spare.qty} mm of ${spare.label}`
  return `${spare.qty} × ${spare.label}${spare.kind === 'print' ? ' (printed)' : ''}`
}
