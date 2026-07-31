import { motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'

interface StaggerProps {
  children: ReactNode
  /** 相邻子项的入场间隔（秒） */
  staggerDelay?: number
  className?: string
}

/** 子项入场变体 —— 配合 <Stagger> 使用：子元素须为 motion 组件并传 variants={staggerItem} */
export const staggerItem = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.16, 1, 0.3, 1] as const } },
}

/** 子项交错入场容器；reduced-motion 时直接静态渲染 */
export default function Stagger({ children, staggerDelay = 0.05, className }: StaggerProps) {
  const reduce = useReducedMotion()
  if (reduce) {
    return <div className={className}>{children}</div>
  }
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: staggerDelay } },
      }}
    >
      {children}
    </motion.div>
  )
}
