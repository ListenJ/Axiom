import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import StatCard from './StatCard'
import { Activity } from 'lucide-react'

describe('StatCard', () => {
  it('renders label and value', () => {
    render(<StatCard label="CPU" value="42%" />)
    expect(screen.getByText('CPU')).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  it('renders hint when provided', () => {
    render(<StatCard label="CPU" value="42%" hint="uptime 1d" />)
    expect(screen.getByText('uptime 1d')).toBeInTheDocument()
  })

  it('renders icon when provided', () => {
    render(<StatCard label="CPU" value="42%" icon={<Activity data-testid="icon" />} />)
    expect(screen.getByTestId('icon')).toBeInTheDocument()
  })

  it('shows a skeleton in place of value when loading', () => {
    render(<StatCard label="CPU" value="42%" loading />)
    expect(screen.queryByText('42%')).not.toBeInTheDocument()
    expect(screen.getByText('CPU')).toBeInTheDocument()
    expect(document.querySelector('.skeleton')).toBeInTheDocument()
  })
})
