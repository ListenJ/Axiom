import { X } from 'lucide-react'
import Button from './Button'
import { SHORTCUTS } from '@/lib/shortcuts'
import { useApp } from '@/state/useApp'

export default function HelpModal() {
  const open = useApp((s) => s.helpOpen)
  const setOpen = useApp((s) => s.setHelpOpen)
  if (!open) return null

  // 清单统一来自 lib/shortcuts.ts 注册表（导航项 + 全局快捷键）
  const shortcuts: { key: string; desc: string }[] = SHORTCUTS.map((s) => ({
    key: s.label,
    desc: s.description,
  }))

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center backdrop-glass"
      role="dialog"
      aria-modal="true"
      aria-label="键盘快捷键"
      onClick={() => setOpen(false)}
    >
      <div
         className="w-[min(90vw,28rem)] elevation-4 glass rounded-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">键盘快捷键</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setOpen(false)}
            aria-label="关闭"
            icon={<X size={18} />}
          />
        </div>
        <ul className="space-y-2 text-sm">
          {shortcuts.map((s) => (
            <li key={s.key} className="flex items-center justify-between gap-3">
              <span className="text-text-secondary">{s.desc}</span>
              <kbd className="rounded bg-bg-tertiary px-2 py-0.5 font-mono text-2xs text-text">{s.key}</kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
