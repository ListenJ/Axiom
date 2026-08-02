import { useState } from 'react'
import { motion } from 'framer-motion'
import { Play, Sparkles } from 'lucide-react'
import { Button, ShimmerCard } from '@/components/ui'
import { MOTION_PRESETS, staggerContainer, staggerItem } from '@/lib/motion-presets'
import { useMotion } from '@/hooks/useMotion'
import { useMotionPrefs, type MotionLevel } from '@/state/useMotionPrefs'

const LEVELS: Array<{ id: MotionLevel; label: string }> = [
  { id: 'system', label: '跟随系统' },
  { id: 'reduced', label: '减少动画' },
  { id: 'off', label: '关闭' },
]

interface MotionPreviewProps {
  highlight?: boolean
}

/** 设置页动效强度：三态选择 + 可重播的动画样例 */
export default function MotionPreview({ highlight = false }: MotionPreviewProps) {
  const level = useMotionPrefs((s) => s.level)
  const setLevel = useMotionPrefs((s) => s.setLevel)
  const { enabled } = useMotion()
  const [playKey, setPlayKey] = useState(0)

  const replay = () => setPlayKey((k) => k + 1)
  const previewKey = `${playKey}-${level}`

  return (
    <ShimmerCard padding="md" className={highlight ? 'ring-2 ring-[var(--accent)]' : undefined}>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
            <Sparkles className="size-4 text-[var(--accent)]" />
            动效强度
          </h3>
          <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
            控制页面过渡、折叠与按压反馈；选择后立即生效并持久化。
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="动效强度"
          className="flex shrink-0 gap-1 rounded-lg bg-[var(--bg-tertiary)] p-1"
        >
          {LEVELS.map((opt) => (
            <Button
              key={opt.id}
              size="sm"
              variant={level === opt.id ? 'primary' : 'ghost'}
              onClick={() => setLevel(opt.id)}
              role="radio"
              aria-checked={level === opt.id}
              aria-label={opt.label}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-tertiary)] p-3">
        {enabled ? (
          <motion.div
            key={previewKey}
            initial="hidden"
            animate="show"
            variants={staggerContainer({ staggerDelay: 0.12 })}
          >
            <div className="flex flex-wrap items-center gap-2">
              {['搜索', '代码', '知识'].map((label) => (
                <motion.span
                  key={label}
                  variants={staggerItem}
                  className="rounded-lg border border-[var(--border-hover)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--text-secondary)]"
                >
                  {label}
                </motion.span>
              ))}
            </div>
            <motion.div
              className="mt-3 flex h-16 items-center justify-center rounded-lg bg-[var(--accent-soft)]"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={MOTION_PRESETS.fadeIn}
            >
              <span className="text-xs font-medium text-[var(--accent)]">页面过渡 · 交错入场</span>
            </motion.div>
          </motion.div>
        ) : (
          <div>
            <div className="flex flex-wrap items-center gap-2">
              {['搜索', '代码', '知识'].map((label) => (
                <span
                  key={label}
                  className="rounded-lg border border-[var(--border-hover)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--text-secondary)]"
                >
                  {label}
                </span>
              ))}
            </div>
            <div className="mt-3 flex h-16 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
              <span className="text-xs font-medium text-[var(--accent)]">动效已停用，预览为静态</span>
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          variant="secondary"
          onClick={replay}
          icon={<Play className="size-3.5" />}
          aria-label="重播动效预览"
        >
          重播预览
        </Button>
      </div>
    </ShimmerCard>
  )
}
