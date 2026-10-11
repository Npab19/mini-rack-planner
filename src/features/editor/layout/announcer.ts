/**
 * The editor shell's screen-reader announcements (undo, zoom, face, placing cancelled…). A store
 * rather than component state, so an announcement re-renders only the live region and never the
 * rack or the panels. Panels may use `announce` too instead of keeping a live region of their own.
 */
import { create } from 'zustand'

interface AnnouncerState {
  message: string
}

export const useEditorAnnouncer = create<AnnouncerState>()(() => ({ message: '' }))

/**
 * Says `text` politely. Saying the same thing twice still announces it (a trailing space is
 * toggled), so repeated actions ("Zoom 400%, the largest.") are not silent.
 */
export function announce(text: string): void {
  useEditorAnnouncer.setState((state) => ({
    message: state.message === text ? `${text} ` : text,
  }))
}

export function clearAnnouncement(): void {
  useEditorAnnouncer.setState({ message: '' })
}
