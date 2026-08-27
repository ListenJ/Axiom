import { useCallback, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown } from 'lucide-react'
import { MOTION_PRESETS } from '@/lib/motion-presets'
import { useMotion } from '@/hooks/useMotion'

interface CollapsibleProps {
  /** 稳定 id（不传时自动生成），用于 aria-controls 关联 */
  id?: string
  /** 头部图标（lucide 元素） */
  icon?: ReactNode
  /** 标题（必填，可读性优先） */
  title: string
  /** 一句话说明（展示于标题下方） */
  description?: string
  /** 非受控模式下的初始展开状态 */
  defaultOpen?: boolean
  /** 受控模式下的展开状态；传入后组件转为受控 */
  open?: boolean
  /** 展开/收起回调（受控与非受控都会触发） */
  onToggle?: (open: boolean) => void
  /** 展开时渲染的内容 */
  children: ReactNode
  /** 附加到外层 section 的类名（如卡片边框样式） */
  className?: string
}

/**
 * 可折叠区块：图标 + 标题 + 描述 + chevron 指示。
 * 展开动画 180ms（height auto + 透明度），尊重 prefers-reduced-motion。
 */
export default function Collapsible({
  id,
  icon,
  title,
  description,
  defaultOpen = false,
  open,
  onToggle,
  children,
  className = '',
}: CollapsibleProps) {
  const autoId = useId()
  const panelId = id ?? `collapsible-${autoId.replace(/[^a-zA-Z0-9-]/g, '')}`
  const { enabled } = useMotion()
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const isOpen = open ?? internalOpen

  const toggle = useCallback(() => {
    const next = !isOpen
    if (open === undefined) setInternalOpen(next)
    onToggle?.(next)
  }, [isOpen, open, onToggle])

  const transition = enabled
    ? MOTION_PRESETS.collapse
    : { duration: 0 }

  return (
    <section className={className} data-collapsible>
      <button
        type="button"
        id={`${panelId}-trigger`}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={toggle}
      >
        {icon && (
          <span
            className={`flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
              isOpen
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
            }`}
          >
            {icon}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-[var(--text)]">{title}</span>
          {description && (
            <span className="mt-0.5 block text-xs text-[var(--text-secondary)]">{description}</span>
          )}
        </span>
        <motion.span
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)]"
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={transition}
          aria-hidden="true"
        >
          <ChevronDown className="size-4" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            id={panelId}
            role="region"
            aria-labelledby={`${panelId}-trigger`}
            className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={transition}
          >
            <div className="px-3 pb-3 pt-1">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}