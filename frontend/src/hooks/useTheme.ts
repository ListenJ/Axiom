import { useEffect } from 'react'
import { useApp, resolveTheme } from '@/state/useApp'
import { applyAccent, applyLayerTones } from '@/lib/accents'

export function useTheme() {
  const theme = useApp((s) => s.theme)
  const accent = useApp((s) => s.accent)
  const shellTone = useApp((s) => s.shellTone)
  const canvasTone = useApp((s) => s.canvasTone)

  useEffect(() => {
    const root = document.documentElement
    const resolved = resolveTheme(theme)
    root.dataset.theme = resolved
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0f0f11' : '#f8fafc')
    // 强调色 + 层级色调覆盖（保证与持久化状态一致）
    applyAccent(accent, resolved)
    applyLayerTones(shellTone, canvasTone, resolved)
  }, [theme, accent, shellTone, canvasTone])

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
      applyLayerTones(useApp.getState().shellTone, useApp.getState().canvasTone, resolved)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])
}
