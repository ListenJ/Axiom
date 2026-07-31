/**
 * FisheyeNav — 会话鱼眼导航（高性能实现）
 *
 * 四层性能优化（与 fisheye-math.ts 配合）：
 *   1. 架构级：Ref + requestAnimationFrame 直写 DOM，绕过 React 渲染周期
 *      —— mousemove 只更新 ref 变量，rAF 帧内批量写 style，不触发 setState。
 *   2. 算法级：位置缓存 —— 挂载/会话变化时一次性记录圆点中心（offsetTop），
 *      每帧仅 1 次容器 getBoundingClientRect 做视口增量修正，不做 N 次布局读取。
 *   3. 性能级：切尾剔除 —— 距离 >= RANGE 直接重置样式，不参与高斯幂运算。
 *   4. 渲染级：只改 width（合成属性）+ will-change: width 提示独立层，
 *      不触碰 height/top/margin 避免回流。
 *
 * 交互：点击圆点加载会话（onSelect），选中态 500ms 高亮；圆点 aria-label 可达。
 */
import { useEffect, useRef, useState } from 'react'
import { gaussianFactor } from './fisheye-math'
import type { ChatSession } from '@/components/chat-sessions-sidebar'

export interface FisheyeNavProps {
  sessions: ChatSession[]
  activeSession: string | null
  onSelect: (sessionId: string) => void
}

/** 常态圆点直径（px） */
const DOT_MIN_W = 6
/** 中心展开最大宽度（px）——用户约束：精准行展开为全宽卡片 */
const DOT_MAX_W = 200
/** 影响半径（px），超出即切尾，约 5-9 行 */
const RANGE = 120
/** 显示文字的宽度阈值（px） */
const LABEL_THRESHOLD = 60

export function FisheyeNav({ sessions, activeSession, onSelect }: FisheyeNavProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dotElsRef = useRef<(HTMLDivElement | null)[]>([])
  const labelElsRef = useRef<(HTMLSpanElement | null)[]>([])
  /** 圆点中心相对容器顶部的偏移（初始化缓存一次） */
  const posCacheRef = useRef<number[]>([])
  const mouseYRef = useRef<number | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 位置缓存：会话列表变化时一次性计算（offsetTop 相对容器，零滚动干扰）
  useEffect(() => {
    posCacheRef.current = dotElsRef.current.map((el) => {
      if (!el) return 0
      return el.offsetTop + el.offsetHeight / 2
    })
  }, [sessions])

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current)
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    }
  }, [])

  // rAF 帧内批量直写样式（唯一的"渲染"路径）
  const updateDots = () => {
    rafIdRef.current = null
    const mouseY = mouseYRef.current
    const container = containerRef.current
    if (!container || mouseY === null) return
    // 每帧仅 1 次布局读取（视口增量修正）
    const containerTop = container.getBoundingClientRect().top
    dotElsRef.current.forEach((el, i) => {
      if (!el) return
      const centerY = containerTop + (posCacheRef.current[i] ?? el.offsetTop + el.offsetHeight / 2)
      const distance = Math.abs(mouseY - centerY)
      if (distance >= RANGE) {
        // 切尾：直接重置，不做幂运算
        el.style.width = `${DOT_MIN_W}px`
        el.style.opacity = '0.5'
        const label = labelElsRef.current[i]
        if (label) label.style.opacity = '0'
        return
      }
      const factor = gaussianFactor(distance, RANGE)
      const width = DOT_MIN_W + (DOT_MAX_W - DOT_MIN_W) * factor
      el.style.width = `${width}px`
      el.style.opacity = factor > 0.9 ? '1' : '0.5'
      // 精准行（展开超过阈值）显示标签：文案随圆点展开而呈现
      const label = labelElsRef.current[i]
      if (label) label.style.opacity = width > LABEL_THRESHOLD ? '1' : '0'
    })
  }

  const scheduleUpdate = () => {
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(updateDots)
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    mouseYRef.current = e.clientY
    scheduleUpdate()
  }

  const handleMouseLeave = () => {
    mouseYRef.current = null
    // 离开区域：立即重置所有圆点为常态
    dotElsRef.current.forEach((el, i) => {
      if (!el) return
      el.style.width = `${DOT_MIN_W}px`
      el.style.opacity = '0.5'
      const label = labelElsRef.current[i]
      if (label) label.style.opacity = '0'
    })
  }

  const handleSelect = (sessionId: string) => {
    onSelect(sessionId)
    setHighlightId(sessionId)
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = setTimeout(() => setHighlightId(null), 500)
  }

  return (
    <div
      ref={containerRef}
      role="navigation"
      aria-label="会话鱼眼导航"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className="flex w-5 shrink-0 flex-col items-center gap-3 overflow-hidden border-r border-[var(--border)] bg-[var(--surface)] py-4"
    >
      {sessions.map((s, i) => {
        const isActive = activeSession === s.session_id
        const isHighlighted = highlightId === s.session_id
        return (
          <button
            key={s.session_id}
            type="button"
            onClick={() => handleSelect(s.session_id)}
            aria-label={`会话 ${s.session_id.slice(0, 16)}`}
            aria-current={isActive ? 'true' : undefined}
            className={`group relative h-6 w-full shrink-0 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] ${
              isHighlighted ? 'ring-2 ring-[var(--accent)]' : ''
            }`}
          >
            <div
              ref={(el) => {
                dotElsRef.current[i] = el
              }}
              className="absolute left-1 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[var(--accent)] transition-opacity duration-100 will-change-[width]"
              style={{
                width: `${DOT_MIN_W}px`,
                opacity: isActive ? '1' : '0.5',
              }}
            />
            {/* 标签：宽度展开超过阈值后显示（由 rAF 直写父级宽度驱动） */}
            <span
              ref={(el) => {
                labelElsRef.current[i] = el
              }}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 truncate text-2xs font-medium text-[var(--text)] transition-opacity duration-100"
              style={{ opacity: isActive ? '1' : '0' }}
            >
              {s.session_id.slice(0, 16)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
