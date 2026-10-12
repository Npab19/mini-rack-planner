import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OnHandField, parseOnHand, stepOf } from './OnHandField'

afterEach(() => {
  cleanup()
})

describe('parseOnHand', () => {
  it('takes whole pieces, stock to 0.1 mm, and empty as none', () => {
    expect(parseOnHand('20', 'pcs')).toEqual({ ok: true, value: 20 })
    expect(parseOnHand(' ', 'pcs')).toEqual({ ok: true, value: 0 })
    expect(parseOnHand('2.5', 'pcs')).toEqual({
      ok: false,
      message: 'Enter a whole number, like 20.',
    })
    expect(parseOnHand('1200,25', 'mm')).toEqual({ ok: true, value: 1200.3 })
    expect(parseOnHand('-3', 'pcs')).toMatchObject({ ok: false })
    expect(parseOnHand('2000000', 'pcs')).toEqual({ ok: false, message: 'Enter 1000000 or less.' })
    expect(stepOf('pcs')).toBe(1)
    expect(stepOf('mm')).toBe(100)
  })
})

describe('OnHandField', () => {
  it('saves on Enter, steps with the buttons and puts the number back on Escape', () => {
    const onSet = vi.fn(async () => true)
    const onStep = vi.fn()
    render(<OnHandField name="M6 nyloc nut" value={4} unit="pcs" onSet={onSet} onStep={onStep} />)
    const field = screen.getByRole('textbox', { name: 'On hand: M6 nyloc nut' })
    expect(field).toHaveAccessibleDescription('pcs')

    fireEvent.change(field, { target: { value: '12' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onSet).toHaveBeenCalledWith(12)

    fireEvent.change(field, { target: { value: '99' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(field).toHaveValue('4')

    fireEvent.click(screen.getByRole('button', { name: 'Add 1: M6 nyloc nut' }))
    fireEvent.click(screen.getByRole('button', { name: 'Take away 1: M6 nyloc nut' }))
    expect(onStep.mock.calls).toEqual([[1], [-1]])
  })

  it('steps stock by 100 mm and never below 0', () => {
    const onStep = vi.fn()
    render(
      <OnHandField
        name="2020 extrusion"
        value={40}
        unit="mm"
        onSet={async () => true}
        onStep={onStep}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Take away 100 mm: 2020 extrusion' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add 100 mm: 2020 extrusion' }))
    expect(onStep.mock.calls).toEqual([[-40], [100]])
  })
})
