/**
 * What a part is for, as a colour hint next to its name (`src/domain/partRole.ts`). The colour
 * comes from the `--part` token that `data-role` selects in `index.css`. A dot is decorative and
 * always sits next to the part's name; the chip adds the role in words, so colour is never the
 * only cue.
 */
import { PART_ROLE_LABEL, type PartRole } from '@/domain/partRole'
import { cn } from '@/lib/utils'

export interface PartRoleProps {
  role: PartRole
  className?: string
}

/** A small decorative dot in the role's colour; put it next to the part's name. */
export function RoleDot({ role, className }: PartRoleProps) {
  return (
    <span
      aria-hidden
      data-role={role}
      className={cn('inline-block size-2 shrink-0 rounded-full bg-(--part)', className)}
    />
  )
}

/** The role in words with its dot: "● Compute". */
export function RoleChip({ role, className }: PartRoleProps) {
  return (
    <span
      data-role={role}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1 rounded-4xl border border-(--part)/40 bg-(--part-soft) px-2 py-0.5 text-xs font-medium whitespace-nowrap text-foreground',
        className,
      )}
    >
      <RoleDot role={role} />
      {PART_ROLE_LABEL[role]}
    </span>
  )
}
