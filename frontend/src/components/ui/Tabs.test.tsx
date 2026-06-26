import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Tabs from './Tabs'

const tabs = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma', badge: 5 },
]

describe('Tabs', () => {
  it('renders one tab per entry', () => {
    render(<Tabs tabs={tabs} active="a" onChange={() => {}} />)
    expect(screen.getAllByRole('tab')).toHaveLength(3)
  })

  it('marks the active tab with aria-selected=true', () => {
    render(<Tabs tabs={tabs} active="b" onChange={() => {}} />)
    const active = screen.getByRole('tab', { name: 'Beta' })
    expect(active).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'false')
  })

  it('invokes onChange with the clicked tab id', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Tabs tabs={tabs} active="a" onChange={onChange} />)
    // Gamma's accessible name includes the badge number ("Gamma5"),
    // so match the label start instead of an exact name.
    await user.click(screen.getByRole('tab', { name: /^Gamma/ }))
    expect(onChange).toHaveBeenCalledWith('c')
  })

  it('renders badge when provided', () => {
    render(<Tabs tabs={tabs} active="a" onChange={() => {}} />)
    const gamma = screen.getByRole('tab', { name: /Gamma/ })
    expect(gamma).toHaveTextContent('5')
  })

  it('omits badge when not provided', () => {
    const noBadge = [{ id: 'a', label: 'Solo' }]
    render(<Tabs tabs={noBadge} active="a" onChange={() => {}} />)
    const tab = screen.getByRole('tab', { name: 'Solo' })
    expect(tab.textContent).toBe('Solo')
  })
})
