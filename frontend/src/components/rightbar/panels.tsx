import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  Bot,
  Boxes,
  CheckCircle2,
  Cpu,
  ExternalLink,
  FileCode,
  FileEdit,
  FileJson,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Image as ImageIcon,
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

/** 工作摘要：环境信息（Git/变更/缓存）+ 子智能体 + 来源（30s 轮询）。
 *  paused：右栏隐藏时暂停轮询（避免后端空转），打开时立即刷新一次。 */
export function SummaryPanel({ paused = false }: { paused?: boolean }) {
  const [git, setGit] = useState<GitStatus | null>(null)
  const [diff, setDiff] = useState<{ files: number; additions: number; deletions: number } | null>(null)
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [agents, setAgents] = useState<Array<{ name: string; available: boolean }> | null>(null)
  const [sources, setSources] = useState<string[]>([])
  const [cacheRate, setCacheRate] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const toast = useApp((s) => s.toast)
  const openRightTool = useApp((s) => s.openRightTool)

  const load = async () => {
    try {
      // 核心数据（Git/变更/统计/缓存）先就绪即渲染；Agent 与来源异步补充，避免慢接口阻塞面板
      const [g, d, s, t] = await Promise.allSettled([
        endpoints.git.status(),
        endpoints.git.diff(),
        endpoints.stats(),
        endpoints.tokenDetails(1),
      ])
      if (g.status === 'fulfilled' && g.value?.success) setGit(g.value)
      if (d.status === 'fulfilled' && d.value?.success) {
        const files = d.value.files ?? []
        setDiff({
          files: files.length,
          additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
          deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
        })
      }
      if (s.status === 'fulfilled') setStats(s.value as SystemStats)
      if (t.status === 'fulfilled') {
        const d2 = t.value as { cacheStats?: { hitRate: number } }
        if (typeof d2?.cacheStats?.hitRate === 'number') setCacheRate(d2.cacheStats.hitRate)
      }
      // 子智能体与来源：后台补充（失败静默降级为空态）
      void Promise.allSettled([endpoints.agents.status(), endpoints.codegraph.fileIndex()]).then(
        ([a, fi]) => {
          if (a.status === 'fulfilled' && Array.isArray(a.value)) {
            setAgents(
              a.value.map((x) => ({
                name: String((x as { name?: unknown })?.name ?? ''),
                available: !!(x as { available?: unknown })?.available,
              })),
            )
          }
          if (fi.status === 'fulfilled') setSources(toFileList(fi.value))
        },
      )
      setError(
        g.status === 'rejected' && s.status === 'rejected'
          ? 'Git 与统计服务均不可用'
          : null,
      )
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (paused) return
    void load()
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
  }, [paused])

  const changeCount =
    (git?.modified?.length ?? 0) +
    (git?.added?.length ?? 0) +
    (git?.deleted?.length ?? 0) +
    (git?.untracked?.length ?? 0) +
    (git?.conflicted?.length ?? 0)

  const commitPush = async () => {
    if (busy) return
    setBusy(true)
    try {
      const c = await endpoints.git.commit(
        `feat: update from Axiom UI - ${new Date().toISOString().slice(0, 10)}`,
      )
      if (!c?.success) throw new Error(c?.error || '提交失败')
      const p = await endpoints.git.push()
      if (!p?.success) throw new Error(p?.error || '推送失败')
      toast('已提交并推送', 'success')
      await load()
    } catch (e) {
      toast('提交推送失败：' + String((e as Error)?.message ?? e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const AGENT_ICONS: Record<string, ReactNode> = {
    opencode: <Boxes className="size-3.5" />,
    hermes: <Sparkles className="size-3.5" />,
    kimiCode: <Cpu className="size-3.5" />,
  }

  /** 按扩展名给来源文件配图标（代码/文档/图片/JSON），提高信息密度与辨识度 */
  function sourceIcon(name: string): ReactNode {
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : ''
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'].includes(ext)) {
      return <ImageIcon className="size-3 shrink-0 text-[var(--text-muted)]" />
    }
    if (['.md', '.txt', '.doc', '.docx'].includes(ext)) {
      return <FileText className="size-3 shrink-0 text-[var(--text-muted)]" />
    }
    if (['.json', '.yaml', '.yml', '.toml'].includes(ext)) {
      return <FileJson className="size-3 shrink-0 text-[var(--text-muted)]" />
    }
    return <FileCode className="size-3 shrink-0 text-[var(--text-muted)]" />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
      {error && <ErrorNote message={error} />}
      {loading ? (
        <div className="space-y-3">
          <Skeleton height="2.5rem" />
          <Skeleton height="2.5rem" />
          <Skeleton height="2.5rem" />
        </div>
      ) : (
        <>
          {/* 环境信息 */}
          <section aria-label="环境信息" className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              环境信息
            </h2>
            <dl className="space-y-2 text-xs">
              <div className="flex items-center gap-2">
                <GitBranch className="size-3.5 shrink-0 text-[var(--accent)]" />
                <dt className="text-[var(--text-muted)]">分支</dt>
                <dd className="ml-auto truncate font-mono text-[var(--text)]">
                  {git?.branch ?? '未知分支'}
                </dd>
              </div>
              <div className="flex items-center gap-2">
                <FileEdit className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                <dt className="text-[var(--text-muted)]">变更</dt>
                <dd className="ml-auto font-mono text-[var(--text)]">
                  {diff ? (
                    <span className="flex items-center gap-1.5">
                      <span className="text-[var(--success)]">+{diff.additions}</span>
                      <span className="text-[var(--danger)]">-{diff.deletions}</span>
                      <span className="text-[var(--text-muted)]">({diff.files})</span>
                    </span>
                  ) : git?.clean ? (
                    <span className="text-[var(--success)]">工作区干净</span>
                  ) : (
                    `${changeCount} 个变更`
                  )}
                </dd>
              </div>
              <div className="flex items-center gap-2">
                <Activity className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                <dt className="text-[var(--text-muted)]">缓存命中</dt>
                <dd className="ml-auto font-mono text-[var(--text)]">
                  {cacheRate === null ? '未统计' : `${Math.round(cacheRate * 100)}%`}
                </dd>
              </div>
              <div className="flex items-center gap-2">
                <Sparkles className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                <dt className="text-[var(--text-muted)]">Token 用量</dt>
                <dd className="ml-auto font-mono text-[var(--text)]">
                  {formatTokens(stats?.tokensUsed ?? 0)}
                </dd>
              </div>
            </dl>
          </section>

          {/* 子智能体 */}
          <section aria-label="子智能体" className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              子智能体
            </h2>
            <div className="flex items-center gap-1.5 text-2xs text-[var(--text-muted)]">
              <Activity className="size-3" />
              <span>活跃任务 {stats?.activeTasks ?? 0}</span>
              <span className="text-[var(--text-disabled)]">·</span>
              <span>已完成 {stats?.completed ?? 0}</span>
            </div>
            {!agents || agents.length === 0 ? (
              <p className="text-xs text-[var(--text-secondary)]">暂无子智能体</p>
            ) : (
              <ul className="space-y-1">
                {agents.map((a) => (
                  <li
                    key={a.name}
                    className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors hover:bg-[var(--surface-hover)]"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
                      {AGENT_ICONS[a.name] ?? <Bot className="size-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text)]">
                      {a.name}
                    </span>
                    <span
                      className={`flex items-center gap-1 text-2xs ${
                        a.available ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'
                      }`}
                    >
                      <span
                        className={`size-1.5 rounded-full ${
                          a.available ? 'bg-[var(--success)] pulse-dot' : 'bg-[var(--text-disabled)]'
                        }`}
                      />
                      {a.available ? '可用' : '未安装'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 来源 */}
          <section aria-label="来源" className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              来源
            </h2>
            {sources.length === 0 ? (
              <p className="text-xs text-[var(--text-secondary)]">暂无索引文件</p>
            ) : (
              <ul className="space-y-0.5">
                {sources.slice(0, 8).map((f) => (
                  <li
                    key={f}
                    title={f}
                    className="flex items-center gap-2 rounded-lg px-2 py-1 font-mono text-2xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)]"
                  >
                    {sourceIcon(f)}
                    <span className="truncate">{f}</span>
                  </li>
                ))}
              </ul>
            )}
            {sources.length > 8 && (
              <button
                type="button"
                onClick={() => openRightTool('files')}
                className="flex items-center gap-1 text-2xs text-[var(--accent)] transition-opacity hover:opacity-80"
              >
                查看全部 {sources.length} 个
                <ArrowUpRight className="size-3" />
              </button>
            )}
          </section>
        </>
      )}
      </div>
      {/* 底部操作区：状态与操作分离（次级操作左、主操作右下） */}
      {!loading && (
        <div className="flex shrink-0 items-center justify-between gap-1.5 px-4 pb-4 pt-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => openRightTool('git')}
            icon={<ArrowUpRight className="size-3.5" />}
          >
            查看变更
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={busy || !diff || diff.files === 0}
            onClick={() => void commitPush()}
            icon={<GitCommitHorizontal className="size-3.5" />}
          >
            提交并推送
          </Button>
        </div>
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
              <p className="rounded-lg bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-muted)]">
                暂无修改文件
              </p>
                ) : (
                  <ul className="max-h-72 space-y-1 overflow-y-auto">
                    {raw.files.map((f) => (
                      <li
                        key={f.path}
                        className="flex items-center gap-2 rounded-lg bg-[var(--surface)] px-2.5 py-1.5"
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
        variant="glass"
        className="font-mono text-xs"
      />
      <Button onClick={() => void run()} loading={running} disabled={!code.trim()} className="w-full">
        {running ? '审阅中…' : '开始审阅'}
      </Button>
      {result && (
        <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--bg)] p-3 text-xs leading-relaxed text-[var(--text-secondary)]">
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
      <p className="rounded-lg bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-muted)]">
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
        className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${
          status?.available
            ? 'bg-[var(--success-soft)] text-[var(--success)]'
            : 'bg-[var(--warning-soft)] text-[var(--warning)]'
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
          className="h-9 min-w-0 flex-1 rounded-lg border-0 bg-transparent px-3 text-xs text-[var(--text)] outline-none transition-shadow placeholder:text-[var(--text-muted)] focus:shadow-[0_0_0_2px_var(--accent-ring)]"
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
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--bg)] p-3 text-2xs leading-relaxed text-[var(--text-secondary)]">
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
        className="h-9 w-full rounded-lg border-0 bg-transparent px-3 text-xs text-[var(--text)] outline-none transition-shadow placeholder:text-[var(--text-muted)] focus:shadow-[0_0_0_2px_var(--accent-ring)]"
      />
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} height="1.25rem" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="rounded-lg bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-muted)]">
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
  const nextIdRef = useRef(1)

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
          <p className="rounded-lg bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-muted)]">
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
                    ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
                    : 'bg-[var(--surface)] text-[var(--text-secondary)]'
              }`}
            >
              {m.content || '…'}
            </div>
          </div>
        ))}
      </div>
      <form onSubmit={send} className="flex gap-2 px-3 pb-3">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入消息…"
          aria-label="迷你聊天输入"
          className="h-9 min-w-0 flex-1 rounded-lg border-0 bg-transparent px-3 text-xs text-[var(--text)] outline-none transition-shadow placeholder:text-[var(--text-muted)] focus:shadow-[0_0_0_2px_var(--accent-ring)]"
        />
        <Button type="submit" size="icon" disabled={!input.trim() || sending} loading={sending} aria-label="发送">
          <Send className="size-4" />
        </Button>
      </form>
    </div>
  )
}
