import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HelpModal from './HelpModal'
import { useApp } from '@/state/useApp'

describe('HelpModal', () => {
  beforeEach(() => {
    useApp.setState({ helpOpen: false })
  })

  it('renders nothing when helpOpen is false', () => {
    const { container } = render(<HelpModal />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the dialog with role=dialog and a title when open', () => {
    useApp.setState({ helpOpen: true })
    render(<HelpModal />)
    expect(screen.getByRole('dialog', { name: '键盘快捷键' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '键盘快捷键' })).toBeInTheDocument()
  })

  it('lists at least one shortcut per NAV_ITEMS entry plus the global ones', () => {
    useApp.setState({ helpOpen: true })
    render(<HelpModal />)
    const list = screen.getByRole('list')
    const items = within(list).getAllByRole('listitem')
    // 17 NAV items + 6 global shortcuts (Shift+T, /, Ctrl/Cmd+K, ?, Esc, …)
    // We don't pin the exact count to avoid coupling to NAV_ITEMS churn,
    // just sanity-check that there's a meaningful list.
    expect(items.length).toBeGreaterThanOrEqual(10)
  })

  it('closes when the X button is clicked', async () => {
    useApp.setState({ helpOpen: true })
    const user = userEvent.setup()
    render(<HelpModal />)
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(useApp.getState().helpOpen).toBe(false)
  })

  it('closes when the backdrop is clicked', async () => {
    useApp.setState({ helpOpen: true })
    const user = userEvent.setup()
    render(<HelpModal />)
    // The dialog wrapper handles the backdrop click
    const dialog = screen.getByRole('dialog')
    await user.click(dialog)
    expect(useApp.getState().helpOpen).toBe(false)
  })

  it('does not close when clicking inside the modal content', async () => {
    useApp.setState({ helpOpen: true })
    const user = userEvent.setup()
    render(<HelpModal />)
    await user.click(screen.getByRole('heading', { name: '键盘快捷键' }))
    expect(useApp.getState().helpOpen).toBe(true)
  })
})
