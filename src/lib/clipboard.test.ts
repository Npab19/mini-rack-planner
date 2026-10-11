// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
}

function setExecCommand(implementation: ((command: string) => boolean) | undefined): void {
  Object.defineProperty(document, 'execCommand', { value: implementation, configurable: true })
}

afterEach(() => {
  setClipboard(undefined)
  setExecCommand(undefined)
  document.body.innerHTML = ''
})

describe('copyText', () => {
  it('uses the async Clipboard API when it exists', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    const execCommand = vi.fn(() => true)
    setClipboard({ writeText })
    setExecCommand(execCommand)
    await expect(copyText('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('falls back to a selected textarea without the Clipboard API (plain-HTTP origins)', async () => {
    const button = document.createElement('button')
    document.body.append(button)
    button.focus()
    let copied = ''
    setExecCommand((command) => {
      const focused = document.activeElement
      copied = focused instanceof HTMLTextAreaElement ? focused.value : ''
      return command === 'copy'
    })
    await expect(copyText('line 1\nline 2')).resolves.toBe(true)
    expect(copied).toBe('line 1\nline 2')
    // The helper is gone and focus is back where it was.
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('falls back when the Clipboard API refuses', async () => {
    setClipboard({ writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) })
    const execCommand = vi.fn(() => true)
    setExecCommand(execCommand)
    await expect(copyText('x')).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('puts the helper inside an open dialog, where its focus trap allows it', async () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const button = document.createElement('button')
    dialog.append(button)
    document.body.append(dialog)
    button.focus()
    let parent: Element | null = null
    setExecCommand(() => {
      parent = document.querySelector('textarea')?.parentElement ?? null
      return true
    })
    await copyText('x')
    expect(parent).toBe(dialog)
  })

  it('resolves false when nothing can copy, so the caller can show the text instead', async () => {
    await expect(copyText('x')).resolves.toBe(false)
    setExecCommand(() => false)
    await expect(copyText('x')).resolves.toBe(false)
    setExecCommand(() => {
      throw new Error('not supported')
    })
    await expect(copyText('x')).resolves.toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })
})
