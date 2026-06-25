import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Toasts from './Toasts'
import { useApp } from '@/state/useApp'

describe('Toasts', () => {
  beforeEach(() => {
    useApp.setState({ toasts: [] })
  })

  it('renders nothing when there are no toasts', () => {
    const { container } = render(<Toasts />)
    expect(container.firstChild?.childNodes).toHaveLength(0)
  })

  it('renders one toast per entry with role=status', () => {
    useApp.setState({
      toasts: [
        { id: 1, type: 'info', message: 'hello' },
        { id: 2, type: 'success', message: 'done' },
      ],
    })
    render(<Toasts />)
    expect(screen.getAllByRole('status')).toHaveLength(2)
    expect(screen.getByText('hello')).toBeInTheDocument()
    expect(screen.getByText('done')).toBeInTheDocument()
  })

  it('dismisses a toast when the close button is clicked', async () => {
    useApp.setState({ toasts: [{ id: 42, type: 'error', message: 'oops' }] })
    const user = userEvent.setup()
    render(<Toasts />)
    const toast = screen.getByRole('status')
    const closeBtn = within(toast).getByRole('button', { name: '关闭通知' })
    await user.click(closeBtn)
    expect(useApp.getState().toasts).toHaveLength(0)
  })

  it('does not auto-dismiss toasts in this component (the store handles it)', () => {
    vi.useFakeTimers()
    useApp.getState().toast('auto-dismiss-test')
    expect(useApp.getState().toasts).toHaveLength(1)
    render(<Toasts />)
    // The store schedules a setTimeout(4000) for dismissal.
    vi.advanceTimersByTime(4000)
    expect(useApp.getState().toasts).toHaveLength(0)
    vi.useRealTimers()
  })
})
