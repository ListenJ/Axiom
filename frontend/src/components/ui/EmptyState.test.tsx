import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import EmptyState from './EmptyState'
import { Inbox } from 'lucide-react'

describe('EmptyState', () => {
  it('renders icon and title', () => {
    render(<EmptyState icon={<Inbox data-testid="icon" />} title="空空如也" />)
    expect(screen.getByTestId('icon')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '空空如也' })).toBeInTheDocument()
  })

  it('renders description when provided', () => {
    render(
      <EmptyState
        icon={<Inbox />}
        title="空空如也"
        description="快去添加第一条数据"
      />
    )
    expect(screen.getByText('快去添加第一条数据')).toBeInTheDocument()
  })

  it('omits description paragraph when not provided', () => {
    const { container } = render(
      <EmptyState icon={<Inbox />} title="empty" />
    )
    // No <p> inside the card when description is omitted
    expect(container.querySelector('p')).toBeNull()
  })

  it('renders an action slot when provided', () => {
    render(
      <EmptyState
        icon={<Inbox />}
        title="empty"
        action={<button type="button">add</button>}
      />
    )
    expect(screen.getByRole('button', { name: 'add' })).toBeInTheDocument()
  })

  it('wraps content in a ShimmerCard with outlined variant', () => {
    const { container } = render(
      <EmptyState icon={<Inbox />} title="x" />
    )
    const wrapper = container.firstElementChild
    expect(wrapper?.className).toMatch(/border-dashed/)
  })
})
