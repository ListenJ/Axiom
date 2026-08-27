import { motion } from 'framer-motion'
import type { ReactNode } from 'react'
import { staggerContainer, staggerItem } from '@/lib/motion-presets'
import { useMotion } from '@/hooks/useMotion'

interface StaggerProps {
  children: ReactNode
  /** 相邻子项的入场间隔（秒） */
  staggerDelay?: number
  className?: string
}

/** 子项入场变体 —— 配合 <Stagger> 使用：子元素须为 motion 组件并传 variants={staggerItem} */
export { staggerItem }

/** 子项交错入场容器；动效关闭时直接静态渲染 */
export default function Stagger({ children, staggerDelay = 0.05, className }: StaggerProps) {
  const { enabled } = useMotion()
  if (!enabled) {
    return <div className={className}>{children}</div>
  }
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="show"
      variants={staggerContainer({ staggerDelay })}
    >
      {children}
    </motion.div>
  )
}