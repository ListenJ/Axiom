import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { useGlobalHotkeys } from './useGlobalHotkeys'
import { useApp } from '@/state/useApp'

function App() {
  useGlobalHotkeys()
  return (
    <Routes>
      <Route path="/" element={<div>Home</div>} />
      <Route path="/search" element={<div>Search</div>} />
      <Route path="/chat" element={<div>Chat</div>} />
      <Route path="*" element={<div>{useLocation().pathname}</div>} />
    </Routes>
  )
}

describe('useGlobalHotkeys', () => {
  beforeEach(() => {
    useApp.setState({
      theme: 'dark',
      sidebarOpen: false,
      helpOpen: false,
      toasts: [],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function renderHook(path = '/') {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    )
  }

  function press(key: string, modifiers: Partial<KeyboardEventInit> = {}) {
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...modifiers }))
    })
  }

  it('navigates to /search on / key', async () => {
    renderHook('/')
    expect(screen.getByText('Home')).toBeInTheDocument()
    press('/')
    await waitFor(() => expect(screen.getByText('Search')).toBeInTheDocument())
  })

  it('navigates to /search on Ctrl+K', async () => {
    renderHook('/')
    press('k', { ctrlKey: true })
    await waitFor(() => expect(screen.getByText('Search')).toBeInTheDocument())
  })

  it('opens help on ? key', () => {
    renderHook('/')
    expect(useApp.getState().helpOpen).toBe(false)
    press('?')
    expect(useApp.getState().helpOpen).toBe(true)
  })

  it('closes help on Escape', () => {
    useApp.setState({ helpOpen: true })
    renderHook('/')
    press('Escape')
    expect(useApp.getState().helpOpen).toBe(false)
  })

  it('toggles theme on Shift+T', () => {
    renderHook('/')
    press('T', { shiftKey: true })
    expect(useApp.getState().theme).toBe('light')
  })

  it('navigates via number keys based on visible nav items', async () => {
    renderHook('/')
    press('1')
    await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument())
  })

  it('does not hijack shortcuts inside inputs', async () => {
    renderHook('/')
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))
    })
    await waitFor(() => expect(screen.getByText('Home')).toBeInTheDocument())
    document.body.removeChild(input)
  })
})
