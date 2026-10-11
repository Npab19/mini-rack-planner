// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadBlob, downloadJson, REVOKE_DELAY_MS } from './download'

interface ClickedLink {
  href: string
  download: string
  inDocument: boolean
}

let clicks: ClickedLink[] = []
let createObjectURL: ReturnType<typeof vi.fn<(blob: Blob) => string>>
let revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>
let lastBlob: Blob | undefined

function defineGlobal(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, configurable: true, writable: true })
}

/**
 * A save dialog: the user picks a file that is written (`write`) or fails to write
 * (`write-fails`), or the dialog itself rejects with the given error.
 */
function stubPicker(behaviour: 'write' | 'write-fails' | DOMException) {
  const written: Blob[] = []
  const close = vi.fn(async () => {})
  const abort = vi.fn(async () => {})
  const picker = vi.fn(async (options?: { suggestedName?: string }) => {
    // jsdom's DOMException is not an Error subclass, so test for the string modes instead.
    if (typeof behaviour !== 'string') throw behaviour
    return {
      name: options?.suggestedName ?? '',
      createWritable: async () => ({
        write: async (data: Blob) => {
          if (behaviour === 'write-fails') throw new DOMException('Disk full', 'QuotaExceededError')
          written.push(data)
        },
        close,
        abort,
      }),
    }
  })
  defineGlobal(window, 'showSaveFilePicker', picker)
  return { picker, close, abort, written }
}

function setActivation(isActive: boolean | undefined): void {
  defineGlobal(
    navigator,
    'userActivation',
    isActive === undefined ? undefined : { isActive, hasBeenActive: isActive },
  )
}

beforeEach(() => {
  clicks = []
  lastBlob = undefined
  // jsdom has no object URLs and does not follow download links.
  createObjectURL = vi.fn((blob: Blob) => {
    lastBlob = blob
    return 'blob:http://localhost/1234'
  })
  revokeObjectURL = vi.fn()
  defineGlobal(URL, 'createObjectURL', createObjectURL)
  defineGlobal(URL, 'revokeObjectURL', revokeObjectURL)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({ href: this.href, download: this.download, inDocument: this.isConnected })
  })
  vi.stubGlobal('isSecureContext', true)
  setActivation(true)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  defineGlobal(window, 'showSaveFilePicker', undefined)
  setActivation(undefined)
  document.body.innerHTML = ''
})

describe('downloadBlob without a save dialog', () => {
  it('clicks a temporary download link and revokes the URL later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const blob = new Blob(['a,b\n'], { type: 'text/csv' })
    await expect(downloadBlob('bom.csv', blob)).resolves.toBe('downloaded')

    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(clicks).toEqual([
      { href: 'blob:http://localhost/1234', download: 'bom.csv', inDocument: true },
    ])
    expect(document.querySelector('a')).toBeNull()
    // Not revoked at once: Firefox and Safari read the blob after the click.
    expect(revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(REVOKE_DELAY_MS)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/1234')
  })

  it('does not use the save dialog on insecure origins', async () => {
    const { picker } = stubPicker('write')
    vi.stubGlobal('isSecureContext', false)
    await expect(downloadBlob('a.json', new Blob(['{}']))).resolves.toBe('downloaded')
    expect(picker).not.toHaveBeenCalled()
    expect(clicks).toHaveLength(1)
  })

  it('does not use the save dialog outside a user gesture, or when that cannot be checked', async () => {
    const { picker } = stubPicker('write')
    setActivation(false)
    await expect(downloadBlob('a.json', new Blob(['{}']))).resolves.toBe('downloaded')
    setActivation(undefined)
    await expect(downloadBlob('a.json', new Blob(['{}']))).resolves.toBe('downloaded')
    expect(picker).not.toHaveBeenCalled()
    expect(clicks).toHaveLength(2)
  })
})

describe('downloadBlob with a save dialog', () => {
  it('writes the file the user picked, with the name and type suggested', async () => {
    const { picker, close, written } = stubPicker('write')
    const blob = new Blob(['{}'], { type: 'application/json; charset=utf-8' })
    await expect(downloadBlob('backup.json', blob)).resolves.toBe('saved')
    expect(picker).toHaveBeenCalledWith({
      suggestedName: 'backup.json',
      types: [{ accept: { 'application/json': ['.json'] } }],
    })
    expect(written).toEqual([blob])
    expect(close).toHaveBeenCalledTimes(1)
    expect(clicks).toHaveLength(0)
  })

  it('saves nothing when the user closes the dialog', async () => {
    stubPicker(new DOMException('The user aborted a request.', 'AbortError'))
    await expect(downloadBlob('a.json', new Blob(['{}']))).resolves.toBe('cancelled')
    expect(clicks).toHaveLength(0)
  })

  it('falls back to a download when the dialog fails for any other reason', async () => {
    stubPicker(new DOMException('Must be handling a user gesture.', 'SecurityError'))
    await expect(downloadBlob('a.json', new Blob(['{}']))).resolves.toBe('downloaded')
    expect(clicks).toHaveLength(1)
  })

  it('falls back to a download when writing the chosen file fails', async () => {
    const { abort, close } = stubPicker('write-fails')
    await expect(downloadBlob('a.json', new Blob(['{}']))).resolves.toBe('downloaded')
    expect(abort).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    expect(clicks).toHaveLength(1)
  })
})

describe('downloadJson', () => {
  it('saves pretty-printed JSON with a trailing newline', async () => {
    await expect(downloadJson('plan.json', { name: 'Rack', u: [3, 6] })).resolves.toBe('downloaded')
    expect(lastBlob?.type).toBe('application/json')
    expect(await lastBlob?.text()).toBe('{\n  "name": "Rack",\n  "u": [\n    3,\n    6\n  ]\n}\n')
    expect(clicks[0]?.download).toBe('plan.json')
  })

  it('rejects values without a JSON form', async () => {
    await expect(downloadJson('x.json', undefined)).rejects.toThrow(TypeError)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(downloadJson('x.json', cyclic)).rejects.toThrow()
    expect(clicks).toHaveLength(0)
  })
})
