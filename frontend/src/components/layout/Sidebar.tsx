import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  X, FolderOpen, MessageSquare, Clock, ChevronRight,
  Settings, Keyboard, PanelLeftClose, PanelLeftOpen, Plus, Pencil, Trash2, Check,
} from 'lucide-react'
import { endpoints } from '@/lib/api'
import { useApp } from '@/state/useApp'
import type { WorkspaceSummary, SessionSummary } from '@/lib/workspace-sessions'
import { groupSessionsForWorkspace } from '@/lib/workspace-sessions'
import { sessionListTitle, saveChatTitle } from '@/lib/chat-title'
import { formatTime, formatTokens } from '@/components/chat-utils'

interface SidebarProps {
  open: boolean
  onClose: () => void
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const setHelpOpen = useApp((s) => s.setHelpOpen)
  const collapsed = useApp((s) => s.sidebarCollapsed)
  const toggleCollapsed = useApp((s) => s.toggleSidebarCollapsed)
  const [health, setHealth] = useState<{ status?: string; version?: string; uptime?: number } | null>(null)
  const [healthError, setHealthError] = useState(false)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [workspaceError, setWorkspaceError] = useState(false)
  const [collapsedWs, setCollapsedWs] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [busyDelete, setBusyDelete] = useState<string | null>(null)

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

  const online = !healthError && health?.status === 'ok'
  const sessionsByWorkspace = groupSessionsForWorkspace(workspaces, sessions, 100)
  const currentSession = new URLSearchParams(location.search).get('session')

  const openSession = (sessionId: string) => {
    navigate(`/chat?session=${encodeURIComponent(sessionId)}`)
    onClose()
  }

  const startNewChat = () => {
    navigate('/chat')
    onClose()
  }

