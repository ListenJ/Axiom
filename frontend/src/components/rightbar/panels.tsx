import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileCode,
  FileText,
  GitBranch,
  Globe,
  MessageSquare,
  RefreshCw,
  Send,
  Sparkles,
  TerminalSquare,
} from 'lucide-react'
import { Button, Skeleton, Textarea } from '@/components/ui'
import { endpoints } from '@/lib/api'
import { useApp } from '@/state/useApp'
import { formatTokens } from '@/components/chat-utils'
import {
  summarizeGitDiff,
  type GitDiffResult,
  type WebFetchResult,
  type LightpandaStatus,
} from '@/lib/workspace-sessions'

interface GitStatus {
  branch?: string
  modified?: string[]
  added?: string[]
  deleted?: string[]
  untracked?: string[]
  conflicted?: string[]
  clean?: boolean
}

interface SystemStats {
  activeTasks?: number
  agents?: number
  completed?: number
  tokensUsed?: number
}

function PanelHeader({ icon, title, action }: { icon: ReactNode; title: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
        {icon}
        {title}
      </h2>
      {action}
    </div>
  )
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
      {message}
    </p>
  )
}

/** 工作摘要：Git 状态 + 系统统计快照（30s 轮询）。 */
export function SummaryPanel() {
  const [git, setGit] = useState<GitStatus | null>(null)
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [cacheRate, setCacheRate] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const [g, s, t] = await Promise.allSettled([endpoints.git.status(), endpoints.stats(), endpoints.tokenDetails(1)])
        if (!alive) return
        if (g.status === 'fulfilled' && g.value?.success) setGit(g.value)
        if (s.status === 'fulfilled') setStats(s.value as SystemStats)
        if (t.status === 'fulfilled') {
          const d = t.value as { cacheStats?: { hitRate: number } }
          if (typeof d?.cacheStats?.hitRate === 'number') setCacheRate(d.cacheStats.hitRate)
        }
        setError(
          g.status === 'rejected' && s.status === 'rejected' && t.status === 'rejected'
            ? 'Git 与统计服务均不可用'
            : null,
        )
      } catch (e) {
        if (alive) setError(String((e as Error)?.message ?? e))
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    const t = setInterval(load, 30_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const changeCount =
    (git?.modified?.length ?? 0) +
    (git?.added?.length ?? 0) +
    (git?.deleted?.length ?? 0) +
    (git?.untracked?.length ?? 0) +
    (git?.conflicted?.length ?? 0)

  return (
    <div className="space-y-4 p-3">
      <PanelHeader
        icon={<FileText className="size-4 text-[var(--accent)]" />}
        title="工作摘要"
      />
      {error && <ErrorNote message={error} />}
      {loading ? (
        <div className="space-y-2">
          <Skeleton height="2.5rem" />
          <Skeleton height="2.5rem" />
        </div>
      ) : (
        <>
          <section aria-label="Git 状态">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-medium text-[var(--text)]">
                <GitBranch className="size-3.5 text-[var(--accent)]" />
                Git 状态
              </span>
              <span
                className={`flex items-center gap-1 ${git?.clean ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}
              >
                <CheckCircle2 className="size-3" />
                {git?.clean ? '工作区干净' : `${changeCount} 个变更`}
              </span>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-xs text-[var(--text-secondary)]">
              {git?.branch ?? '未知分支'}
            </div>
          </section>

          <section aria-label="系统统计">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[var(--text)]">
              <Activity className="size-3.5 text-[var(--accent)]" />
              系统统计
            </div>
            <dl className="grid grid-cols-2 gap-2 text-2xs">
              <div className="rounded-lg bg-[var(--bg-tertiary)] p-2">
                <dt className="text-[var(--text-muted)]">活跃任务</dt>
                <dd className="mt-0.5 text-sm font-semibold text-[var(--text)]">{stats?.activeTasks ?? 0}</dd>
              </div>
              <div className="rounded-lg bg-[var(--bg-tertiary)] p-2">
                <dt className="text-[var(--text-muted)]">Agent 数</dt>
                <dd className="mt-0.5 text-sm font-semibold text-[var(--text)]">{stats?.agents ?? 0}</dd>
              </div>
              <div className="rounded-lg bg-[var(--bg-tertiary)] p-2">
                <dt className="text-[var(--text-muted)]">已完成</dt>
                <dd className="mt-0.5 text-sm font-semibold text-[var(--text)]">{stats?.completed ?? 0}</dd>
              </div>
              <div className="rounded-lg bg-[var(--bg-tertiary)] p-2">
                <dt className="text-[var(--text-muted)]">Token 用量</dt>
                <dd className="mt-0.5 text-sm font-semibold text-[var(--text)]">
                  {formatTokens(stats?.tokensUsed ?? 0)}
                </dd>
              </div>
              <div className="col-span-2 rounded-lg bg-[var(--bg-tertiary)] p-2">
                <dt className="text-[var(--text-muted)]">缓存命中</dt>
                <dd className="mt-0.5 text-sm font-semibold text-[var(--text)]">
                  {cacheRate === null ? '—' : `${Math.round(cacheRate * 100)}%`}
                </dd>
              </div>
            </dl>
          </section>
        </>
      )}
    </div>
  )
}

/** Git 修改统计：文件数 + 增删行 + 变更文件清单。 */
export function GitPanel() {
  const [summary, setSummary] = useState<ReturnType<typeof summarizeGitDiff> | null>(null)
  const [raw, setRaw] = useState<GitDiffResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = async (silent = false) => {
    if (!silent) setLoading(true)
    else setRefreshing(true)
    setError(null)
    try {
      const r = await endpoints.git.diff()
      setRaw(r)
      setSummary(summarizeGitDiff(r))
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="space-y-4 p-3">
      <PanelHeader
        icon={<GitBranch className="size-4 text-[var(--accent)]" />}
        title="Git 修改"
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void load(true)}
            loading={refreshing}
            icon={<RefreshCw className="size-3.5" />}
            aria-label="刷新 Git 修改"
          />
        }
      />
      {error && <ErrorNote message={error} />}
      {loading ? (
        <div className="space-y-2">
          <Skeleton height="2.5rem" />
          <Skeleton height="2.5rem" />
        </div>
      ) : (
        <>
          {!raw?.success ? (
            <ErrorNote message={raw?.error ?? 'Git 服务不可用'} />
          ) : (
            <>
              <dl className="grid grid-cols-3 gap-2 text-2xs">
                <div className="rounded-lg bg-[var(--bg-tertiary)] p-2">
                  <dt className="text-[var(--text-muted)]">文件</dt>
                  <dd className="mt-0.5 text-sm font-semibold text-[var(--text)]">{summary?.files ?? 0}</dd>
                </div>
                <div className="rounded-lg bg-[var(--success-soft)] p-2">
                  <dt className="text-[var(--success)]">新增</dt>
                  <dd className="mt-0.5 text-sm font-semibold text-[var(--success)]">+{summary?.additions ?? 0}</dd>
                </div>
                <div className="rounded-lg bg-[var(--danger-soft)] p-2">
                  <dt className="text-[var(--danger)]">删除</dt>
                  <dd className="mt-0.5 text-sm font-semibold text-[var(--danger)]">-{summary?.deletions ?? 0}</dd>
                </div>
              </dl>

              <div>
                <p className="mb-1.5 text-2xs font-medium text-[var(--text-muted)]">变更文件</p>
                {!raw.files || raw.files.length === 0 ? (
                  <p className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-muted)]">
                    暂无修改文件
                  </p>
                ) : (
                  <ul className="max-h-72 space-y-1 overflow-y-auto">
                    {raw.files.map((f) => (
                      <li
                        key={f.path}
                        className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5"
                      >
                        <span
                          className={`shrink-0 font-mono text-2xs ${
                            f.status === 'added'
                              ? 'text-[var(--success)]'
                              : f.status === 'deleted'
                                ? 'text-[var(--danger)]'
                                : 'text-[var(--warning)]'
                          }`}
                        >
                          {f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : f.status === 'renamed' ? 'R' : 'M'}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-[var(--text-secondary)]" title={f.path}>
                          {f.path}
                        </span>
                        {(f.additions ?? 0) + (f.deletions ?? 0) > 0 && (
                          <span className="shrink-0 font-mono text-2xs text-[var(--text-muted)]">
                            +{f.additions ?? 0}/-{f.deletions ?? 0}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

/** 代码审阅：粘贴代码片段触发 OpenCode review。 */
export function ReviewPanel() {
  const [code, setCode] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useApp((s) => s.toast)

  const run = async () => {
    if (!code.trim()) {
      toast('请先粘贴要审阅的代码', 'warning')
      return
    }
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await endpoints.agents.review(code)
      setResult(typeof res === 'string' ? res : JSON.stringify(res, null, 2))
      toast('审阅完成', 'success')
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      setError(msg)
      toast('审阅失败：' + msg, 'error')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-4 p-3">
      <PanelHeader
        icon={<Sparkles className="size-4 text-[var(--accent)]" />}
        title="代码审阅"
      />
      {error && <ErrorNote message={error} />}
      <Textarea
        label="代码片段"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        rows={8}
        placeholder="粘贴要审阅的代码…"
        className="font-mono text-xs"
      />
      <Button onClick={() => void run()} loading={running} disabled={!code.trim()} className="w-full">
        {running ? '审阅中…' : '开始审阅'}
      </Button>
      {result && (
        <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-xs leading-relaxed text-[var(--text-secondary)]">
          {result}
        </pre>
      )}
    </div>
  )
}

/** 终端入口：唤起 Layout 全局终端浮层（单实例，与 Ctrl+` 同一路径）。 */
export function TerminalGuidePanel() {
  const setTerminalOpen = useApp((s) => s.setTerminalOpen)
  return (
    <div className="space-y-4 p-3">
      <PanelHeader
        icon={<TerminalSquare className="size-4 text-[var(--accent)]" />}
        title="终端"
      />
      <p className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-muted)]">
        终端以底部浮层呈现，全局限一个实例；也可用 Ctrl+` 快捷键开合。
      </p>
      <Button onClick={() => setTerminalOpen(true)} className="w-full" icon={<TerminalSquare className="size-3.5" />}>
        打开终端
      </Button>
    </div>
  )
}

/** 浏览器抓取：Lightpanda 状态 + 页面抓取。 */
export function BrowserPanel() {
  const [status, setStatus] = useState<LightpandaStatus | null>(null)
  const [url, setUrl] = useState('')
  const [fetching, setFetching] = useState(false)
  const [result, setResult] = useState<WebFetchResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    endpoints.search
      .lightpandaStatus()
      .then((s) => setStatus(s))
      .catch(() => setStatus(null))
  }, [])

  const fetchUrl = async (e: FormEvent) => {
    e.preventDefault()
    const target = url.trim()
    if (!/^https?:\/\//i.test(target)) {
      setError('请输入以 http:// 或 https:// 开头的完整地址')
      return
    }
    setFetching(true)
    setError(null)
    setResult(null)
    try {
      const r = await endpoints.search.webFetch(target)
      setResult(r)
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setFetching(false)
    }
  }

  return (
    <div className="space-y-4 p-3">
      <PanelHeader
        icon={<Globe className="size-4 text-[var(--accent)]" />}
        title="浏览器抓取"
      />
      <div
        role="status"
        aria-label={status?.available ? '抓取引擎可用' : '抓取引擎不可用'}
        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
          status?.available
            ? 'border-[var(--success-soft)] bg-[var(--success-soft)] text-[var(--success)]'
            : 'border-[var(--warning-soft)] bg-[var(--warning-soft)] text-[var(--warning)]'
        }`}
      >
        {status?.available ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />}
        <span>Lightpanda：{status?.available ? '可用' : '不可用'}</span>
        {status?.method && (
          <span className="ml-auto font-mono text-2xs opacity-70">{status.method}</span>
        )}
      </div>
      <form onSubmit={fetchUrl} className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com"
          aria-label="抓取网址"
          className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
        />
        <Button type="submit" size="sm" loading={fetching} icon={<ExternalLink className="size-3.5" />}>
          抓取
        </Button>
      </form>
      {error && <ErrorNote message={error} />}
      {result && (
        <div className="space-y-2">
          {result.title && (
            <p className="truncate text-sm font-medium text-[var(--text)]" title={result.title}>
              {result.title}
            </p>
          )}
          {result.description && (
            <p className="line-clamp-3 text-xs text-[var(--text-secondary)]">{result.description}</p>
          )}
          {result.markdown && (
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-2xs leading-relaxed text-[var(--text-secondary)]">
              {result.markdown.slice(0, 4000)}
            </pre>
          )}
          {result.url && (
            <a
              href={/^https?:\/\//i.test(result.url) ? result.url : undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate text-2xs text-[var(--accent)] hover:underline"
            >
              {result.url}
            </a>
          )}
        </div>
      )}
    </div>
  )
}

function toFileList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (Array.isArray(o.files)) return o.files.map(String)
    if (Array.isArray(o.index)) return o.index.map(String)
  }
  return []
}

/** 文件列表：CodeGraph 索引文件，本地过滤。 */
export function FilesPanel() {
  const [files, setFiles] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    endpoints.codegraph
      .fileIndex()
      .then((d) => setFiles(toFileList(d)))
      .catch((e) => setError(String((e as Error)?.message ?? e)))
      .finally(() => setLoading(false))
  }, [])

  const filtered = query.trim()
    ? files.filter((f) => f.toLowerCase().includes(query.trim().toLowerCase()))
    : files

  return (
    <div className="space-y-4 p-3">
      <PanelHeader
        icon={<FileCode className="size-4 text-[var(--accent)]" />}
        title="文件列表"
        action={<span className="text-2xs text-[var(--text-muted)]">{files.length} 个</span>}
      />
      {error && <ErrorNote message={error} />}
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="过滤文件…"
        aria-label="过滤文件"
        className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
      />
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} height="1.25rem" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-muted)]">
          {files.length === 0 ? '暂无索引文件，请先运行 CodeGraph 索引' : '没有匹配的文件'}
        </p>
      ) : (
        <ul className="max-h-96 space-y-0.5 overflow-y-auto">
          {filtered.slice(0, 300).map((f) => (
            <li
              key={f}
              className="truncate rounded-md px-2 py-1 font-mono text-2xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)]"
              title={f}
            >
              {f}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface MiniMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  error?: boolean
}

/** 侧边迷你聊天：非流式单轮问答，适合边工作边提问。 */
export function MiniChatPanel() {
  const [messages, setMessages] = useState<MiniMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const toast = useApp((s) => s.toast)
  const nextIdRef = { current: 1 }

  const send = async (e: FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || sending) return
    const userMsg: MiniMessage = { id: nextIdRef.current++, role: 'user', content: text }
    const assistantMsg: MiniMessage = { id: nextIdRef.current++, role: 'assistant', content: '', error: false }
    setMessages((m) => [...m, userMsg, assistantMsg])
    setInput('')
    setSending(true)
    try {
      const res = await endpoints.chat.send(text)
      const content = typeof res === 'string'
        ? res
        : typeof (res as { content?: unknown })?.content === 'string'
          ? String((res as { content: string }).content)
          : JSON.stringify(res, null, 2)
      setMessages((m) => m.map((item) => (item.id === assistantMsg.id ? { ...item, content } : item)))
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      setMessages((m) =>
        m.map((item) => (item.id === assistantMsg.id ? { ...item, content: msg, error: true } : item)),
      )
      toast('迷你聊天发送失败', 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="p-3 pb-2">
        <PanelHeader
          icon={<MessageSquare className="size-4 text-[var(--accent)]" />}
          title="迷你聊天"
        />
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3">
        {messages.length === 0 && (
          <p className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-muted)]">
            快速提问，无需离开当前工作。
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-xs leading-relaxed ${
                m.role === 'user'
                  ? 'bg-[var(--accent-soft)] text-[var(--text)]'
                  : m.error
                    ? 'border border-[var(--danger-soft)] bg-[var(--danger-soft)] text-[var(--danger)]'
                    : 'border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]'
              }`}
            >
              {m.content || '…'}
            </div>
          </div>
        ))}
      </div>
      <form onSubmit={send} className="flex gap-2 border-t border-[var(--border)] p-3">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入消息…"
          aria-label="迷你聊天输入"
          className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
        />
        <Button type="submit" size="icon" disabled={!input.trim() || sending} loading={sending} aria-label="发送">
          <Send className="size-4" />
        </Button>
      </form>
    </div>
  )
}
