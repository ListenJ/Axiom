import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PageHeader from './PageHeader'
import { Activity } from 'lucide-react'

describe('PageHeader', () => {
  it('renders title and icon', () => {
    render(<PageHeader icon={<Activity data-testid="icon" />} title="性能" />)
    expect(screen.getByRole('heading', { name: '性能' })).toBeInTheDocument()
    expect(screen.getByTestId('icon')).toBeInTheDocument()
  })

  it('renders description and subtitle when provided', () => {
    render(
      <PageHeader
        icon={<Activity />}
        title="性能"
        description="运行时指标"
        subtitle="最近 1 小时"
      />
    )
    expect(screen.getByText('运行时指标')).toBeInTheDocument()
    expect(screen.getByText('最近 1 小时')).toBeInTheDocument()
  })

  it('omits description and subtitle when not provided', () => {
    const { container } = render(<PageHeader icon={<Activity />} title="x" />)
    // No <p> elements inside the header content area when neither is given.
    const ps = container.querySelectorAll('p')
    expect(ps).toHaveLength(0)
  })

  it('renders actions slot on the right', () => {
    render(
      <PageHeader
        icon={<Activity />}
        title="x"
        actions={<button type="button">refresh</button>}
      />
    )
    expect(screen.getByRole('button', { name: 'refresh' })).toBeInTheDocument()
  })
})
