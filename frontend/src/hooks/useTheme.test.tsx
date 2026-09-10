import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useTheme } from './useTheme'
import { useApp } from '@/state/useApp'

describe('useTheme', () => {
  beforeEach(() => {
    useApp.setState({ theme: 'dark' })
    document.documentElement.removeAttribute('data-theme')
    document.querySelector('meta[name="theme-color"]')?.removeAttribute('content')
  })

  function Themed() {
    useTheme()
    return null
  }

  it('sets data-theme on document root to current theme', () => {
    render(<Themed />)
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('updates data-theme when theme changes', () => {
    const { rerender } = render(<Themed />)
    useApp.setState({ theme: 'light' })
    rerender(<Themed />)
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('updates meta theme-color when present', () => {
    let meta = document.querySelector('meta[name="theme-color"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'theme-color')
      document.head.appendChild(meta)
    }
    const { rerender } = render(<Themed />)
    expect(meta.getAttribute('content')).toBe('#0f0f11')
    useApp.setState({ theme: 'light' })
    rerender(<Themed />)
    expect(meta.getAttribute('content')).toBe('#f8fafc')
  })

  it('resolves system theme to dark fallback when matchMedia is unavailable', () => {
    useApp.setState({ theme: 'system' })
    render(<Themed />)
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('system theme follows matchMedia preference when available', () => {
    useApp.setState({ theme: 'system' })
    const listeners: Array<() => void> = []
    const mq = {
      matches: true,
      addEventListener: (_: string, cb: () => void) => listeners.push(cb),
      removeEventListener: () => {},
    }
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mq))
    render(<Themed />)
    expect(document.documentElement.dataset.theme).toBe('light')
    // 模拟系统偏好变化 → 无需重渲染即更新
    mq.matches = false
    listeners.forEach((cb) => cb())
    expect(document.documentElement.dataset.theme).toBe('dark')
    vi.unstubAllGlobals()
  })
})
