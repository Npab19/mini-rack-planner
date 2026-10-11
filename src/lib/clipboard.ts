/**
 * Copies text to the clipboard. The async Clipboard API exists only in secure contexts, so it is
 * missing on plain-HTTP LAN origins, and it can refuse (permissions policy, an unfocused page).
 * The fallback is a hidden textarea and `execCommand('copy')`, which still works there. Resolves
 * false when both fail: the caller then shows the text in a select-all dialog to copy by hand.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard: Clipboard | undefined =
    typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // Refused: try the legacy path below.
    }
  }
  return copyWithExecCommand(text)
}

/** Focusable containers that trap focus: the helper textarea must live inside them. */
const FOCUS_TRAPS = 'dialog, [role="dialog"], [role="alertdialog"]'

function copyWithExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false
  const active = document.activeElement
  // A modal's focus trap would pull focus back out of a textarea appended to <body>.
  const host = (active instanceof HTMLElement && active.closest(FOCUS_TRAPS)) || document.body
  const textarea = document.createElement('textarea')
  textarea.value = text
  // readonly keeps the on-screen keyboard closed on phones; 12pt stops iOS zooming in.
  textarea.setAttribute('readonly', '')
  textarea.setAttribute('aria-hidden', 'true')
  textarea.tabIndex = -1
  Object.assign(textarea.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '1px',
    height: '1px',
    padding: '0',
    border: '0',
    opacity: '0',
    fontSize: '12pt',
  })
  host.append(textarea)
  try {
    // execCommand copies the focused selection; select() alone does not focus everywhere.
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
    if (active instanceof HTMLElement) active.focus({ preventScroll: true })
  }
}
