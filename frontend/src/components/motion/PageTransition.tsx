import { motion } from 'framer-motion'
import type { ReactNode } from 'react'
import { MOTION_PRESETS } from '@/lib/motion-presets'
import { useMotion } from '@/hooks/useMotion'

interface PageTransitionProps {
  children: ReactNode
  className?: string
}

/** 路由级页面入场：淡入 + 微位移；reduced-motion 时直接静态渲染 */
export default function PageTransition({ children, className }: PageTransitionProps) {
  const { enabled } = useMotion()
  if (!enabled) {
    return <div className={className}>{children}</div>
  }
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={MOTION_PRESETS.pageEnter}
    >
      {children}
    </motion.div>
  )
}
