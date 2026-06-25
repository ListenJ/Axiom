import { useEffect } from 'react'
import { useApp } from '@/state/useApp'

export function useTheme() {
  const theme = useApp((s) => s.theme)
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0f0f11' : '#f8fafc')
  }, [theme])
}
