import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  X, FolderOpen, MessageSquare, Clock, ChevronRight,
  Settings, Keyboard, PanelLeftClose, PanelLeftOpen, Plus, Pencil, Trash2, Check,
  GitBranch, GitCommitHorizontal, RefreshCw, ArrowUpCircle, ArrowDownCircle, CircleDot, Layers, Puzzle, Activity,
} from 'lucide-react'
import { endpoints } from '@/lib/api'
import { useApp } from '@/state/useApp'
import type { WorkspaceSummary, SessionSummary } from '@/lib/workspace-sessions'
import { groupSessionsForWorkspace } from '@/lib/workspace-sessions'
import { sessionListTitle, saveChatTitle, clearChatTitle } from '@/lib/chat-title'
import { formatTime, formatTokens } from '@/components/chat-utils'
import { MOTION_EASES } from '@/lib/motion-presets'

interface SidebarProps {
  open: boolean
  onClose: () => void
}

/** 显示截断：项目名 ≤20 字符、会话标题 ≤50 字符（未渲染完全时横向滚动，见 .text-scroll） */
function limitText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
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

  // ── Git 仓库状态（段 2） ──
  const [gitStatus, setGitStatus] = useState<{
    success?: boolean
    branch?: string
    modified?: string[]
    added?: string[]
    deleted?: string[]
    ahead?: number
    behind?: number
    clean?: boolean
    error?: string
  } | null>(null)
  const [branches, setBranches] = useState<Array<{ name: string; current: boolean; remote: boolean }>>([])
  const [gitLoading, setGitLoading] = useState(false)
  const [recentCommits, setRecentCommits] = useState<Array<{ hash: string; message: string }>>([])

  // ── MCP · Skill（段 3） ──
  const [mcpScenes, setMcpScenes] = useState<Array<{ id: string; name: string; description?: string }>>([])
  const [plugins, setPlugins] = useState<Array<{ id?: string; name?: string }>>([])

  const loadGit = async () => {
    setGitLoading(true)
    try {
      const [s, b, l] = await Promise.allSettled([endpoints.git.status(), endpoints.git.branch(), endpoints.git.log(3)])
      if (s.status === 'fulfilled') setGitStatus(s.value)
      if (b.status === 'fulfilled' && b.value?.branches) setBranches(b.value.branches)
      if (l.status === 'fulfilled' && l.value?.commits) setRecentCommits(l.value.commits)
    } catch {
      setGitStatus({ error: 'Git 服务不可用' })
    } finally {
      setGitLoading(false)
    }
  }

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

  // Git 状态 + MCP 场景 + 插件列表（进入时与定时刷新）
  useEffect(() => {
    void loadGit()
    const t = setInterval(() => void loadGit(), 60_000)
    endpoints.mcp.scenes().then((d) => setMcpScenes(d?.scenes ?? [])).catch(() => {})
    endpoints.plugins
      .list()
      .then((d) => {
        const list = Array.isArray(d)
          ? d
          : (d as { plugins?: Array<{ id?: string; name?: string }> })?.plugins ?? []
        setPlugins(list)
      })
      .catch(() => {})
    return () => clearInterval(t)
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
      clearChatTitle(sessionId)
      if (currentSession === sessionId) navigate('/chat')
    } catch {
      window.alert('删除会话失败，请重试')
    } finally {
      setBusyDelete(null)
    }
  }

  const renderSessionRow = (s: SessionSummary, activityTotal: number) => {
    const title = limitText(sessionListTitle(s.session_id, s.title), 50)
    const isEditing = editingId === s.session_id
    const isActive = currentSession === s.session_id
    return (
      <div
        key={s.session_id}
        className={`cv-auto group/session relative flex items-center gap-1.5 rounded-lg pr-1 transition-colors ${
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
            className={`press flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left focus:outline-none ${collapsed ? 'lg:justify-center lg:px-1' : ''}`}
            title={collapsed ? title : undefined}
          >
            <MessageSquare size={12} className={`shrink-0 ${isActive ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`} />
            {/* 会话标题 ≤50 字符：未渲染完全时横向滚动（.text-scroll） */}
            <span className="min-w-0 flex-1">
              <span className={`text-scroll block text-2xs leading-snug ${isActive ? 'font-medium text-[var(--accent)]' : 'text-[var(--text)]'}`}>
                {title}
              </span>
              <span className="mt-0.5 block text-2xs leading-relaxed text-[var(--text-muted)]">
                {s.message_count} 条消息 · {formatTokens(s.total_tokens ?? 0)} Token
              </span>
              {/* 动态占比：会话活跃度（消息数）占当前项目总活跃度的比例 */}
              {activityTotal > 0 && (
                <span className="mt-1 block h-0.5 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]" title="该会话活跃度占项目总活跃度的比例" aria-hidden="true">
                  <span
                    className="block h-full rounded-full bg-[var(--accent)] opacity-60 transition-[width] duration-300"
                    style={{ width: `${Math.min(100, Math.round(((s.message_count || 0) / activityTotal) * 100))}%` }}
                  />
                </span>
              )}
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

  const changedCount = (gitStatus?.modified?.length ?? 0) + (gitStatus?.added?.length ?? 0) + (gitStatus?.deleted?.length ?? 0)

  return (
    <aside
      className={`
        fixed inset-y-0 left-0 z-50 flex w-72 flex-col shadow-[var(--shell-shadow)]
        shell-surface
        transform transition-[width,transform] duration-300 ease-out
        lg:static lg:translate-x-0
        ${collapsed ? 'lg:w-16' : 'lg:w-72'}
        ${open ? 'translate-x-0' : '-translate-x-full'}
      `}
      aria-label="主导航"
    >
      {/* 顶部：Axiom Logo（单 Logo，归位侧栏顶部）+ 折叠/关闭 */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-1 px-3">
        <button
          type="button"
          onClick={startNewChat}
          className="press flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 transition-colors hover:bg-[var(--shell-hover)] focus:outline-none"
          aria-label="返回对话"
          title="Axiom"
        >
          <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[var(--accent)] text-xs font-bold text-[var(--on-accent)] shadow-[var(--shadow-sm)]">
            AX
          </div>
          <span className={`truncate font-display text-sm font-semibold tracking-tight text-[var(--text)] ${collapsed ? 'lg:hidden' : ''}`}>
            Axiom
          </span>
        </button>
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
      <div className="shrink-0 px-3 pb-3 pt-1">
        <button
          type="button"
          onClick={startNewChat}
          className="press flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--on-accent)] shadow-[var(--shadow-sm)] transition-opacity hover:opacity-90 focus:outline-none"
          aria-label="开启新对话"
        >
          <Plus size={16} />
          <span className={collapsed ? 'lg:hidden' : ''}>开启新对话</span>
        </button>
      </div>

      {/* 段 2：Git 仓库状态 */}
      <div className={`shrink-0 px-3 pb-3 ${collapsed ? 'lg:hidden' : ''}`}>
        <div className="flex items-center justify-between px-3 pb-1 pt-2.5">
          <p className="flex items-center gap-1.5 text-2xs font-medium text-[var(--text-muted)]">
            <GitBranch size={11} className="text-[var(--accent)]" />
            Git 仓库状态
          </p>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => void loadGit()}
              disabled={gitLoading}
              aria-label="刷新 Git 状态"
              title="刷新"
              className="press flex size-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--shell-hover)] hover:text-[var(--text)]"
            >
              <RefreshCw size={12} className={gitLoading ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={() => {
                navigate('/git')
                onClose()
              }}
              aria-label="打开 Git 面板"
              title="打开 Git 面板（提交/推送/历史）"
              className="press flex size-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--shell-hover)] hover:text-[var(--text)]"
            >
              <ArrowUpCircle size={12} />
            </button>
          </div>
        </div>
        {gitStatus?.error ? (
          <p className="px-3 pb-2.5 text-2xs text-[var(--text-muted)]">{gitStatus.error}</p>
        ) : (
          <>
            <div className="px-3 pb-1.5">
              <div className="flex items-center gap-1.5 text-2xs text-[var(--text-secondary)]">
                <span className={`pulse-dot size-1.5 rounded-full ${gitStatus?.clean ? 'bg-[var(--success)]' : 'bg-[var(--warning)]'}`} />
                <span className="text-scroll max-w-[14rem] font-mono">{gitStatus?.branch ?? '—'}</span>
                {gitStatus?.ahead ? <span className="flex items-center gap-0.5 text-[var(--success)]"><ArrowUpCircle size={10} />{gitStatus.ahead}</span> : null}
                {gitStatus?.behind ? <span className="flex items-center gap-0.5 text-[var(--warning)]"><ArrowDownCircle size={10} />{gitStatus.behind}</span> : null}
                <span className="ml-auto text-[var(--text-muted)]">
                  {gitStatus?.clean ? '干净' : `${changedCount} 处变更`}
                </span>
              </div>
            </div>
            {/* 分支列表：横向滚动 */}
            <div className="text-scroll flex gap-1 px-3 pb-2.5">
              {branches.length === 0 ? (
                <span className="text-2xs text-[var(--text-muted)]">无分支信息</span>
              ) : (
                branches.map((b) => (
                  <span
                    key={b.name}
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs ${
                      b.name === gitStatus?.branch
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                    }`}
                  >
                    <CircleDot size={8} />
                    {b.name}
                  </span>
                ))
              )}
            </div>
            {/* 最近提交（工作进展摘要，横向滚动） */}
            {recentCommits.length > 0 && (
              <div className="px-3 pb-1.5 pt-2">
                <div className="text-scroll space-y-1">
                  {recentCommits.map((c) => (
                    <div key={c.hash} className="flex items-center gap-1.5 text-2xs text-[var(--text-secondary)]">
                      <GitCommitHorizontal size={10} className="shrink-0 text-[var(--text-muted)]" />
                      <span className="shrink-0 font-mono text-[var(--text-muted)]">{c.hash.slice(0, 7)}</span>
                      <span className="min-w-0 truncate">{c.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 段 3：MCP · Skill */}
      <div className={`shrink-0 px-3 pb-3 ${collapsed ? 'lg:hidden' : ''}`}>
        <div className="flex items-center gap-1.5 px-3 pb-1 pt-2.5">
          <p className="flex items-center gap-1.5 text-2xs font-medium text-[var(--text-muted)]">
            <Puzzle size={11} className="text-[var(--accent)]" />
            MCP · Skill
          </p>
        </div>
        <div className="space-y-1 px-2 pb-2.5">
          <p className="px-1 pt-0.5 text-2xs font-medium text-[var(--text-muted)]">MCP 场景</p>
          {mcpScenes.length === 0 ? (
            <p className="px-1 text-2xs text-[var(--text-muted)]">暂无场景（配置于 config/mcp-servers.yaml）</p>
          ) : (
            mcpScenes.slice(0, 6).map((s) => (
              <div key={s.id} className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-[var(--shell-hover)]">
                <Activity size={11} className="shrink-0 text-[var(--text-muted)]" />
                <span className="text-scroll min-w-0 flex-1 text-2xs text-[var(--text)]" title={s.description}>
                  {s.name}
                </span>
              </div>
            ))
          )}
          <p className="px-1 pt-1.5 text-2xs font-medium text-[var(--text-muted)]">插件 / Skill</p>
          {plugins.length === 0 ? (
            <p className="px-1 text-2xs text-[var(--text-muted)]">无插件（skills/ 目录自动加载）</p>
          ) : (
            plugins.slice(0, 6).map((p) => (
              <div key={p.id ?? p.name} className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-[var(--shell-hover)]">
                <Layers size={11} className="shrink-0 text-[var(--text-muted)]" />
                <span className="text-scroll min-w-0 flex-1 text-2xs text-[var(--text)]">{p.name ?? p.id}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 段 4：加载进 Agent 的项目（风琴垂直折叠） */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {workspaceError ? (
          <p className="px-3 py-2 text-2xs text-[var(--text-muted)]">
            工作区服务不可用，请打开设置诊断
          </p>
        ) : workspaces.length === 0 ? (
          <div className="px-3 py-2">
            <p className="text-2xs text-[var(--text-muted)]">暂无项目</p>
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
              const wsName = limitText(ws.name, 20)
              const activityTotal = wsSessions.reduce((acc, x) => acc + (x.message_count || 0), 0)
              return (
                <div key={ws.id}>
                  {/* 风琴头：项目名 ≤20 字符，横向滚动 */}
                  <button
                    type="button"
                    onClick={() => toggleWs(key)}
                    className={`press flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-[var(--shell-hover)] focus:outline-none ${collapsed ? 'lg:justify-center lg:px-1' : ''}`}
                    aria-expanded={!isCollapsed}
                    title={collapsed ? wsName : undefined}
                  >
                    <FolderOpen size={16} className="shrink-0 text-[var(--accent)]" />
                    <span className={`min-w-0 flex-1 ${collapsed ? 'lg:hidden' : ''}`}>
                      <span className="text-scroll block text-xs font-medium text-[var(--text)]" title={ws.name}>
                        {wsName}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-2xs text-[var(--text-muted)]" title={ws.path}>
                        {ws.branch} · {ws.sessionCount} 个会话
                      </span>
                    </span>
                    <ChevronRight
                      size={14}
                      className={`shrink-0 text-[var(--text-muted)] transition-transform duration-150 ${collapsed ? 'lg:hidden' : ''} ${isCollapsed ? '' : 'rotate-90'}`}
                    />
                  </button>
                  {/* 风琴体：会话条目（垂直折叠展开动画） */}
                  <AnimatePresence initial={false}>
                    {!isCollapsed && (
                      <motion.div
                        key={`ws-body-${ws.id}`}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22, ease: MOTION_EASES.out }}
                        className="mt-0.5 space-y-0.5 overflow-hidden pl-3"
                      >
                        {wsSessions.length === 0 ? (
                          <p className="px-2 py-1 text-2xs text-[var(--text-muted)]">
                            该项目暂无会话
                          </p>
                        ) : (
                          wsSessions.map((s) => renderSessionRow(s, activityTotal))
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 账号栏：设置 / 头像+用户名+在线状态 / 快捷键 */}
      <div className="shrink-0 p-2">
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
            <div className={`flex min-w-0 flex-1 items-center gap-2.5 ${collapsed ? 'lg:hidden' : ''}`}>
            <span
              className="avatar-glow flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-bold text-[var(--on-accent)] shadow-[var(--shadow-sm)]"
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
                {online ? '在线' : healthError ? '服务不可达' : '检查中...'}
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
