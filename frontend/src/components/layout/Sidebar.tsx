import { useEffect, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { X, FolderOpen, MessageSquare, Clock, ChevronRight, Settings, Keyboard } from 'lucide-react'
import { NAV_SECTIONS, VISIBLE_NAV_ITEMS } from '@/lib/nav'
import { endpoints } from '@/lib/api'
import { useApp } from '@/state/useApp'
import type { WorkspaceSummary, SessionSummary } from '@/lib/workspace-sessions'
import { groupSessionsForWorkspace } from '@/lib/workspace-sessions'
import { sessionListTitle } from '@/lib/chat-title'
import { formatTime, formatTokens } from '@/components/chat-utils'

interface SidebarProps {
  open: boolean
  onClose: () => void
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  const navigate = useNavigate()
  const setHelpOpen = useApp((s) => s.setHelpOpen)
  const [health, setHealth] = useState<{ status?: string; version?: string; uptime?: number } | null>(null)
  const [healthError, setHealthError] = useState(false)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [workspaceError, setWorkspaceError] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = (await endpoints.system.health()) as { status?: string; version?: string; uptime?: number } | null
        if (!alive) return
        setHealth({ status: r?.status, version: r?.version, uptime: r?.uptime })
        setHealthError(false)
      } catch {
        if (alive) setHealthError(true)
      }
    }
    void load()
    const t = setInterval(load, 30_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const [w, s] = await Promise.allSettled([endpoints.workspaces.list(), endpoints.memory.sessions()])
        if (!alive) return
        if (w.status === 'fulfilled' && Array.isArray(w.value?.workspaces)) {
          setWorkspaces(w.value.workspaces)
          setWorkspaceError(false)
        } else {
          setWorkspaceError(true)
        }
        const sSessions = s.status === 'fulfilled' ? (s.value as { sessions?: SessionSummary[] } | null)?.sessions : undefined
        if (Array.isArray(sSessions)) {
          setSessions(sSessions)
        }
      } catch {
        if (alive) setWorkspaceError(true)
      }
    }
    void load()
    const t = setInterval(load, 30_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const groups = NAV_SECTIONS
    .map((section) => ({ ...section, items: VISIBLE_NAV_ITEMS.filter((i) => i.section === section.id) }))
    .filter((group) => group.items.length > 0)
  const online = !healthError && health?.status === 'ok'
  const sessionsByWorkspace = groupSessionsForWorkspace(workspaces, sessions, 8)

  const openSession = (sessionId: string) => {
    navigate(`/chat?session=${encodeURIComponent(sessionId)}`)
    onClose()
  }

  return (
    <aside
      className={`
        fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-[var(--shell-border)]
        shell-surface
        transform transition-transform duration-300 ease-out
        lg:static lg:translate-x-0
        ${open ? 'translate-x-0' : '-translate-x-full'}
      `}
      aria-label="主导航"
    >
      {/* Brand */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
        <div className="flex items-center gap-2">
          <svg className="h-8 w-8" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="32" height="32" rx="8" fill="url(#logo-gradient)" />
            <path d="M16 8c-4.4 0-8 3.1-8 7s3.6 7 8 7c2 0 3.8-.7 5.2-1.8l-2.2-2.2c-.8.6-1.9 1-3 1-2.2 0-4-1.6-4-3.6s1.8-3.6 4-3.6 4 1.6 4 3.6v.7h-3.5l4.2 4.2C24.2 18.5 24 13.5 24 15c0-3.9-3.6-7-8-7z" fill="white" />
            <defs>
              <linearGradient id="logo-gradient" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                <stop stopColor="#f59e0b" />
                <stop offset="1" stopColor="#fbbf24" />
              </linearGradient>
            </defs>
          </svg>
          <div className="flex flex-col leading-tight">
            <span className="font-display text-sm font-semibold tracking-tight text-[var(--text)]">
              Axiom
            </span>
            <span className="text-2xs text-[var(--text-muted)]">智能工作台</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="press flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--shell-hover)] hover:text-[var(--text)] focus:outline-none lg:hidden"
          aria-label="关闭菜单"
        >
          <X size={18} />
        </button>
      </div>

      {/* Workspaces + sessions */}
      <div className="shrink-0 border-b border-[var(--border)]">
        <div className="flex items-center justify-between px-3 pb-1 pt-3">
          <p className="px-1 text-2xs font-medium text-[var(--text-muted)]">
            打开的工作区
          </p>
          {workspaces.length > 0 && (
            <span className="rounded-full bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-2xs text-[var(--text-muted)]">
              {workspaces.length}
            </span>
          )}
        </div>
        {workspaceError ? (
          <p className="px-4 pb-3 text-2xs text-[var(--text-muted)]">
            工作区服务不可用，请打开设置诊断
          </p>
        ) : workspaces.length === 0 ? (
          <p className="px-4 pb-3 text-2xs text-[var(--text-muted)]">
            暂无工作区
          </p>
        ) : (
          <div className="space-y-0.5 p-2">
            {workspaces.map((ws) => {
              const key = ws.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
              const wsSessions = sessionsByWorkspace.get(key) ?? []
              return (
                <div key={ws.id} className="group relative">
                  <div className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors group-hover:bg-[var(--shell-hover)] group-focus-within:bg-[var(--shell-hover)]">
                    <FolderOpen size={16} className="shrink-0 text-[var(--accent)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-[var(--text)]" title={ws.name}>
                        {ws.name}
                      </span>
                      <span className="block truncate font-mono text-2xs text-[var(--text-muted)]" title={ws.path}>
                        {ws.branch} · {wsSessionCountLabel(ws, wsSessions)}
                      </span>
                    </span>
                    <ChevronRight size={14} className="shrink-0 text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>

                  {/* 悬停/聚焦浮层：该工作区的会话 */}
                  <div
                    className="invisible absolute left-full top-0 z-50 ml-1 hidden w-64 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 opacity-0 shadow-[var(--shadow-lg)] transition-all duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 lg:block"
                  >
                    <p className="px-2 pb-1 text-2xs font-medium text-[var(--text-muted)]">
                      最近会话
                    </p>
                    {wsSessions.length === 0 ? (
                      <p className="px-2 pb-2 text-2xs text-[var(--text-muted)]">
                        该工作区暂无会话
                      </p>
                    ) : (
                      <div className="max-h-64 space-y-0.5 overflow-y-auto">
                        {wsSessions.map((s) => (
                          <button
                            key={s.session_id}
                            type="button"
                            onClick={() => openSession(s.session_id)}
                            className="press flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--shell-hover)] focus:outline-none"
                          >
                            <MessageSquare size={12} className="shrink-0 text-[var(--text-muted)]" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-2xs text-[var(--text)]" title={s.session_id}>
                                {sessionListTitle(s.session_id)}
                              </span>
                              <span className="block text-2xs text-[var(--text-muted)]">
                                {s.message_count} 条 · {formatTokens(s.total_tokens ?? 0)} tok
                              </span>
                            </span>
                            <span className="flex shrink-0 items-center gap-1 text-2xs text-[var(--text-muted)]">
                              <Clock size={10} />
                              {formatTime(s.last_active)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Nav items grouped by section */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-3" aria-label="主导航列表">
        {groups.map((group) => (
          <div key={group.id} className="pt-3 first:pt-0">
            <p className="px-3 pb-1 text-2xs font-medium text-[var(--text-muted)]">
              {group.label}
            </p>
            {group.items.map((item) => {
              const Icon = item.icon
              return (
                <NavLink
                  key={item.id}
                  to={item.path}
                  end={item.path === '/'}
                  onClick={() => onClose()}
                  className={({ isActive }) =>
                    `press group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--shell-hover)] hover:text-[var(--text)]'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon
                        size={18}
                        className={`shrink-0 transition-transform group-hover:scale-110 ${
                          isActive ? 'text-[var(--accent)]' : ''
                        }`}
                      />
                      <span className="flex-1">{item.label}</span>
                      <kbd
                        className={`font-mono text-2xs ${
                          isActive
                            ? 'text-[var(--accent)] opacity-70'
                            : 'text-[var(--text-muted)]'
                        }`}
                      >
                        {item.shortcut}
                      </kbd>
                    </>
                  )}
                </NavLink>
              )
            })}
          </div>
        ))}
      </nav>

      {/* Footer: account bar — [设置图标] [头像+用户名+在线状态] [快捷键指示图标] */}
      <div className="border-t border-[var(--border)] p-2">
        <div className="flex items-center gap-1.5 rounded-lg px-1.5 py-1.5">
          <button
            type="button"
            onClick={() => {
              navigate('/settings')
              onClose()
            }}
            className="press flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--shell-hover)] hover:text-[var(--text)] focus:outline-none"
            aria-label="打开设置"
            title="设置"
          >
            <Settings size={16} />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[var(--accent)] to-[var(--accent-active)] text-xs font-bold text-white shadow-[var(--shadow-sm)]"
              aria-hidden="true"
            >
              本
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-xs font-medium text-[var(--text)]">
                本地工作区
              </span>
              <span className="flex items-center gap-1.5 text-2xs text-[var(--text-muted)]">
                <span className={`pulse-dot size-1.5 shrink-0 rounded-full ${online ? 'bg-[var(--success)]' : 'bg-[var(--danger)]'}`} />
                {online ? '在线' : healthError ? '服务不可达' : '检查中…'}
              </span>
            </span>
          </div>
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="press flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--shell-hover)] hover:text-[var(--text)] focus:outline-none"
            aria-label="键盘快捷键"
            title="键盘快捷键"
          >
            <Keyboard size={16} />
          </button>
        </div>
      </div>
    </aside>
  )
}

function wsSessionCountLabel(ws: WorkspaceSummary, sessions: SessionSummary[]): string {
  if (sessions.length > 0) return `${ws.sessionCount} 个会话 · ${sessions.length} 最近`
  return `${ws.sessionCount} 个会话`
}
