import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ShimmerCard from './ShimmerCard'

describe('ShimmerCard', () => {
  it('renders children', () => {
    render(<ShimmerCard>card body</ShimmerCard>)
    expect(screen.getByText('card body')).toBeInTheDocument()
  })

  it('applies default variant and md padding classes', () => {
    render(<ShimmerCard data-testid="card">x</ShimmerCard>)
    const el = screen.getByTestId('card')
    expect(el.className).toMatch(/border/)
    expect(el.className).toMatch(/p-4/)
    expect(el.className).not.toMatch(/card-hover/)
    expect(el.className).not.toMatch(/press/)
    expect(el.className).not.toMatch(/fade-in/)
  })

  it('applies variant=accent classes', () => {
    render(<ShimmerCard data-testid="card" variant="accent">x</ShimmerCard>)
    const cls = screen.getByTestId('card').className
    expect(cls).toMatch(/card-glass/)
    expect(cls).toMatch(/hover:border-\[var\(--accent\)\]/)
  })

  it('applies variant=outlined dashed border', () => {
    render(<ShimmerCard data-testid="card" variant="outlined">x</ShimmerCard>)
    expect(screen.getByTestId('card').className).toMatch(/border-dashed/)
  })

  it('applies padding scale', () => {
    const { rerender } = render(<ShimmerCard data-testid="card" padding="none">x</ShimmerCard>)
    expect(screen.getByTestId('card').className).toMatch(/\bp-0\b/)

    rerender(<ShimmerCard data-testid="card" padding="lg">x</ShimmerCard>)
    expect(screen.getByTestId('card').className).toMatch(/p-6/)
  })

  it('adds hoverable/pressable/animate classes when requested', () => {
    render(
      <ShimmerCard data-testid="card" hoverable pressable animate>
        x
      </ShimmerCard>
    )
    const cls = screen.getByTestId('card').className
    expect(cls).toMatch(/card-hover/)
    expect(cls).toMatch(/press/)
    expect(cls).toMatch(/fade-in/)
  })

  it('applies border-glow class when glow=true', () => {
    render(<ShimmerCard data-testid="card" glow>x</ShimmerCard>)
    expect(screen.getByTestId('card').className).toMatch(/border-glow/)
  })

  it('forwards extra HTML attributes to the underlying div', () => {
    render(
      <ShimmerCard data-testid="card" role="region" aria-label="stats">
        x
      </ShimmerCard>
    )
    const el = screen.getByTestId('card')
    expect(el).toHaveAttribute('role', 'region')
    expect(el).toHaveAttribute('aria-label', 'stats')
  })

  it('merges a custom className', () => {
    render(<ShimmerCard data-testid="card" className="custom">x</ShimmerCard>)
    expect(screen.getByTestId('card').className).toMatch(/custom/)
  })
})
