import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import LoadingDots from './LoadingDots'

describe('LoadingDots', () => {
  it('renders with default aria-label', () => {
    render(<LoadingDots />)
    expect(screen.getByRole('status', { name: '加载中' })).toBeInTheDocument()
  })

  it('uses a custom label when provided', () => {
    render(<LoadingDots label="正在加载数据" />)
    expect(screen.getByRole('status', { name: '正在加载数据' })).toBeInTheDocument()
  })

  it('renders three animated dot spans', () => {
    const { container } = render(<LoadingDots />)
    const dots = container.querySelectorAll('span.animate-pulse')
    expect(dots).toHaveLength(3)
  })

  it('renders label text in addition to aria-label when provided', () => {
    render(<LoadingDots label="saving" />)
    expect(screen.getByText('saving')).toBeInTheDocument()
  })
})
