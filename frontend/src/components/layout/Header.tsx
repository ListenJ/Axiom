import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, Menu } from 'lucide-react'
import { Button } from '@/components/ui'
import { useApp } from '@/state/useApp'
import { shortcutLabel } from '@/lib/shortcuts'
import { MOTION_PRESETS } from '@/lib/motion-presets'

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

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label={label}
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={MOTION_PRESETS.fadeIn}
            className="shell-raised elevation-4 absolute left-0 top-full z-50 mt-1 w-52 origin-top-left rounded-lg border border-[var(--shell-border-strong)] p-1.5"
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
                className="press flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--shell-hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <span>{item.label}</span>
                {item.shortcut && (
                  <kbd className="rounded border border-[var(--border)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-2xs text-[var(--text-muted)]">
                    {item.shortcut}
                  </kbd>
                )}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function Header({ onMenuClick }: { onMenuClick: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const toggleTheme = useApp((s) => s.toggleTheme)
  const setTerminalOpen = useApp((s) => s.setTerminalOpen)
  const setRightbarOpen = useApp((s) => s.setRightbarOpen)
  const setHelpOpen = useApp((s) => s.setHelpOpen)
  const toggleSidebarCollapsed = useApp((s) => s.toggleSidebarCollapsed)

  // 工具台只挂载于聊天页：从其他页面打开时先导航到 /chat
  const openToolRail = () => {
    if (location.pathname !== '/chat') navigate('/chat')
    setRightbarOpen(true)
  }

  return (
    <header className="shell-surface flex h-14 shrink-0 items-center gap-1 px-3 shadow-[var(--shell-shadow-bottom)]">
      <Button
        variant="ghost"
        size="icon"
        onClick={onMenuClick}
        className="h-11 w-11 lg:hidden"
        aria-label="打开菜单"
        icon={<Menu size={20} />}
      />

      {/* 桌面端品牌归位侧栏顶部；顶栏仅在移动端保留品牌（避免双 Logo） */}
      <button
        type="button"
        onClick={() => navigate('/chat')}
        className="press flex shrink-0 items-center gap-2 rounded-lg px-1 py-1 text-[var(--text)] transition-colors hover:bg-[var(--shell-hover)] focus:outline-none lg:hidden"
        aria-label="返回对话"
      >
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--accent)] text-xs font-bold text-[var(--on-accent)] shadow-[var(--shadow-sm)]">
          AX
        </div>
        <span className="hidden font-display text-base font-semibold tracking-tight sm:inline">
          Axiom
        </span>
      </button>

      {/* 外壳系统菜单 */}
      <nav aria-label="系统菜单" className="ml-1 hidden min-w-0 flex-1 items-center gap-0.5 overflow-x-auto lg:flex">
        <HeaderMenu
          label="文件"
          items={[
            { label: '新建对话', shortcut: shortcutLabel('nav-chat'), onSelect: () => navigate('/chat') },
            { label: '搜索', shortcut: shortcutLabel('nav-search'), onSelect: () => navigate('/search') },
            { label: '代码', shortcut: shortcutLabel('nav-code'), onSelect: () => navigate('/code') },
            { label: '设置', shortcut: shortcutLabel('nav-settings'), onSelect: () => navigate('/settings') },
          ]}
        />
        <HeaderMenu
          label="编辑"
          items={[
            { label: '会话', shortcut: shortcutLabel('nav-sessions'), onSelect: () => navigate('/sessions') },
            { label: '知识', shortcut: shortcutLabel('nav-vault'), onSelect: () => navigate('/vault') },
            { label: '模型', shortcut: shortcutLabel('nav-providers'), onSelect: () => navigate('/providers') },
            { label: 'Git', shortcut: shortcutLabel('nav-git'), onSelect: () => navigate('/git') },
          ]}
        />
        <HeaderMenu
          label="视图"
          items={[
            { label: '切换主题', shortcut: shortcutLabel('theme'), onSelect: () => toggleTheme() },
            { label: '折叠侧栏', onSelect: () => toggleSidebarCollapsed() },
            { label: '打开终端', shortcut: shortcutLabel('terminal'), onSelect: () => setTerminalOpen(true) },
            { label: '打开工具台', onSelect: openToolRail },
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
