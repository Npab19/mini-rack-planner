/**
 * Which validation messages a part form shows: a field's problem appears once the user has left
 * the field (or tried to save) and then follows every keystroke; notes show as soon as they apply.
 */
import { useCallback, useMemo, useState } from 'react'
import type { FieldState } from './fields'
import type { FormCheck, FormIssue } from './partForms'

export interface FormView {
  /** The problem and the note a field shows now. */
  state: (field: string) => FieldState
  /** The user left the field: its problem shows from now on. */
  done: (field: string) => void
}

export function useFormView(check: FormCheck<unknown>, showAll: boolean): FormView {
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set())
  const done = useCallback((field: string) => {
    setTouched((current) => (current.has(field) ? current : new Set(current).add(field)))
  }, [])
  return useMemo(() => {
    const first = (list: readonly FormIssue[], field: string): FormIssue | undefined =>
      list.find((issue) => issue.field === field)
    return {
      state: (field) => {
        const error = showAll || touched.has(field) ? first(check.issues, field) : undefined
        const warning = first(check.warnings, field)
        return {
          ...(error === undefined ? {} : { error }),
          ...(warning === undefined ? {} : { warning }),
        }
      },
      done,
    }
  }, [check, showAll, touched, done])
}

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled])'

/**
 * Focuses the control of `field` inside `root` (marked with data-field); false when none. Field
 * names are letters, digits and dots, so they need no escaping inside the quoted selector.
 */
export function focusField(root: HTMLElement | null, field: string): boolean {
  const target = root?.querySelector<HTMLElement>(`[data-field="${field}"]`)
  if (target === null || target === undefined) return false
  const control = target.matches(FOCUSABLE) ? target : target.querySelector<HTMLElement>(FOCUSABLE)
  ;(control ?? target).focus()
  return true
}
