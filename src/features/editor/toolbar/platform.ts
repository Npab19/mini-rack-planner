/** Apple keyboards say ⌘ where others say Ctrl (the shortcuts accept both). */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
}

/** The label of the command modifier: "⌘" on Apple devices, "Ctrl" elsewhere. */
export function modKeyLabel(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl'
}