  const toggleWs = (key: string) => {
    setCollapsedWs((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const startRename = (sessionId: string, title: string) => {
    setEditingId(sessionId)
    setEditValue(title)
  }

  const commitRename = (sessionId: string) => {
    const title = editValue.trim()
    setEditingId(null)
    if (!title) return
    saveChatTitle(sessionId, title)
    // 立即刷新列表（后端持久化异步完成，标题本地即时生效）
    setSessions((prev) => prev.map((s) => (s.session_id === sessionId ? { ...s, title } : s)))
  }

  /** 删除会话：403 下发的 confirmationId 即一次性凭据，带 header 重发即可 */
  const deleteSession = async (sessionId: string) => {
    if (busyDelete) return
    const title = sessionListTitle(sessionId, sessions.find((s) => s.session_id === sessionId)?.title)
    if (!window.confirm(`确认删除会话「${title}」？\n会话消息将不可恢复。`)) return
    setBusyDelete(sessionId)
    try {
      try {
        await endpoints.chat.deleteSession(sessionId, '')
      } catch (err) {
        const e = err as { status?: number; data?: { confirmationId?: string } }
        if (e?.status === 403 && e.data?.confirmationId) {
          await endpoints.chat.deleteSession(sessionId, e.data.confirmationId)
        } else {
          throw err
        }
      }
      setSessions((prev) => prev.filter((s) => s.session_id !== sessionId))
      if (currentSession === sessionId) navigate('/chat')
    } catch {
      window.alert('删除会话失败，请重试')
    } finally {
      setBusyDelete(null)
    }
  }

  const renderSessionRow = (s: SessionSummary) => {
    const title = sessionListTitle(s.session_id, s.title)
    const isEditing = editingId === s.session_id
    const isActive = currentSession === s.session_id
    return (
      <div
        key={s.session_id}
        className={`group/session relative flex items-center gap-1.5 rounded-lg pr-1 transition-colors ${
          isActive ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--shell-hover)]'
        }`}
      >
        {isEditing ? (
          <div className="flex min-w-0 flex-1 items-center gap-1 py-1 pl-2">
            <input
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(s.session_id)
                if (e.key === 'Escape') setEditingId(null)
              }}
              onBlur={() => commitRename(s.session_id)}
              aria-label="重命名会话"
              className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-2xs text-[var(--text)] focus:outline-none"
            />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commitRename(s.session_id)}
              aria-label="确认重命名"
              className="press flex size-5 shrink-0 items-center justify-center rounded text-[var(--success)] hover:bg-[var(--surface-hover)]"
            >
              <Check size={12} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => openSession(s.session_id)}
            className={`press flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left focus:outline-none ${collapsed ? 'lg:justify-center lg:px-1' : ''}`}
            title={collapsed ? title : undefined}
          >
            <MessageSquare size={12} className={`shrink-0 ${isActive ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`} />
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-2xs ${isActive ? 'font-medium text-[var(--accent)]' : 'text-[var(--text)]'}`}>
                {title}
              </span>
              <span className="block text-2xs text-[var(--text-muted)]">
                {s.message_count} 条 · {formatTokens(s.total_tokens ?? 0)} tok
              </span>
            </span>
            <span className={`flex shrink-0 items-center gap-1 text-2xs text-[var(--text-muted)] ${collapsed ? 'lg:hidden' : ''}`}>
              <Clock size={10} />
              {formatTime(s.last_active)}
            </span>
          </button>
        )}
        {!isEditing && (
          <div className={`flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/session:opacity-100 group-focus-within/session:opacity-100 ${collapsed ? 'lg:hidden' : ''}`}>
            <button
              type="button"
              onClick={() => startRename(s.session_id, title)}
              aria-label="重命名会话"
              title="重命名"
              className="press flex size-5 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            >
              <Pencil size={11} />
            </button>
            <button
              type="button"
              onClick={() => void deleteSession(s.session_id)}
              disabled={busyDelete === s.session_id}
              aria-label="删除会话"
              title="删除"
              className="press flex size-5 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
            >
              <Trash2 size={11} />
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <aside
      className={`
        fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-[var(--shell-border)]
        shell-surface
        transform transition-[width,transform] duration-300 ease-out
        lg:static lg:translate-x-0
        ${collapsed ? 'lg:w-16' : 'lg:w-72'}
        ${open ? 'translate-x-0' : '-translate-x-full'}
      `}
      aria-label="主导航"
    >
      {/* Brand */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
        <div className="flex min-w-0 items-center gap-2">
          <svg className="h-8 w-8 shrink-0" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="32" height="32" rx="8" fill="url(#logo-gradient)" />
            <path d="M16 8c-4.4 0-8 3.1-8 7s3.6 7 8 7c2 0 3.8-.7 5.2-1.8l-2.2-2.2c-.8.6-1.9 1-3 1-2.2 0-4-1.6-4-3.6s1.8-3.6 4-3.6 4 1.6 4 3.6v.7h-3.5l4.2 4.2C24.2 18.5 24 13.5 24 15c0-3.9-3.6-7-8-7z" fill="white" />
            <defs>
              <linearGradient id="logo-gradient" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                <stop stopColor="#f59e0b" />
                <stop offset="1" stopColor="#fbbf24" />
              </linearGradient>
            </defs>
          </svg>
          <div className={`flex min-w-0 flex-col leading-tight ${collapsed ? 'lg:hidden' : ''}`}>
            <span className="truncate font-display text-sm font-semibold tracking-tight text-[var(--text)]">
              Axiom
            </span>
            <span className="text-2xs text-[var(--text-muted)]">智能工作台</span>
          </div>
        </div>
        <div className="flex items-center">
          <button
            type="button"
            onClick={toggleCollapsed}
            className="press hidden h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--shell-hover)] hover:text-[var(--text)] focus:outline-none lg:flex"
            aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
            title={collapsed ? '展开侧栏' : '折叠侧栏'}
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="press flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--shell-hover)] hover:text-[var(--text)] focus:outline-none lg:hidden"
            aria-label="关闭菜单"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* 新建对话 */}
      <div className="shrink-0 border-b border-[var(--border)] p-2">
        <button
          type="button"
          onClick={startNewChat}
          className="press flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-[var(--accent)] to-[var(--accent-active)] px-3 py-2 text-sm font-medium text-[var(--on-accent)] shadow-[var(--shadow-sm)] transition-opacity hover:opacity-90 focus:outline-none"
          aria-label="开启新对话"
        >
          <Plus size={16} />
          <span className={collapsed ? 'lg:hidden' : ''}>开启新对话</span>
        </button>
      </div>

      {/* 工作空间与会话条目 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {workspaceError ? (
          <p className="px-3 py-2 text-2xs text-[var(--text-muted)]">
            工作区服务不可用，请打开设置诊断
          </p>
        ) : workspaces.length === 0 ? (
          <div className="px-3 py-2">
            <p className="text-2xs text-[var(--text-muted)]">暂无工作区</p>
            <p className="mt-1 text-2xs text-[var(--text-muted)]">
              点击「开启新对话」开始，或打开设置检查工作区服务。
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {workspaces.map((ws) => {
              const key = ws.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
              const wsSessions = sessionsByWorkspace.get(key) ?? []
              const isCollapsed = collapsedWs.has(key)
              return (
                <div key={ws.id}>
                  <button
                    type="button"
                    onClick={() => toggleWs(key)}
                    className={`press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--shell-hover)] focus:outline-none ${collapsed ? 'lg:justify-center lg:px-1' : ''}`}
                    aria-expanded={!isCollapsed}
                    title={collapsed ? ws.name : undefined}
                  >
                    <FolderOpen size={16} className="shrink-0 text-[var(--accent)]" />
                    <span className={`min-w-0 flex-1 ${collapsed ? 'lg:hidden' : ''}`}>
                      <span className="block truncate text-xs font-medium text-[var(--text)]" title={ws.name}>
                        {ws.name}
                      </span>
                      <span className="block truncate font-mono text-2xs text-[var(--text-muted)]" title={ws.path}>
                        {ws.branch} · {ws.sessionCount} 个会话
                      </span>
                    </span>
                    <ChevronRight
                      size={14}
                      className={`shrink-0 text-[var(--text-muted)] transition-transform duration-150 ${collapsed ? 'lg:hidden' : ''} ${isCollapsed ? '' : 'rotate-90'}`}
                    />
                  </button>
                  {!isCollapsed && (
                    <div className="mt-0.5 space-y-0.5 pl-3">
                      {wsSessions.length === 0 ? (
                        <p className="px-2 py-1 text-2xs text-[var(--text-muted)]">
                          该工作区暂无会话
                        </p>
                      ) : (
                        wsSessions.map(renderSessionRow)
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Footer: account bar — [设置图标] [头像+用户名+在线状态] [快捷键指示图标] */}
      <div className="shrink-0 border-t border-[var(--border)] p-2">
        <div className={`flex items-center gap-1.5 rounded-lg px-1.5 py-1.5 ${collapsed ? 'lg:flex-col lg:gap-2 lg:px-0' : ''}`}>
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
          <div className={`flex min-w-0 flex-1 items-center gap-2 ${collapsed ? 'lg:hidden' : ''}`}>
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
