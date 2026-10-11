/**
 * A native <select> styled like the kit's inputs. Used where a plain list of values is the whole
 * job (heights, U positions): the platform picker is the most robust choice on phones and with
 * assistive tech, and needs no portal.
 */
import { ChevronDown } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function NativeSelect({
  className,
  wrapperClassName,
  children,
  ...props
}: ComponentProps<'select'> & { wrapperClassName?: string }) {
  return (
    <span className={cn('relative inline-flex w-full min-w-0', wrapperClassName)}>
      <select
        className={cn(
          'h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-background py-1 pr-8 pl-2.5 text-base outline-none',
          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm dark:bg-input/30',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  )
}
