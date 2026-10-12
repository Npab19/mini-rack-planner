import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PART_ROLES } from '@/domain/partRole'
import { RoleChip, RoleDot } from './PartRole'

afterEach(cleanup)

describe('RoleDot', () => {
  it('is a decorative dot coloured through data-role', () => {
    const { container } = render(<RoleDot role="storage" className="size-3" />)
    const dot = container.firstElementChild
    expect(dot).toHaveAttribute('aria-hidden', 'true')
    expect(dot).toHaveAttribute('data-role', 'storage')
    expect(dot).toHaveClass('bg-(--part)', 'rounded-full', 'size-3')
    expect(dot).not.toHaveClass('size-2')
  })
})

describe('RoleChip', () => {
  it.each(PART_ROLES)('names the %s role in words next to its dot', (role) => {
    const { container } = render(<RoleChip role={role} />)
    const chip = container.firstElementChild
    expect(chip).toHaveAttribute('data-role', role)
    expect(chip?.querySelector('[aria-hidden]')).toHaveAttribute('data-role', role)
  })

  it('reads as its label', () => {
    render(<RoleChip role="neutral" />)
    expect(screen.getByText('Panels and shelves')).toHaveAttribute('data-role', 'neutral')
  })
})
