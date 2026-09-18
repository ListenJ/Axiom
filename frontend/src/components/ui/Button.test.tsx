import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Button from './Button'

describe('Button', () => {
  it('renders children and is a button by default', () => {
    render(<Button>Click me</Button>)
    const btn = screen.getByRole('button', { name: 'Click me' })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('type', 'button')
  })

  it('respects an explicit type prop', () => {
    render(<Button type="submit">Submit</Button>)
    expect(screen.getByRole('button', { name: 'Submit' })).toHaveAttribute('type', 'submit')
  })

  it('fires onClick when clicked', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(<Button onClick={onClick}>Go</Button>)
    await user.click(screen.getByRole('button', { name: 'Go' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('is disabled when disabled prop is set', () => {
    render(<Button disabled>Off</Button>)
    expect(screen.getByRole('button', { name: 'Off' })).toBeDisabled()
  })

  it('is disabled and hides icon when loading', () => {
    render(<Button loading icon={<span data-testid="icon" />}>Save</Button>)
    const btn = screen.getByRole('button', { name: /Save/ })
    expect(btn).toBeDisabled()
    // When loading, the icon is replaced by a spinner span
    expect(screen.queryByTestId('icon')).not.toBeInTheDocument()
  })

  it('renders icon when not loading', () => {
    render(<Button icon={<span data-testid="icon" />}>Save</Button>)
    expect(screen.getByTestId('icon')).toBeInTheDocument()
  })

  it('applies size and variant classes', () => {
    render(
      <Button size="sm" variant="secondary" data-testid="btn">
        Small
      </Button>
    )
    const btn = screen.getByTestId('btn')
    expect(btn.className).toMatch(/h-8/) // sm size
    expect(btn.className).toMatch(/accent-soft/) // secondary is tonal (accent-soft)
  })

  it('merges a custom className', () => {
    render(
      <Button className="custom-class" data-testid="btn">
        x
      </Button>
    )
    expect(screen.getByTestId('btn').className).toMatch(/custom-class/)
  })
})
