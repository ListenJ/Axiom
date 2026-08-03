import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, Menu } from 'lucide-react'
import { Button } from '@/components/ui'
import { useApp } from '@/state/useApp'
import { shortcutLabel } from '@/lib/shortcuts'

interface MenuItem {
  label: string
  shortcut?: string
  onSelect: () => void
}

/** 外壳系统菜单：文件 / 编辑 / 视图 / 帮助（点击外部关闭）。 */
function HeaderMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`press flex h-9 items-center gap-1 rounded-lg px-2.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
          open
            ? 'bg-[var(--shell-hover)] text-[var(--text)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--shell-hover)] hover:text-[var(--text)]'
        }`}
      >
        {label}
        <ChevronDown size={13} className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={label}
          className="shell-raised elevation-4 absolute left-0 top-full z-50 mt-1 w-52 rounded-lg border border-[var(--shell-border-strong)] p-1.5"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
              className="press flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--shell-hover)] hover:text-[var(--text)] focus:outline-none"
            >
              <span>{item.label}</span>
              {item.shortcut && (
                <kbd className="rounded border border-[var(--border)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-2xs text-[var(--text-muted)]">
                  {item.shortcut}
                </kbd>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Header({ onMenuClick }: { onMenuClick: () => void }) {
  const navigate = useNavigate()
  const toggleTheme = useApp((s) => s.toggleTheme)
  const setTerminalOpen = useApp((s) => s.setTerminalOpen)
  const setRightbarOpen = useApp((s) => s.setRightbarOpen)
  const setHelpOpen = useApp((s) => s.setHelpOpen)

  return (
    <header className="shell-surface flex h-14 shrink-0 items-center gap-1 border-b border-[var(--shell-border)] px-3">
      <Button
        variant="ghost"
        size="icon"
        onClick={onMenuClick}
        className="h-11 w-11 lg:hidden"
        aria-label="打开菜单"
        icon={<Menu size={20} />}
      />

      <button
        type="button"
        onClick={() => navigate('/chat')}
        className="press flex shrink-0 items-center gap-2 rounded-lg px-1 py-1 text-[var(--text)] transition-colors hover:bg-[var(--shell-hover)] focus:outline-none"
        aria-label="返回对话"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[var(--accent)] to-[var(--accent-active)] text-sm font-bold text-white shadow-[var(--shadow-sm)]">
          OC
        </div>
        <span className="hidden font-display text-base font-semibold tracking-tight sm:inline">
          Axiom
        </span>
      </button>

      {/* 外壳系统菜单 */}
      <nav aria-label="系统菜单" className="ml-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        <HeaderMenu
          label="文件"
          items={[
            { label: '新建对话', shortcut: shortcutLabel('nav-chat'), onSelect: () => navigate('/chat') },
            { label: '搜索', shortcut: shortcutLabel('nav-search'), onSelect: () => navigate('/search') },
            { label: '设置', shortcut: shortcutLabel('nav-settings'), onSelect: () => navigate('/settings') },
          ]}
        />
        <HeaderMenu
          label="编辑"
          items={[
            { label: '会话', shortcut: shortcutLabel('nav-sessions'), onSelect: () => navigate('/sessions') },
            { label: '知识', shortcut: shortcutLabel('nav-vault'), onSelect: () => navigate('/vault') },
            { label: '模型', shortcut: shortcutLabel('nav-providers'), onSelect: () => navigate('/providers') },
          ]}
        />
        <HeaderMenu
          label="视图"
          items={[
            { label: '切换主题', shortcut: shortcutLabel('theme'), onSelect: () => toggleTheme() },
            { label: '打开终端', shortcut: shortcutLabel('terminal'), onSelect: () => setTerminalOpen(true) },
            { label: '打开工具台', onSelect: () => setRightbarOpen(true) },
            { label: '搜索', shortcut: shortcutLabel('search-slash'), onSelect: () => navigate('/search') },
          ]}
        />
        <HeaderMenu
          label="帮助"
          items={[{ label: '键盘快捷键', shortcut: shortcutLabel('help'), onSelect: () => setHelpOpen(true) }]}
        />
      </nav>
    </header>
  )
}
