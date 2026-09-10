/**
 * 全局动效预设 — 动画流程的单一事实来源。
 *
 * 所有 framer-motion 组件必须消费这里的时长/缓动/变体，禁止在组件内
 * 硬编码 duration/ease。数值与 frontend/docs/FRONTEND-DESIGN.md 2.5 Motion
 * 对齐：fast=150ms（悬停/按压）、normal=220ms（展开/切换）、slow=320ms（页面过渡）。
 */

export const MOTION_DURATIONS = {
  /** 悬停、按压反馈 */
  fast: 0.15,
  /** 展开、切换、路由级过渡 */
  normal: 0.22,
  /** 页面/入场类过渡 */
  slow: 0.32,
} as const

export const MOTION_EASES = {
  /** 进入：快速出 */
  out: [0.16, 1, 0.3, 1] as const,
  /** 退出：快速入 */
  in: [0.4, 0, 1, 1] as const,
  /** 中性标准曲线（覆盖式浮层等） */
  standard: [0.25, 0.46, 0.45, 0.94] as const,
} as const

export const MOTION_PRESETS = {
  /** FadeIn / 交错子项入场 */
  fadeIn: { duration: MOTION_DURATIONS.slow, ease: MOTION_EASES.out },
  /** 路由级页面过渡 */
  pageEnter: { duration: MOTION_DURATIONS.normal, ease: MOTION_EASES.out },
  /** 进入视口渐显 */
  reveal: { duration: 0.4, ease: MOTION_EASES.out },
  /** 折叠展开/chevron 旋转 */
  collapse: { duration: 0.18, ease: MOTION_EASES.out },
  /** 覆盖式浮层（终端栏） */
  slideUp: { duration: 0.28, ease: MOTION_EASES.standard },
  /** 按压/悬停反馈（spring） */
  press: { type: 'spring', stiffness: 400, damping: 17 } as const,
} as const

/** 交错入场的子项变体 */
export const staggerItem = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: MOTION_PRESETS.fadeIn },
} as const

export interface StaggerContainerOptions {
  /** 相邻子项的入场间隔（秒） */
  staggerDelay?: number
}

/** 交错入场的容器变体 */
export function staggerContainer({ staggerDelay = 0.05 }: StaggerContainerOptions = {}) {
  return {
    hidden: {},
    show: { transition: { staggerChildren: staggerDelay } },
  }
}
