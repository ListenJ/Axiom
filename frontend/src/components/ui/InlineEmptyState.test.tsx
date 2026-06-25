import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import InlineEmptyState from './InlineEmptyState'
import { Inbox } from 'lucide-react'

describe('InlineEmptyState', () => {
  it('renders icon and title', () => {
    render(<InlineEmptyState icon={<Inbox data-testid="icon" />} title="没有数据" />)
    expect(screen.getByTestId('icon')).toBeInTheDocument()
    expect(screen.getByText('没有数据')).toBeInTheDocument()
  })

  it('renders description when provided', () => {
    render(
      <InlineEmptyState
        icon={<Inbox />}
        title="没有数据"
        description="请稍后再试"
      />
    )
    expect(screen.getByText('请稍后再试')).toBeInTheDocument()
  })

  it('omits description when not provided', () => {
    const { container } = render(
      <InlineEmptyState icon={<Inbox />} title="empty" />
    )
    // only the icon-wrapper + title should be present (no description <p>)
    const ps = container.querySelectorAll('p')
    expect(ps).toHaveLength(1)
    expect(ps[0].textContent).toBe('empty')
  })

  it('renders action slot when provided', () => {
    render(
      <InlineEmptyState
        icon={<Inbox />}
        title="empty"
        action={<button type="button">retry</button>}
      />
    )
    expect(screen.getByRole('button', { name: 'retry' })).toBeInTheDocument()
  })
})
