import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'

interface IntroOutlineProps {
  /** 勾勒 + 淡出全部完成（或 reduced-motion 立即）后回调 */
  onDone: () => void
  /** 用户点击 / 按键跳过；缺省时等同于 onDone */
  onSkip?: () => void
  /** 单段描边时长（秒），测试可缩短 */
  drawDuration?: number
  /** 相邻描边的间隔（秒） */
  staggerDelay?: number
  /** 线框淡出时长（秒） */
  fadeDuration?: number
}

/** 布局轮廓：侧边栏 / Header / 标题条 / 卡片×4 / 输入框（viewBox 1200×800） */
const SHAPES: Array<{ x: number; y: number; width: number; height: number; rx: number; glow?: boolean }> = [
  { x: 16, y: 16, width: 240, height: 768, rx: 16 },
  { x: 268, y: 16, width: 916, height: 56, rx: 14 },
  { x: 300, y: 260, width: 600, height: 44, rx: 10, glow: true },
  { x: 160, y: 340, width: 400, height: 120, rx: 14, glow: true },
  { x: 620, y: 340, width: 400, height: 120, rx: 14, glow: true },
  { x: 160, y: 480, width: 400, height: 120, rx: 14, glow: true },
  { x: 620, y: 480, width: 400, height: 120, rx: 14, glow: true },
  { x: 340, y: 660, width: 520, height: 56, rx: 16 },
]

/**
 * 落地页开场：全屏 SVG 线框依次描边勾勒应用布局（pathLength 0→1），
 * 勾勒完成后整体淡出。点击 / 任意按键可跳过；reduced-motion 立即结束。
 */
export default function IntroOutline({
  onDone,
  onSkip,
  drawDuration = 0.6,
  staggerDelay = 0.12,
  fadeDuration = 0.55,
}: IntroOutlineProps) {
  const reduce = useReducedMotion()
  const [fading, setFading] = useState(false)
  const skip = onSkip ?? onDone

  // reduced-motion：不渲染线框，立即结束
  useEffect(() => {
    if (reduce) onDone()
  }, [reduce, onDone])

  // 任意按键跳过
  useEffect(() => {
    if (reduce) return
    const onKey = () => skip()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reduce, skip])

  // 兜底定时器：动画回调因任何原因未触发时保证覆盖层不会残留
  useEffect(() => {
    if (reduce) return
    const total = (drawDuration + staggerDelay * (SHAPES.length - 1) + fadeDuration + 0.4) * 1000
    const t = window.setTimeout(onDone, total)
    return () => window.clearTimeout(t)
  }, [reduce, drawDuration, staggerDelay, fadeDuration, onDone])

  if (reduce) return null

  return (
    <motion.div
      role="presentation"
      aria-hidden="true"
      onClick={skip}
      className="fixed inset-0 z-[100] cursor-pointer bg-[var(--bg)]"
      initial={{ opacity: 1 }}
      animate={{ opacity: fading ? 0 : 1 }}
      transition={{ duration: fadeDuration, ease: 'easeInOut' }}
      onAnimationComplete={() => {
        if (fading) onDone()
      }}
    >
      <svg
        viewBox="0 0 1200 800"
        preserveAspectRatio="xMidYMid slice"
        className="h-full w-full"
        style={{ filter: 'drop-shadow(0 0 8px rgba(245, 158, 11, 0.45))' }}
      >
        <defs>
          <linearGradient id="intro-stroke" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--accent)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--accent-strong)' }} />
          </linearGradient>
        </defs>
        {SHAPES.map((s, i) => (
          <motion.rect
            key={i}
            x={s.x}
            y={s.y}
            width={s.width}
            height={s.height}
            rx={s.rx}
            fill="none"
            stroke="url(#intro-stroke)"
            strokeWidth={2}
            strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={s.glow ? { pathLength: 1, opacity: [0.5, 1, 0.5] } : { pathLength: 1 }}
            transition={
              s.glow
                ? {
                    pathLength: { duration: drawDuration, delay: i * staggerDelay, ease: 'easeInOut' },
                    opacity: {
                      duration: 1.6,
                      delay: i * staggerDelay + drawDuration,
                      ease: 'easeInOut',
                      repeat: Infinity,
                      repeatType: 'mirror',
                    },
                  }
                : { duration: drawDuration, delay: i * staggerDelay, ease: 'easeInOut' }
            }
            onAnimationComplete={i === SHAPES.length - 1 ? () => setFading(true) : undefined}
          />
        ))}
      </svg>
      <p className="absolute bottom-6 left-0 right-0 text-center text-xs text-[var(--text-muted)]">
        点击任意处跳过
      </p>
    </motion.div>
  )
}
