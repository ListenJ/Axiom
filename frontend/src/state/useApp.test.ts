import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useApp, readInitialTheme } from './useApp'

describe('useApp store', () => {
  beforeEach(() => {
    useApp.setState({
      theme: 'dark',
      sidebarOpen: false,
      helpOpen: false,
      terminalOpen: false,
      rightbarOpen: true,
      rightbarTool: 'summary',
      toasts: [],
    })
    localStorage.clear()
  })

  describe('theme', () => {
    it('defaults to dark when no localStorage entry', () => {
      expect(useApp.getState().theme).toBe('dark')
    })

    it('readInitialTheme returns dark when nothing stored and keeps explicit light', () => {
      localStorage.removeItem('axiom:theme')
      expect(readInitialTheme()).toBe('dark')
      localStorage.setItem('axiom:theme', 'light')
      expect(readInitialTheme()).toBe('light')
      localStorage.setItem('axiom:theme', 'system')
      expect(readInitialTheme()).toBe('system')
    })

    it('setTheme updates state and persists to localStorage', () => {
      useApp.getState().setTheme('light')
      expect(useApp.getState().theme).toBe('light')
      expect(localStorage.getItem('axiom:theme')).toBe('light')
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

  describe('terminal', () => {
    it('opens and closes', () => {
      useApp.getState().setTerminalOpen(true)
      expect(useApp.getState().terminalOpen).toBe(true)
      useApp.getState().setTerminalOpen(false)
      expect(useApp.getState().terminalOpen).toBe(false)
    })
  })

  describe('rightbar', () => {
    it('toggles open/close and tracks the active tool', () => {
      useApp.getState().setRightbarOpen(false)
      expect(useApp.getState().rightbarOpen).toBe(false)
      useApp.getState().setRightbarTool('git')
      expect(useApp.getState().rightbarTool).toBe('git')
      expect(useApp.getState().rightbarOpen).toBe(false)
      useApp.getState().openRightTool('terminal')
      expect(useApp.getState().rightbarTool).toBe('terminal')
      expect(useApp.getState().rightbarOpen).toBe(true)
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
