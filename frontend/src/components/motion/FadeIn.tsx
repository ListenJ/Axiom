import { motion } from 'framer-motion'
import type { ReactNode } from 'react'
import { MOTION_PRESETS } from '@/lib/motion-presets'
import { useMotion } from '@/hooks/useMotion'

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
  const { enabled } = useMotion()
  if (!enabled) {
    return <div className={className}>{children}</div>
  }
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...MOTION_PRESETS.fadeIn, duration, delay }}
    >
      {children}
    </motion.div>
  )
}
