import { useReducedMotion } from 'framer-motion'
import { useMotionPrefs } from '@/state/useMotionPrefs'

/**
 * 统一动效开关，替代组件内直接调用 useReducedMotion：
 *  - system：跟随 prefers-reduced-motion
 *  - reduced：强制静态渲染（减少动画）
 *  - off：关闭全部动效
 */
export function useMotion() {
  const level = useMotionPrefs((s) => s.level)
  const systemReduce = useReducedMotion()
  const enabled =
    level !== 'off' && !(level === 'reduced' || (level === 'system' && systemReduce === true))
  return { level, enabled }
}
