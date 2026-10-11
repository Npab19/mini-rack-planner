import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'

export type FieldParse<T> = { ok: true; value: T } | { ok: false; message: string }

export interface CommitFieldOptions<T> {
  /** The stored value. */
  value: T
  format: (value: T) => string
  /** Turns the typed text into a value, or explains what is wrong with it. */
  parse: (text: string) => FieldParse<T>
  /** Defaults to Object.is. */
  equals?: (a: T, b: T) => boolean
  /** Saves the value; resolves false when that failed (the edit is kept to try again). */
  onCommit: (value: T) => Promise<boolean>
  /** Rewrites the text as it is typed, e.g. to upper case. */
  transform?: (text: string) => string
  /** Saves valid input after this long without typing (ms); 0 turns it off. */
  pauseMs?: number
}

export interface CommitField {
  error: string | null
  inputProps: {
    value: string
    onChange: (event: ChangeEvent<HTMLInputElement>) => void
    onBlur: () => void
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
    'aria-invalid': true | undefined
  }
}

type CommitSource = 'blur' | 'enter' | 'pause'

/**
 * A text field over a stored value that saves itself: on Enter, on leaving the field and after a
 * short pause in typing. Escape puts the stored value back. Invalid input is never saved; its
 * message shows on Enter or blur (not mid-typing). While the user types, changes to the stored
 * value (another tab, an import) do not overwrite the text.
 */
export function useCommitField<T>(options: CommitFieldOptions<T>): CommitField {
  const { value, format, parse, onCommit, transform, pauseMs = 800 } = options
  const equals = options.equals ?? Object.is
  const [text, setText] = useState(() => format(value))
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(value)

  if (!equals(shown, value)) {
    // The stored value changed. Keep the text while the user is typing, and also when it already
    // means the new value: rewriting "22." to "22" mid-typing would eat the decimal point.
    setShown(value)
    const current = parse(text)
    if (!dirty && !(current.ok && equals(current.value, value))) setText(format(value))
  }

  function commit(source: CommitSource): void {
    const parsed = parse(text)
    if (!dirty) {
      // Already saved (after a pause): tidy the text once the user leaves the field.
      if (source === 'blur' && parsed.ok && equals(parsed.value, value)) setText(format(value))
      return
    }
    if (!parsed.ok) {
      if (source !== 'pause') setError(parsed.message)
      return
    }
    setError(null)
    setDirty(false)
    if (source !== 'pause') setText(format(parsed.value))
    if (equals(parsed.value, value)) return
    void onCommit(parsed.value).then(
      (saved) => {
        if (!saved) setDirty(true)
      },
      () => setDirty(true),
    )
  }

  // The pause timer must run the commit of the render that holds the latest text, not the one of
  // the keystroke that started it.
  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  })
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(pauseTimer.current), [])

  function commitNow(source: Exclude<CommitSource, 'pause'>): void {
    clearTimeout(pauseTimer.current)
    commit(source)
  }

  return {
    error,
    inputProps: {
      value: text,
      onChange: (event) => {
        const next = event.target.value
        setText(transform === undefined ? next : transform(next))
        setDirty(true)
        setError(null)
        // Every keystroke restarts the pause.
        clearTimeout(pauseTimer.current)
        if (pauseMs > 0) pauseTimer.current = setTimeout(() => commitRef.current('pause'), pauseMs)
      },
      onBlur: () => commitNow('blur'),
      onKeyDown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commitNow('enter')
        } else if (event.key === 'Escape' && (dirty || error !== null)) {
          event.preventDefault()
          clearTimeout(pauseTimer.current)
          setText(format(value))
          setDirty(false)
          setError(null)
        }
      },
      'aria-invalid': error === null ? undefined : true,
    },
  }
}
