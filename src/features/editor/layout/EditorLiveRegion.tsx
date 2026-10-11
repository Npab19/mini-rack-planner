import { LiveRegion } from '@/components/common/LiveRegion'
import { useEditorAnnouncer } from './announcer'

/** The shell's polite live region; keep it mounted for the whole editor session. */
export function EditorLiveRegion() {
  const message = useEditorAnnouncer((state) => state.message)
  return <LiveRegion message={message} />
}
