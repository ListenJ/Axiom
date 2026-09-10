import { X, Keyboard, Compass, Globe, CornerDownLeft } from 'lucide-react'
import { useRef } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import Button from './Button'
import { SHORTCUTS, type ShortcutCategory } from '@/lib/shortcuts'
import { useApp } from '@/state/useApp'
import { MOTION_PRESETS } from '@/lib/motion-presets'
import { useFocusTrap } from '@/hooks/useFocusTrap'

/**
 * 键盘快捷键模态框 — 账号栏快捷键图标 / 帮助菜单 / `?` 快捷键统一入口。
 * 清单来自 lib/shortcuts.ts 单一注册表，按 导航 / 全局 分组渲染。
 */

const CATEGORY_META: Record<ShortcutCategory, { label: string; icon: React.ReactNode }> = {
  nav: { label: '导航', icon: <Compass className="size-3.5" /> },
  global: { label: '全局', icon: <Globe className="size-3.5" /> },
  menu: { label: '菜单', icon: <CornerDownLeft className="size-3.5" /> },
}

export default function HelpModal() {
  const open = useApp((s) => s.helpOpen)
  const setOpen = useApp((s) => s.setHelpOpen)
  const reduceMotion = useReducedMotion()
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useFocusTrap(dialogRef, open, () => setOpen(false))

  const groups = (['nav', 'global', 'menu'] as const)
    .map((cat) => ({
      cat,
      items: SHORTCUTS.filter((s) => s.category === cat),
    }))
    .filter((g) => g.items.length > 0)

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={dialogRef}
          className="fixed inset-0 z-[100] flex items-center justify-center backdrop-glass p-4"
          role="dialog"
          aria-modal="true"
          aria-label="键盘快捷键"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={MOTION_PRESETS.fadeIn}
          onClick={() => setOpen(false)}
        >
          <motion.div
            className="elevation-4 glass w-[min(92vw,32rem)] rounded-2xl p-5"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, scale: 0.97, y: 6 }}
            transition={MOTION_PRESETS.fadeIn}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text)]">
                <Keyboard className="size-5 text-[var(--accent)]" />
                键盘快捷键
              </h2>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setOpen(false)}
                aria-label="关闭"
                icon={<X size={18} />}
              />
            </div>

            <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
              {groups.map(({ cat, items }) => (
                <div key={cat}>
                  <p className="mb-1.5 flex items-center gap-1.5 px-0.5 text-2xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                    {CATEGORY_META[cat].icon}
                    {CATEGORY_META[cat].label}
                  </p>
                  <ul className="space-y-0.5">
                    {items.map((s) => (
                      <li
                        key={s.id}
                        className="flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-sm transition-colors hover:bg-[var(--surface-hover)]"
                      >
                        <span className="truncate text-[var(--text-secondary)]">{s.description}</span>
                        <kbd className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-0.5 font-mono text-2xs text-[var(--text)]">
                          {s.label}
                        </kbd>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <p className="mt-4 border-t border-[var(--border)] pt-3 text-2xs text-[var(--text-muted)]">
              在输入框聚焦时快捷键自动停用；按 <kbd className="rounded border border-[var(--border)] bg-[var(--bg-tertiary)] px-1 font-mono">Esc</kbd> 关闭本窗口。
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
