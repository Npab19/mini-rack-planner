import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HAVE_NEED_CLASSES, HaveNeedBadge, haveNeedKey, haveNeedText } from './HaveNeed'

afterEach(cleanup)

describe('HaveNeedBadge', () => {
  it('says In my rack with a check, on the green tone with a solid border', () => {
    render(<HaveNeedBadge have />)
    const badge = screen.getByText('In my rack')
    expect(badge).toHaveClass('bg-have-soft', 'text-have', 'border-have-border')
    expect(badge).not.toHaveClass('border-dashed')
    expect(badge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('says To get with a dashed circle, on the amber tone with a dashed border', () => {
    render(<HaveNeedBadge have={false} count={4} className="ml-1" />)
    const badge = screen.getByText('4 to get')
    expect(badge).toHaveClass('bg-need-soft', 'text-need', 'border-need-border', 'border-dashed')
    expect(badge).toHaveClass('ml-1')
    expect(badge.querySelector('svg')).toHaveClass('lucide-circle-dashed')
  })
})

describe('Have/Need helpers', () => {
  it('words and keys', () => {
    expect(haveNeedText(true, 6)).toBe('6 in my rack')
    expect(haveNeedText(false)).toBe('To get')
    expect(haveNeedKey(true)).toBe('have')
    expect(haveNeedKey(false)).toBe('need')
  })

  it('keeps the dashed To get pattern in the shared class map', () => {
    expect(HAVE_NEED_CLASSES.need).toContain('border-dashed')
    expect(HAVE_NEED_CLASSES.have).not.toContain('border-dashed')
  })
})
