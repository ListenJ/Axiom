import { useEffect } from 'react'
import { useApp, resolveTheme } from '@/state/useApp'
import { applyAccent } from '@/lib/accents'

export function useTheme() {
  const theme = useApp((s) => s.theme)
  const accent = useApp((s) => s.accent)

  useEffect(() => {
    const root = document.documentElement
    const resolved = resolveTheme(theme)
    root.dataset.theme = resolved
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0f0f11' : '#f8fafc')
    // 强调色预设覆盖（amber 为默认值，仍重复应用保证一致性）
    applyAccent(accent, resolved)
  }, [theme, accent])

  // system 模式下跟随系统偏好实时变化（深/浅切换无需刷新）
  useEffect(() => {
    if (theme !== 'system') return
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => {
      const root = document.documentElement
      const resolved = mq.matches ? 'light' : 'dark'
      root.dataset.theme = resolved
      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0f0f11' : '#f8fafc')
      applyAccent(useApp.getState().accent, resolved)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])
}
