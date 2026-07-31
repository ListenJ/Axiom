import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIntro, INTRO_STORAGE_KEY } from './useIntro'

// setup.ts 会在每个用例后清空 localStorage

describe('useIntro', () => {
  afterEach(() => {
    // reduced-motion 用例会注入 matchMedia，用完还原，避免影响其它用例
    delete (window as { matchMedia?: unknown }).matchMedia
  })

  it('首访（无标记）时 showIntro 为 true', () => {
    const { result } = renderHook(() => useIntro())
    expect(result.current.showIntro).toBe(true)
  })

  it('已标记过时 showIntro 为 false', () => {
    localStorage.setItem(INTRO_STORAGE_KEY, '1')
    const { result } = renderHook(() => useIntro())
    expect(result.current.showIntro).toBe(false)
  })

  it('skip 置标记并结束动画', () => {
    const { result } = renderHook(() => useIntro())
    act(() => result.current.skip())
    expect(localStorage.getItem(INTRO_STORAGE_KEY)).toBe('1')
    expect(result.current.showIntro).toBe(false)
  })

  it('finish 置标记并结束动画', () => {
    const { result } = renderHook(() => useIntro())
    act(() => result.current.finish())
    expect(localStorage.getItem(INTRO_STORAGE_KEY)).toBe('1')
    expect(result.current.showIntro).toBe(false)
  })

  // 放在最后：本用例注入的 matchMedia 在 afterEach 中还原
  it('prefers-reduced-motion 时直接跳过动画', () => {
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    const { result } = renderHook(() => useIntro())
    expect(result.current.showIntro).toBe(false)
  })
})
