import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAddPart } from '@/features/custom/addPartStore'
import { CustomPartActions, customPartRequests, linkInQuery } from './CustomPartActions'

beforeEach(() => {
  useAddPart.setState({ request: null })
})

afterEach(() => {
  cleanup()
})

describe('CustomPartActions', () => {
  it('opens the Add a part wizard and the custom part editor, named by the search text', () => {
    render(<CustomPartActions query="  Zeta shelf  " placeAfterSave />)
    expect(screen.getByRole('group', { name: 'Add your own part' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add a part from a link or file' }))
    expect(useAddPart.getState().request).toEqual({
      kind: 'wizard',
      addToOpenPlan: true,
      placeAfterSave: true,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Create a custom part' }))
    expect(useAddPart.getState().request).toEqual({
      kind: 'item',
      prefill: { name: 'Zeta shelf' },
      addToOpenPlan: true,
      placeAfterSave: true,
    })
  })

  it('makes a device on the Devices tab, and starts the wizard from a pasted link', () => {
    render(<CustomPartActions kind="device" query="https://makerworld.com/en/models/123-mount" />)
    fireEvent.click(screen.getByRole('button', { name: 'Add a part from a link or file' }))
    expect(useAddPart.getState().request).toEqual({
      kind: 'wizard',
      url: 'https://makerworld.com/en/models/123-mount',
      addToOpenPlan: true,
      placeAfterSave: false,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create a custom part' }))
    expect(useAddPart.getState().request).toEqual({
      kind: 'device',
      addToOpenPlan: true,
      placeAfterSave: false,
    })
  })

  it('does nothing while disabled', () => {
    render(<CustomPartActions disabled layout="stack" />)
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled()
      fireEvent.click(button)
    }
    expect(useAddPart.getState().request).toBeNull()
  })
})

describe('linkInQuery / customPartRequests', () => {
  it('only takes http and https links, whole', () => {
    expect(linkInQuery(' https://www.printables.com/model/1 ')).toBe(
      'https://www.printables.com/model/1',
    )
    expect(linkInQuery('HTTP://example.com/x')).toBe('HTTP://example.com/x')
    for (const text of [
      'javascript:alert(1)',
      'makerworld.com/x',
      'see https://x.y',
      '',
      undefined,
    ]) {
      expect(linkInQuery(text)).toBeUndefined()
    }
  })

  it('leaves the part unnamed without search text, and only the library when asked', () => {
    expect(customPartRequests({ addToOpenPlan: false })).toEqual({
      fromLink: { kind: 'wizard', addToOpenPlan: false, placeAfterSave: false },
      create: { kind: 'item', addToOpenPlan: false, placeAfterSave: false },
    })
  })
})
