import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Menu, Bell, Sun, Moon, Keyboard, Search, TerminalSquare, FileText, GitBranch, Activity, X } from 'lucide-react'
import { Button } from '@/components/ui'
import { useApp } from '@/state/useApp'
import { GitStatusBadge } from './GitStatusBadge'
import { endpoints } from '@/lib/api'

interface HeaderProps {
  onMenuClick: () => void
  onTerminalToggle: () => void
  terminalOpen: boolean
}

interface SystemSummary {
  activeTasks: number
  agents: number
  completed: number
  tokensUsed: number
}

/** 右上角摘要面板：Git 状态 + 系统统计快照（30s 轮询） */
function SummaryPanel({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const [git, setGit] = useState<{ branch?: string; changes: number; clean: boolean } | null>(null)
  const [stats, setStats] = useState<SystemSummary | null>(null)
  const [gitError, setGitError] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const [g, s] = await Promise.allSettled([endpoints.git.status(), endpoints.stats()])
        if (!alive) return
        if (g.status === 'fulfilled' && g.value?.success) {
          const r = g.value
          setGit({
            branch: r.branch,
            changes: (r.modified?.length ?? 0) + (r.added?.length ?? 0) + (r.deleted?.length ?? 0) + (r.untracked?.length ?? 0) + (r.conflicted?.length ?? 0),
            clean: (r.modified?.length ?? 0) + (r.added?.length ?? 0) + (r.deleted?.length ?? 0) + (r.untracked?.length ?? 0) + (r.conflicted?.length ?? 0) === 0,
          })
        } else {
          setGitError(true)
        }
        if (s.status === 'fulfilled') setStats(s.value as SystemSummary)
      } catch {
        if (alive) setGitError(true)
      }
    }
    void load()
    const t = setInterval(load, 30_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  return (
    <div
      role="dialog"
      aria-label="摘要"
      className="elevation-4 glass absolute right-0 top-full z-50 mt-2 w-80 rounded-2xl p-4"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <FileText size={16} className="text-[var(--accent)]" />
          摘要
        </h2>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭摘要" icon={<X size={16} />} />
      </div>

      {/* Git 状态 */}
      <div className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="mb-1 flex items-center gap-2 text-xs font-medium text-[var(--text)]">
          <GitBranch size={14} className="text-[var(--accent)]" />
          Git 状态
        </div>
        {gitError ? (
          <p className="text-2xs text-[var(--text-muted)]">Git 服务不可用</p>
        ) : git ? (
          <div className="flex items-center justify-between">
            <span className="font-mono text-sm text-[var(--text)]">{git.branch ?? '?'}</span>
            <span className={`text-2xs ${git.clean ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>
              {git.clean ? '工作区干净' : `${git.changes} 个变更`}
            </span>
          </div>
        ) : (
          <p className="text-2xs text-[var(--text-muted)]">加载中…</p>
        )}
        <button
          type="button"
          onClick={() => { onClose(); navigate('/git') }}
          className="mt-2 w-full rounded-lg border border-[var(--border)] py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          打开 Git 页面
        </button>
      </div>

      {/* 系统统计 */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--text)]">
          <Activity size={14} className="text-[var(--accent)]" />
          系统统计
        </div>
        {stats ? (
          <dl className="grid grid-cols-2 gap-2 text-2xs">
            <div className="rounded-lg bg-[var(--bg-tertiary)] p-2">
              <dt className="text-[var(--text-muted)]">活跃任务</dt>
              <dd className="mt-0.5 text-sm font-semibold text-[var(--text)]">{stats.activeTasks ?? 0}</dd>
            </div>
            <div className="rounded-lg bg-[var(--bg-tertiary)] p-2">
              <dt className="text-[var(--text-muted)]">Agent 数</dt>
              <dd className="mt-0.5 text-sm font-semibold text-[var(--text)]">{stats.agents ?? 0}</dd>
            </div>
            <div className="rounded-lg bg-[var(--bg-tertiary)] p-2">
              <dt className="text-[var(--text-muted)]">已完成</dt>
              <dd className="mt-0.5 text-sm font-semibold text-[var(--text)]">{stats.completed ?? 0}</dd>
            </div>
            <div className="rounded-lg bg-[var(--bg-tertiary)] p-2">
              <dt className="text-[var(--text-muted)]">Token 用量</dt>
              <dd className="mt-0.5 text-sm font-semibold text-[var(--text)]">
                {((stats.tokensUsed ?? 0) / 1000).toFixed(1)}k
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-2xs text-[var(--text-muted)]">加载中…</p>
        )}
      </div>
    </div>
  )
}

export default function Header({ onMenuClick, onTerminalToggle, terminalOpen }: HeaderProps) {
  const navigate = useNavigate()
  const theme = useApp((s) => s.theme)
  const toggleTheme = useApp((s) => s.toggleTheme)
  const openHelp = useApp((s) => s.setHelpOpen)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const summaryRef = useRef<HTMLDivElement | null>(null)

  // 点击外部关闭摘要面板
  useEffect(() => {
    if (!summaryOpen) return
    const onDoc = (e: MouseEvent) => {
      if (summaryRef.current && !summaryRef.current.contains(e.target as Node)) setSummaryOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [summaryOpen])

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] glass-sm px-4">
      {/* Left: Menu + Brand */}
      <div className="flex items-center gap-2">
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
          className="press flex items-center gap-2 rounded-lg px-1 py-1 text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] focus:outline-none"
          aria-label="返回对话"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[var(--accent)] to-[var(--accent-active)] text-sm font-bold text-white shadow-[var(--shadow-sm)]">
            OC
          </div>
          <span className="hidden font-display text-base font-semibold tracking-tight sm:inline">
            Axiom
          </span>
        </button>
      </div>

      {/* Center: Search */}
      <div className="hidden max-w-md flex-1 px-4 md:block">
        <button
          type="button"
          onClick={() => navigate('/search')}
          className="press flex h-9 w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 text-left text-sm text-[var(--text-muted)] transition-colors hover:border-[var(--border-hover)] hover:text-[var(--text-secondary)] focus:outline-none"
          aria-label="打开搜索"
        >
          <Search className="size-3.5" />
          <span className="flex-1">搜索笔记与代码…</span>
          <kbd className="rounded border border-[var(--border)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-2xs">/</kbd>
        </button>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={onTerminalToggle}
          className={`h-11 w-11 ${terminalOpen ? 'text-[var(--accent)]' : ''}`}
          aria-label="终端"
          title="终端（Ctrl+`）"
          icon={<TerminalSquare size={18} />}
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => openHelp(true)}
          className="h-11 w-11"
          aria-label="键盘快捷键"
          icon={<Keyboard size={18} />}
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          className="h-11 w-11"
          aria-label="切换主题"
          title="切换主题（Shift+T）"
          icon={theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate('/settings')}
          className="h-11 w-11"
          aria-label="设置"
          icon={<Bell size={18} />}
        />

        {/* Git 状态徽标 */}
        <GitStatusBadge />

        {/* 摘要 */}
        <div className="relative" ref={summaryRef}>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSummaryOpen((v) => !v)}
            className="h-11 w-11"
            aria-label="摘要"
            aria-expanded={summaryOpen}
            title="摘要与 Git 状态"
            icon={<FileText size={18} />}
          />
          {summaryOpen && <SummaryPanel onClose={() => setSummaryOpen(false)} />}
        </div>
      </div>
    </header>
  )
}
