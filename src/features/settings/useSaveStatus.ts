import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/db/errors'

export type SaveState =
  { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }

/** How long "Saved" stays up after a change. */
export const SAVED_VISIBLE_MS = 2500

export interface SaveStatus {
  state: SaveState
  /** Runs a save and reflects it; resolves false (after a toast) when it failed. */
  track: (save: () => Promise<unknown>) => Promise<boolean>
  /** For changes applied synchronously (the theme). */
  markSaved: () => void
}

/**
 * The per-section "Saved" indicator. Only the latest save's outcome is shown, so a slow earlier
 * save cannot overwrite the status of a later one.
 */
export function useSaveStatus(): SaveStatus {
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  const latest = useRef(0)

  useEffect(() => {
    if (state.kind !== 'saved') return
    const timer = setTimeout(() => setState({ kind: 'idle' }), SAVED_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [state])

  const track = useCallback(async (save: () => Promise<unknown>): Promise<boolean> => {
    latest.current += 1
    const id = latest.current
    setState({ kind: 'saving' })
    try {
      await save()
      if (id === latest.current) setState({ kind: 'saved' })
      return true
    } catch (error) {
      const message = errorMessage(error)
      if (id === latest.current) setState({ kind: 'error', message })
      toast.error(`Could not save the setting: ${message}`)
      return false
    }
  }, [])

  const markSaved = useCallback(() => {
    latest.current += 1
    setState({ kind: 'saved' })
  }, [])

  return { state, track, markSaved }
}
