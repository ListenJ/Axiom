import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useApp } from './useApp'

describe('useApp store', () => {
  beforeEach(() => {
    useApp.setState({
      theme: 'dark',
      sidebarOpen: false,
      helpOpen: false,
      toasts: [],
    })
    localStorage.clear()
  })

  describe('theme', () => {
    it('defaults to dark when no localStorage entry', () => {
      expect(useApp.getState().theme).toBe('dark')
    })

    it('setTheme updates state and persists to localStorage', () => {
      useApp.getState().setTheme('light')
      expect(useApp.getState().theme).toBe('light')
      expect(localStorage.getItem('openclaw:theme')).toBe('light')
    })

    it('toggleTheme flips dark <-> light', () => {
      useApp.getState().setTheme('dark')
      useApp.getState().toggleTheme()
      expect(useApp.getState().theme).toBe('light')
      useApp.getState().toggleTheme()
      expect(useApp.getState().theme).toBe('dark')
    })
  })

  describe('sidebar', () => {
    it('opens and closes', () => {
      useApp.getState().setSidebarOpen(true)
      expect(useApp.getState().sidebarOpen).toBe(true)
      useApp.getState().setSidebarOpen(false)
      expect(useApp.getState().sidebarOpen).toBe(false)
    })
  })

  describe('help', () => {
    it('opens and closes', () => {
      useApp.getState().setHelpOpen(true)
      expect(useApp.getState().helpOpen).toBe(true)
      useApp.getState().setHelpOpen(false)
      expect(useApp.getState().helpOpen).toBe(false)
    })
  })

  describe('toasts', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('toast adds an entry with auto-incrementing id', () => {
      useApp.getState().toast('hello')
      useApp.getState().toast('world', 'success')
      const toasts = useApp.getState().toasts
      expect(toasts).toHaveLength(2)
      expect(toasts[0]).toMatchObject({ message: 'hello', type: 'info' })
      expect(toasts[1]).toMatchObject({ message: 'world', type: 'success' })
      expect(toasts[0].id).not.toBe(toasts[1].id)
    })

    it('toast defaults to info type', () => {
      useApp.getState().toast('default type')
      expect(useApp.getState().toasts[0].type).toBe('info')
    })

    it('toast auto-dismisses after 4000ms', () => {
      useApp.getState().toast('auto-dismiss')
      expect(useApp.getState().toasts).toHaveLength(1)
      vi.advanceTimersByTime(4000)
      expect(useApp.getState().toasts).toHaveLength(0)
    })

    it('dismissToast removes the specific toast by id', () => {
      useApp.getState().toast('keep')
      const keepId = useApp.getState().toasts[0].id
      useApp.getState().toast('drop')
      const dropId = useApp.getState().toasts[1].id
      useApp.getState().dismissToast(dropId)
      const remaining = useApp.getState().toasts
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe(keepId)
    })
  })
})
