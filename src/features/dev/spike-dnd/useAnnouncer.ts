import { useCallback, useState } from 'react'

export interface Announcement {
  message: string
  /** Increments on every announcement so a repeated message is re-rendered (and re-read). */
  seq: number
}

export function useAnnouncer(): {
  announcement: Announcement
  announce: (message: string) => void
} {
  const [announcement, setAnnouncement] = useState<Announcement>({ message: '', seq: 0 })
  const announce = useCallback((message: string) => {
    setAnnouncement((previous) => ({ message, seq: previous.seq + 1 }))
  }, [])
  return { announcement, announce }
}
