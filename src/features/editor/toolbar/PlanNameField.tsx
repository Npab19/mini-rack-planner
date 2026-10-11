import { useCallback, useEffect, useId, useRef, useState, type Ref } from 'react'
import { Input } from '@/components/ui/input'
import { usePlanStore } from '@/state/planStore'

/** A pause in typing this long ends the name edit: one undo step, saved right away. */
const NAME_IDLE_COMMIT_MS = 500
/** Same limit as the plan schema. */
const MAX_NAME_LENGTH = 200

/**
 * The plan name as the page heading, edited in place. Typing renames the plan in the store at
 * once, while a gesture keeps a burst of typing as one undo step. Enter, leaving the field or a
 * short pause ends the step and saves at once (rather than after the autosave delay), which keeps
 * the window for losing a name to an immediate reload small. Escape undoes the burst. A blank
 * name is never stored: the last one stays until a new one is typed.
 */
export function PlanNameField({ headingRef }: { headingRef: Ref<HTMLHeadingElement> }) {
  const name = usePlanStore((state) => state.plan?.name ?? '')
  const readOnly = usePlanStore((state) => state.readOnly)
  const [draft, setDraft] = useState<string | null>(null)
  const editing = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const errorId = useId()
  const blank = draft !== null && draft.trim() === ''

  const commit = useCallback(() => {
    clearTimeout(idleTimer.current)
    idleTimer.current = undefined
    if (!editing.current) return
    editing.current = false
    const store = usePlanStore.getState()
    store.endGesture()
    void store.flushSave()
  }, [])

  // Leaving mid-edit still records the edit as one step and saves it.
  useEffect(() => commit, [commit])

  function change(text: string): void {
    setDraft(text)
    const store = usePlanStore.getState()
    if (!editing.current) {
      store.beginGesture()
      editing.current = true
    }
    store.renamePlan(text)
    clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(commit, NAME_IDLE_COMMIT_MS)
  }

  function finish(): void {
    commit()
    setDraft(null)
  }

  function cancel(): void {
    clearTimeout(idleTimer.current)
    if (editing.current) {
      editing.current = false
      usePlanStore.getState().cancelGesture()
    }
    setDraft(null)
  }

  return (
    <div className="grid min-w-0">
      <h1 ref={headingRef} tabIndex={-1} className="min-w-0 rounded-md outline-none">
        <Input
          data-testid="plan-name-input"
          aria-label="Plan name"
          value={draft ?? name}
          readOnly={readOnly}
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => change(event.target.value)}
          onBlur={finish}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              finish()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancel()
            }
          }}
          aria-invalid={blank || undefined}
          aria-describedby={blank ? errorId : undefined}
          className="-mx-1.5 h-8 border-transparent bg-transparent px-1.5 text-base font-semibold tracking-tight hover:border-input md:text-base lg:text-lg dark:bg-transparent"
        />
      </h1>
      {blank ? (
        <p id={errorId} className="text-xs text-destructive">
          A plan needs a name. The current one is kept until you type a new one.
        </p>
      ) : null}
    </div>
  )
}
