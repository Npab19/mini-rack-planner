import { useCallback, useState } from 'react'

/**
 * A polite announcement for screen readers: `[message, announce]`. Saying the same thing twice
 * still announces it (a no-break space is toggled), so repeated actions are not silent.
 */
export function useAnnouncer(): [string, (text: string) => void] {
  const [message, setMessage] = useState('')
  const announce = useCallback((text: string) => {
    setMessage((previous) => (previous === text ? `${text} ` : text))
  }, [])
  return [message, announce]
}

/** Renders the announcement off-screen. Keep it mounted so the live region is registered early. */
export function LiveRegion({ message }: { message: string }) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  )
}
