/**
 * Saving files the app makes (backups, exports). Chromium on a secure origin gets the "Save as"
 * dialog of the File System Access API, so the user picks the folder. Everywhere else, including
 * plain-HTTP LAN origins (the Docker image on http://host:8080), Firefox and Safari, the file goes
 * to the browser's downloads through a temporary object URL and an `<a download>` click.
 */

/** How the file left the app. */
export type DownloadOutcome =
  /** Written where the user chose in the save dialog. */
  | 'saved'
  /** Handed to the browser's downloads (the browser may still ask where to put it). */
  | 'downloaded'
  /** The user closed the save dialog: nothing was written. */
  | 'cancelled'

/**
 * Object URLs are revoked this long after the click. Revoking right away can cancel the download
 * in Firefox and Safari, which read the blob after the click returns.
 */
export const REVOKE_DELAY_MS = 40_000

interface SaveFilePickerType {
  description?: string
  accept: Record<string, string[]>
}

interface SaveFilePickerOptions {
  suggestedName?: string
  types?: SaveFilePickerType[]
}

type ShowSaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>

/** `showSaveFilePicker` when this page may use it now, else undefined. */
function usableSavePicker(): ShowSaveFilePicker | undefined {
  if (typeof window === 'undefined' || globalThis.isSecureContext !== true) return undefined
  // Not in TypeScript's DOM lib: Chromium only, and only in secure contexts.
  const picker = (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
  if (typeof picker !== 'function') return undefined
  // The picker needs transient user activation (a click moments ago). Without the API to check
  // it, assume there is none: a SecurityError would only cost a detour.
  const activation: UserActivation | undefined =
    typeof navigator === 'undefined' ? undefined : navigator.userActivation
  return activation?.isActive === true ? (picker as ShowSaveFilePicker) : undefined
}

/** The picker's file type filter, when the name has an extension and the blob a plain MIME type. */
function pickerTypes(filename: string, mediaType: string): SaveFilePickerType[] | undefined {
  const extension = /\.[a-z0-9]{1,15}$/i.exec(filename)?.[0]
  // Chromium rejects MIME parameters such as "; charset=utf-8" in `accept`.
  const essence = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (extension === undefined || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(essence)) return undefined
  return [{ accept: { [essence]: [extension.toLowerCase()] } }]
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  )
}

/** Hands the blob to the browser's downloads through a temporary link. */
function downloadWithLink(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  // Where `download` is ignored (old iOS), the blob opens in a new tab without access to this one.
  link.rel = 'noopener'
  link.hidden = true
  // Firefox only follows links that are in the document.
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
  }
}

/**
 * Saves `blob` as `filename`. Uses the save dialog where it is available, on a secure origin and
 * still within the click's user activation; on any failure there it falls back to a download,
 * except when the user closed the dialog (`'cancelled'`: nothing is saved behind their back).
 */
export async function downloadBlob(filename: string, blob: Blob): Promise<DownloadOutcome> {
  const picker = usableSavePicker()
  if (picker !== undefined) {
    let handle: FileSystemFileHandle | undefined
    try {
      handle = await picker.call(window, {
        suggestedName: filename,
        types: pickerTypes(filename, blob.type),
      })
    } catch (error) {
      if (isAbortError(error)) return 'cancelled'
      // Activation expired, blocked by policy or a sandboxed frame: use the download below.
    }
    if (handle !== undefined) {
      try {
        const writable = await handle.createWritable()
        try {
          await writable.write(blob)
          await writable.close()
          return 'saved'
        } catch (error) {
          await writable.abort().catch(() => undefined)
          throw error
        }
      } catch {
        // The chosen file could not be written (permission, disk): still give the user the data.
      }
    }
  }
  downloadWithLink(filename, blob)
  return 'downloaded'
}

/**
 * Saves `data` as pretty-printed JSON (two-space indent, trailing newline).
 * @throws TypeError when `data` has no JSON form (undefined, a function) or cannot be serialized
 */
export async function downloadJson(filename: string, data: unknown): Promise<DownloadOutcome> {
  const text: string | undefined = JSON.stringify(data, null, 2)
  if (text === undefined) throw new TypeError('Nothing to save: the value has no JSON form.')
  return downloadBlob(filename, new Blob([`${text}\n`], { type: 'application/json' }))
}
