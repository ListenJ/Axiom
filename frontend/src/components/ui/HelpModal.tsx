import { X } from 'lucide-react'
import { VISIBLE_NAV_ITEMS } from '@/lib/nav'
import { useApp } from '@/state/useApp'

export default function HelpModal() {
  const open = useApp((s) => s.helpOpen)
  const setOpen = useApp((s) => s.setHelpOpen)
  if (!open) return null

  const shortcuts: { key: string; desc: string }[] = [
    ...VISIBLE_NAV_ITEMS.map((n) => ({ key: n.shortcut, desc: `打开 ${n.label}` })),
    { key: 'Shift+T', desc: '切换深色 / 浅色主题' },
    { key: '/', desc: '聚焦搜索' },
    { key: 'Ctrl/Cmd+K', desc: '聚焦搜索' },
    { key: '?', desc: '打开 / 关闭此对话框' },
    { key: 'Esc', desc: '关闭对话框或失焦' },
  ]

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
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-surface hover:text-text"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
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
