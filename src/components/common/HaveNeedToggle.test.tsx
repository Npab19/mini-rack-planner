import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HaveNeedToggle } from './HaveNeedToggle'

afterEach(cleanup)

describe('HaveNeedToggle', () => {
  it('is a labelled radio group with the current state checked', () => {
    render(<HaveNeedToggle have label="Shelf 1U: in my rack or to get" onChange={() => {}} />)
    expect(screen.getByRole('radiogroup', { name: 'Shelf 1U: in my rack or to get' })).toBeDefined()
    expect(screen.getByRole('radio', { name: 'In my rack' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('radio', { name: 'To get' })).toHaveAttribute('aria-checked', 'false')
  })

  it('reports a change, and not a click on the checked option', () => {
    const onChange = vi.fn()
    render(<HaveNeedToggle have label="Mount" onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'In my rack' }))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'To get' }))
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('styles a chosen In my rack solid green and a chosen To get dashed amber', () => {
    render(<HaveNeedToggle have={false} label="Mount" onChange={() => {}} />)
    const have = screen.getByRole('radio', { name: 'In my rack' })
    const need = screen.getByRole('radio', { name: 'To get' })
    expect(have).toHaveClass('data-checked:bg-have', 'data-checked:text-have-foreground')
    expect(need).toHaveClass(
      'data-checked:border-dashed',
      'data-checked:border-need-border',
      'data-checked:bg-need-soft',
      'data-checked:text-need',
    )
    expect(need).toHaveAttribute('data-checked')
    expect(have).not.toHaveAttribute('data-checked')
  })
})
