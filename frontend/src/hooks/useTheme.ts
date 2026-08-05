import { useEffect } from 'react'
import { useApp } from '@/state/useApp'
import { applyAccent } from '@/lib/accents'

export function useTheme() {
  const theme = useApp((s) => s.theme)
  const accent = useApp((s) => s.accent)
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0f0f11' : '#f8fafc')
    // 强调色预设覆盖（amber 为默认值，仍重复应用保证一致性）
    applyAccent(accent, theme)
  }, [theme, accent])
}
