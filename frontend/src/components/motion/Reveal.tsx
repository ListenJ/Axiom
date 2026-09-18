import { motion } from 'framer-motion'
import type { ReactNode } from 'react'
import { MOTION_PRESETS } from '@/lib/motion-presets'
import { useMotion } from '@/hooks/useMotion'

interface RevealProps {
  children: ReactNode
  /** 初始纵向偏移（px） */
  y?: number
  /** 动画时长（秒） */
  duration?: number
  className?: string
}

/** 进入视口时渐显（once）；reduced-motion 时直接静态渲染 */
export default function Reveal({ children, y = 12, duration = 0.4, className }: RevealProps) {
  const { enabled } = useMotion()
  if (!enabled) {
    return <div className={className}>{children}</div>
  }
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ ...MOTION_PRESETS.reveal, duration }}
    >
      {children}
    </motion.div>
  )
}
