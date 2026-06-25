import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Skeleton from './Skeleton'

describe('Skeleton', () => {
  it('renders with role=status and loading aria-label', () => {
    render(<Skeleton />)
    expect(screen.getByRole('status', { name: '加载中' })).toBeInTheDocument()
  })

  it('applies default width and height', () => {
    render(<Skeleton data-testid="sk" />)
    const el = screen.getByTestId('sk')
    expect(el).toHaveStyle({ width: '100%', height: '1rem' })
  })

  it('applies numeric and string width/height', () => {
    render(<Skeleton data-testid="sk" width={120} height={32} />)
    const el = screen.getByTestId('sk')
    expect(el).toHaveStyle({ width: '120px', height: '32px' })
  })

  it('adds rounded-full class when rounded=full', () => {
    render(<Skeleton data-testid="sk" rounded="full" />)
    expect(screen.getByTestId('sk').className).toMatch(/rounded-full/)
  })

  it('merges custom className', () => {
    render(<Skeleton data-testid="sk" className="my-skel" />)
    expect(screen.getByTestId('sk').className).toMatch(/my-skel/)
  })
})
