import { motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'

interface PressableProps {
  children: ReactNode
  className?: string
}

/**
 * 按压反馈容器：hover 微抬升（y: -1），tap 压缩（scale 0.97，gentle spring）。
 * 供 Button 等可交互元素包裹使用；reduced-motion 时直接静态渲染。
 */
export default function Pressable({ children, className }: PressableProps) {
  const reduce = useReducedMotion()
  if (reduce) {
    return <div className={className}>{children}</div>
  }
  return (
    <motion.div
      className={className}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 400, damping: 17 }}
    >
      {children}
    </motion.div>
  )
}
