import { motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'

interface FadeInProps {
  children: ReactNode
  /** 入场延迟（秒） */
  delay?: number
  /** 动画时长（秒） */
  duration?: number
  /** 初始纵向偏移（px） */
  y?: number
  className?: string
}

/** 透明度 + 轻微上浮的入场动效；reduced-motion 时直接静态渲染 */
export default function FadeIn({
  children,
  delay = 0,
  duration = 0.32,
  y = 8,
  className,
}: FadeInProps) {
  const reduce = useReducedMotion()
  if (reduce) {
    return <div className={className}>{children}</div>
  }
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  )
}
