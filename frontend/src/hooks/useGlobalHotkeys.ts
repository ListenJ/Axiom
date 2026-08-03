import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '@/state/useApp'
import { NAV_SHORTCUTS, SHORTCUTS, matchShortcut } from '@/lib/shortcuts'

const byId = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s]))

/**
 * Global keyboard shortcuts, mirroring the legacy frontend.
 * 按键定义统一来自 lib/shortcuts.ts 注册表：
 *  - 数字键 / g : jump to the corresponding nav page
 *  - Shift+T   : toggle theme
 *  - / or Ctrl/Cmd+K : focus search page
 *  - Ctrl+`    : toggle terminal
 *  - ?         : open help modal
 *  - Escape    : close help / blur
 */
export function useGlobalHotkeys() {
  const navigate = useNavigate()
  const toggleTheme = useApp((s) => s.toggleTheme)
  const setHelpOpen = useApp((s) => s.setHelpOpen)
  const setSidebarOpen = useApp((s) => s.setSidebarOpen)
  const terminalOpen = useApp((s) => s.terminalOpen)
  const setTerminalOpen = useApp((s) => s.setTerminalOpen)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const isEditable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)

      if (matchShortcut(byId.help, e) && !isEditable) {
        e.preventDefault()
        setHelpOpen(true)
        return
      }

      if (matchShortcut(byId.escape, e)) {
        setHelpOpen(false)
        if (target && target !== document.body && typeof (target as HTMLElement).blur === 'function') {
          ;(target as HTMLElement).blur()
        }
        return
      }

      // 终端栏全局快捷键：Ctrl+` / Ctrl+Shift+` 开合
      if (matchShortcut(byId.terminal, e)) {
        e.preventDefault()
        setTerminalOpen(!terminalOpen)
        return
      }

      if (matchShortcut(byId.theme, e) && !isEditable) {
        e.preventDefault()
        toggleTheme()
        return
      }

      if (matchShortcut(byId['search-ctrl-k'], e) || matchShortcut(byId['search-slash'], e)) {
        if (isEditable) return
        e.preventDefault()
        navigate('/search')
        return
      }

      if (!isEditable) {
        const navTarget = NAV_SHORTCUTS.find((s) => matchShortcut(s, e))
        if (navTarget?.path) {
          e.preventDefault()
          navigate(navTarget.path)
          setSidebarOpen(false)
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, toggleTheme, setHelpOpen, setSidebarOpen, terminalOpen, setTerminalOpen])
}
