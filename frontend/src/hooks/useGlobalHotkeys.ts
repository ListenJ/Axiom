import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '@/state/useApp'
import { VISIBLE_NAV_ITEMS } from '@/lib/nav'

/**
 * Global keyboard shortcuts, mirroring the legacy frontend.
 *  - 0..9      : jump to the corresponding nav page
 *  - Shift+T   : toggle theme
 *  - / or Ctrl/Cmd+K : focus search page
 *  - ?         : open help modal
 *  - Escape    : close help / blur
 */
export function useGlobalHotkeys() {
  const navigate = useNavigate()
  const toggleTheme = useApp((s) => s.toggleTheme)
  const setHelpOpen = useApp((s) => s.setHelpOpen)
  const setSidebarOpen = useApp((s) => s.setSidebarOpen)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const isEditable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)

      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !isEditable) {
        e.preventDefault()
        setHelpOpen(true)
        return
      }

      if (e.key === 'Escape') {
        setHelpOpen(false)
        if (target && target !== document.body && typeof (target as HTMLElement).blur === 'function') {
          ;(target as HTMLElement).blur()
        }
        return
      }

      if (e.key === 'T' && e.shiftKey && !isEditable) {
        e.preventDefault()
        toggleTheme()
        return
      }

      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !e.ctrlKey && !e.metaKey)) {
        if (isEditable) return
        e.preventDefault()
        navigate('/search')
        return
      }

      if (!e.ctrlKey && !e.metaKey && !e.altKey && !isEditable) {
        if (e.key >= '0' && e.key <= '9') {
          const idx = Number(e.key)
          const target = VISIBLE_NAV_ITEMS[idx]
          if (target) {
            e.preventDefault()
            navigate(target.path)
            setSidebarOpen(false)
          }
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, toggleTheme, setHelpOpen, setSidebarOpen])
}
