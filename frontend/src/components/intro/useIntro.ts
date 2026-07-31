import { useCallback, useState } from 'react'

/** localStorage 标记：首访播放开场动画，之后跳过 */
export const INTRO_STORAGE_KEY = 'axiom-intro-seen'

function shouldPlayIntro(): boolean {
  if (typeof window === 'undefined') return false
  // prefers-reduced-motion：完全跳过动画（jsdom 无 matchMedia 时按未设置处理）
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false
  } catch {
    /* matchMedia 不可用时继续 */
  }
  try {
    return localStorage.getItem(INTRO_STORAGE_KEY) !== '1'
  } catch {
    return false
  }
}

/**
 * 落地页开场动画状态：showIntro 为 true 时渲染 IntroOutline 覆盖层；
 * finish / skip 均写入 localStorage 标记并结束动画（skip 即提前结束，语义相同）。
 */
export function useIntro() {
  const [showIntro, setShowIntro] = useState(shouldPlayIntro)

  const finish = useCallback(() => {
    try {
      localStorage.setItem(INTRO_STORAGE_KEY, '1')
    } catch {
      /* 隐私模式等场景下忽略写入失败 */
    }
    setShowIntro(false)
  }, [])

  return { showIntro, finish, skip: finish }
}
