import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NumberField } from './NumberField'

const PAUSE_MS = 800

/** A NumberField over a value "stored" in React state, like the settings live query. */
function Harness({
  initial,
  onCommit,
}: {
  initial: number | undefined
  onCommit: (value: number | undefined) => Promise<boolean>
}) {
  const [stored, setStored] = useState(initial)
  return (
    <>
      <NumberField
        id="price"
        label="PLA"
        unit="USD/kg"
        optional
        value={stored}
        onCommit={async (value) => {
          const saved = await onCommit(value)
          if (saved) setStored(value)
          return saved
        }}
      />
      {/* Another tab (or an import) changing the stored value. */}
      <button type="button" onClick={() => setStored(99)}>
        External change
      </button>
    </>
  )
}

function field(): HTMLInputElement {
  return screen.getByLabelText('PLA')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('NumberField', () => {
  it('saves after a pause in typing without eating a trailing decimal point', async () => {
    const onCommit = vi.fn(async (_value: number | undefined) => true)
    render(<Harness initial={20} onCommit={onCommit} />)
    expect(field()).toHaveAccessibleDescription('USD/kg')

    fireEvent.change(field(), { target: { value: '22.' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAUSE_MS)
    })
    expect(onCommit).toHaveBeenLastCalledWith(22)
    // The stored 22 came back while the user may still be typing: "22." stays.
    expect(field()).toHaveValue('22.')

    fireEvent.change(field(), { target: { value: '22.5' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAUSE_MS)
    })
    expect(onCommit).toHaveBeenLastCalledWith(22.5)
    expect(onCommit).toHaveBeenCalledTimes(2)

    // Leaving the field tidies the text without saving again.
    fireEvent.blur(field())
    expect(field()).toHaveValue('22.5')
    expect(onCommit).toHaveBeenCalledTimes(2)
  })

  it('does not save invalid input after a pause, and explains on blur', async () => {
    const onCommit = vi.fn(async (_value: number | undefined) => true)
    render(<Harness initial={20} onCommit={onCommit} />)
    fireEvent.change(field(), { target: { value: '2x' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAUSE_MS)
    })
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.blur(field())
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a number using digits')
    expect(field()).toHaveAccessibleDescription(/USD\/kg Enter a number using digits/)
  })

  it('keeps what the user is typing when the stored value changes elsewhere', async () => {
    render(<Harness initial={20} onCommit={async () => true} />)
    fireEvent.change(field(), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'External change' }))
    expect(field()).toHaveValue('3')

    // Without an edit in progress, the field follows the stored value.
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(field()).toHaveValue('99')
  })

  it('keeps a failed edit to try again', async () => {
    const onCommit = vi.fn(async (_value: number | undefined) => false)
    render(<Harness initial={20} onCommit={onCommit} />)
    fireEvent.change(field(), { target: { value: '25' } })
    fireEvent.keyDown(field(), { key: 'Enter' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(field()).toHaveValue('25')
    fireEvent.blur(field())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(onCommit).toHaveBeenCalledTimes(2)
  })
})
