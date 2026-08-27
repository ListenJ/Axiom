/**
 * 搜索 Hub 四个面板（自 pages/Search.tsx 抽出，保持页面 < 600 行）
 *
 * SearchPanel / ResearchPanel / TrendsPanel / OcrPanel
 */
import { useEffect, useState } from 'react'
import {
  Search as SearchIcon,
  Code,
  FileText,
  SlidersHorizontal,
  X,
  ExternalLink,
  Sparkles,
  AlertCircle,
  BarChart3,
  MessageSquare,
  Cpu,
  CheckCircle2,
  ScanText,
  Upload,
  Download,
} from 'lucide-react'
import {
  ShimmerCard,
  Button,
  Input,
  Textarea,
  Tabs,
  Skeleton,
  InlineEmptyState,
  BarChart,
  StatCard,
  LoadingDots,
} from '@/components/ui'
import { useApp } from '@/state/useApp'
import { endpoints } from '@/lib/api'
/* ── 搜索 ─────────────────────────────────────────────────────── */

interface SearchResult {
  title: string
  type: 'code' | 'note'
  snippet?: string
  path?: string
}

type SearchSource = 'all' | 'vault' | 'code' | 'web'
type ViewMode = 'list' | 'compact'

export function SearchPanel() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<SearchSource>('all')
  const [view, setView] = useState<ViewMode>('list')
  const [showFilters, setShowFilters] = useState(false)

  useEffect(() => {
    if (!q.trim()) { setResults([]); return }
    let cancelled = false
    setLoading(true)
    setError(null)
    const timer = setTimeout(() => {
      const queries: Promise<SearchResult[]>[] = []
      if (source === 'all' || source === 'vault') queries.push(endpoints.search.vault(q).then(toList).catch(() => []))
      if (source === 'all' || source === 'code') queries.push(endpoints.search.code(q).then(toList).catch(() => []))
      if (source === 'all' || source === 'web') queries.push(endpoints.search.web(q).then(toList).catch(() => []))
      Promise.allSettled(queries)
        .then((settled) => {
          if (cancelled) return
          setResults(settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])))
        })
        .catch((e) => !cancelled && setError(String(e?.message ?? e)))
        .finally(() => !cancelled && setLoading(false))
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [q, source])

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <Input
            autoFocus
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索关键词…"
            aria-label="搜索关键词"
            iconLeft={<SearchIcon className="size-4 text-[var(--text-muted)]" />}
          />
        </div>
        <Button
          variant={showFilters ? 'secondary' : 'outline'}
          size="icon"
          onClick={() => setShowFilters(!showFilters)}
          aria-label="搜索设置"
          aria-expanded={showFilters}
          icon={showFilters ? <X className="size-4" /> : <SlidersHorizontal className="size-4" />}
        />
      </div>

      {showFilters && (
        <div className="animate-fadeIn rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--text-secondary)]">搜索范围</p>
            <div className="flex gap-2">
              {(['all', 'vault', 'code', 'web'] as const).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={source === s ? 'primary' : 'secondary'}
                  onClick={() => setSource(s)}
                >
                  {s === 'all' ? '全部' : s === 'vault' ? '笔记' : s === 'code' ? '代码' : '全网'}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--text-secondary)]">显示方式</p>
            <div className="flex gap-2">
              {(['list', 'compact'] as const).map((v) => (
                <Button
                  key={v}
                  size="sm"
                  variant={view === v ? 'primary' : 'secondary'}
                  onClick={() => setView(v)}
                >
                  {v === 'list' ? '列表' : '紧凑'}
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}

      {q && results.length > 0 && (
        <p className="text-xs text-[var(--text-muted)]">
          共 {results.length} 条结果
        </p>
      )}

      {loading && (
        <div className="space-y-3" aria-busy="true" aria-label="正在搜索">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <Skeleton className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && q && results.length === 0 && (
        <InlineEmptyState icon={<SearchIcon className="size-5" />} title="没有匹配结果" />
      )}

      <div className={`stagger ${view === 'compact' ? 'space-y-1' : 'space-y-3'}`}>
        {results.map((r, i) => {
          const Icon = r.type === 'code' ? Code : FileText
          return view === 'compact' ? (
            <div key={i} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-[var(--text)] hover:bg-[var(--surface-hover)] transition-colors">
              <Icon className="size-3.5 shrink-0 text-[var(--text-muted)]" />
              <span className="truncate">{r.title}</span>
              {r.path && <span className="ml-auto shrink-0 truncate text-xs text-[var(--text-muted)]">{r.path}</span>}
            </div>
          ) : (
            <ShimmerCard key={i}>
              <div className="flex items-start gap-3">
                <Icon className="mt-0.5 size-4 text-[var(--accent)]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-[var(--text)]">{r.title}</p>
                  {r.snippet && (
                    <p className="mt-1 line-clamp-2 text-sm text-[var(--text-secondary)]">{r.snippet}</p>
                  )}
                  {r.path && (
                    <p className="mt-1 truncate text-xs text-[var(--text-muted)]">{r.path}</p>
                  )}
                </div>
              </div>
            </ShimmerCard>
          )
        })}
      </div>
    </div>
  )
}

function toList(raw: unknown): SearchResult[] {
  // 后端返回形态：数组直接使用；对象则取 symbols / results 数组
  // （vault: {results}, codegraph: {symbols}, web-search: {results}）
  let arr: unknown[] = []
  if (Array.isArray(raw)) {
    arr = raw
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (Array.isArray(obj.symbols)) arr = obj.symbols
    else if (Array.isArray(obj.results)) arr = obj.results
  }
  return arr.map((item) => {
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>
      const node = (o.node && typeof o.node === 'object' ? o.node : null) as Record<string, unknown> | null
      const note = (o.note && typeof o.note === 'object' ? o.note : null) as Record<string, unknown> | null
      const title = String(
        node?.name ?? note?.title ?? o.title ?? o.name ?? o.path ?? o.link ?? 'Untitled',
      )
      return {
        title,
        type: (o.type === 'code' || o.kind === 'code' || o.kind === 'function' || o.kind === 'class' || o.kind === 'variable' ? 'code' : 'note') as 'code' | 'note',
        snippet: typeof o.snippet === 'string'
          ? o.snippet
          : typeof o.excerpt === 'string'
            ? o.excerpt
            : undefined,
        path: typeof o.path === 'string'
          ? o.path
          : typeof node?.filePath === 'string'
            ? node.filePath
            : typeof note?.path === 'string'
              ? note.path
              : typeof o.link === 'string'
                ? o.link
                : typeof o.url === 'string'
                  ? o.url
                  : undefined,
      }
    }
    return { title: String(item), type: 'note' as const }
  })
}

/* ── 深度研究 ─────────────────────────────────────────────────── */

interface ResearchSource {
  title: string
  link: string
  snippet: string
  source: string
}

interface ResearchResult {
  query: string
  summary?: string
  sources: ResearchSource[]
  entities?: Array<{ name: string; type: string }>
  depth?: number
}

export function ResearchPanel() {
  const [query, setQuery] = useState('')
  const [depth, setDepth] = useState(3)
  const [maxSources, setMaxSources] = useState(10)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ResearchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const toast = useApp((s) => s.toast)

  const handleRun = async () => {
    const q = query.trim()
    if (!q) {
      toast('请输入研究问题', 'warning')
      return
    }
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await endpoints.research.run({ query: q, depth, maxSources })
      const body = res as { success?: boolean; data?: Partial<ResearchResult> } | Partial<ResearchResult>
      const r = ((body as { data?: Partial<ResearchResult> }).data ?? body) as Partial<ResearchResult>
      setResult({
        query: q,
        summary: r.summary,
        sources: Array.isArray(r.sources) ? r.sources : [],
        entities: Array.isArray(r.entities) ? r.entities : [],
        depth,
      })
      toast('研究完成', 'success')
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      setError(msg)
      toast('研究失败：' + msg, 'error')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-6">
      <ShimmerCard>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--text)]">
          <Sparkles className="size-4 text-[var(--accent)]" />
          研究问题
        </h2>
        <div className="space-y-3">
          <Textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={3}
            placeholder="输入研究问题"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              type="number"
              label="搜索深度 (1-5)"
              min={1}
              max={5}
              value={depth}
              onChange={(e) => setDepth(Math.max(1, Math.min(5, Number(e.target.value) || 3)))}
            />
            <Input
              type="number"
              label="最大来源数"
              min={1}
              max={50}
              value={maxSources}
              onChange={(e) => setMaxSources(Math.max(1, Math.min(50, Number(e.target.value) || 10)))}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={handleRun}
              loading={running}
              disabled={!query.trim()}
              icon={<SearchIcon className="size-4" />}
            >
              {running ? '研究中…' : '开始研究'}
            </Button>
            {running && <LoadingDots size="sm" label="正在检索源" />}
          </div>
        </div>
      </ShimmerCard>

      {error && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          <AlertCircle className="size-4" />
          {error}
        </p>
      )}

      {result && (
        <>
          {result.summary && (
            <ShimmerCard>
              <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--text)]">
                <Sparkles className="size-4 text-[var(--accent)]" />
                研究摘要
              </h2>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--text)]">
                {result.summary}
              </p>
            </ShimmerCard>
          )}

          {result.entities && result.entities.length > 0 && (
            <ShimmerCard>
              <h2 className="mb-3 text-base font-semibold text-[var(--text)]">
                相关实体 ({result.entities.length})
              </h2>
              <div className="flex flex-wrap gap-2">
                {result.entities.map((e, i) => (
                  <span
                    key={i}
                    className="rounded-full border border-[var(--border)] bg-[var(--surface-high)] px-3 py-1 text-xs text-[var(--text-secondary)]"
                  >
                    {e.name} <span className="text-[var(--text-muted)]">· {e.type}</span>
                  </span>
                ))}
              </div>
            </ShimmerCard>
          )}

          <ShimmerCard>
            <h2 className="mb-3 text-base font-semibold text-[var(--text)]">
              参考来源 ({result.sources.length})
            </h2>
            {result.sources.length === 0 ? (
              <InlineEmptyState
                icon={<SearchIcon className="size-5" />}
                title="未找到来源"
              />
            ) : (
              <div className="space-y-2">
                {result.sources.map((s, i) => (
                  <a
                    key={i}
                    // 仅放行 http(s) 链接；第三方来源可能返回 javascript: 等恶意协议，
                    // href 为 undefined 时 React 不渲染该属性，锚点变为不可点击纯文本
                    href={/^https?:\/\//i.test(s.link) ? s.link : undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="press block rounded-lg border border-[var(--border)] p-3 transition-colors hover:bg-[var(--surface-hover)] hover:border-[var(--border-hover)]"
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-1 text-sm font-medium text-[var(--text)]">
                          {s.title}
                        </p>
                        {s.snippet && (
                          <p className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">
                            {s.snippet}
                          </p>
                        )}
                        <p className="mt-1 truncate font-mono text-2xs text-[var(--text-muted)]">
                          {s.source} · {s.link}
                        </p>
                      </div>
                      <ExternalLink className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                    </div>
                  </a>
                ))}
              </div>
            )}
          </ShimmerCard>
        </>
      )}
    </div>
  )
}

/* ── 趋势 ─────────────────────────────────────────────────────── */

interface TrendsData {
  days: number
  searchTrend: Array<{ day: string; count: number }>
  chatTrend: Array<{ day: string; count: number }>
  modelTrend: Array<{ model_name: string; count: number; avg_latency: number }>
  taskTrend: Array<{ status: string; count: number }>
  generatedAt: string
}

type TrendTab = 'search' | 'chat' | 'models' | 'tasks'
const TREND_TABS = [
  { id: 'search', label: '搜索', icon: <SearchIcon className="size-3.5" /> },
  { id: 'chat', label: '对话', icon: <MessageSquare className="size-3.5" /> },
  { id: 'models', label: '模型', icon: <Cpu className="size-3.5" /> },
  { id: 'tasks', label: '任务', icon: <CheckCircle2 className="size-3.5" /> },
] as const

export function TrendsPanel() {
  const [data, setData] = useState<TrendsData | null>(null)
  const [days, setDays] = useState(7)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TrendTab>('search')

  useEffect(() => {
    setLoading(true)
    setError(null)
    endpoints.trends
      .summary(days)
      .then((d) => setData(d as TrendsData))
      .catch((e) => setError(String((e as Error)?.message ?? e)))
      .finally(() => setLoading(false))
  }, [days])

  const totalSearches = data?.searchTrend?.reduce((s, d) => s + d.count, 0) ?? 0
  const totalChats = data?.chatTrend?.reduce((s, d) => s + d.count, 0) ?? 0

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--text-secondary)]">搜索、对话、模型调用、任务的趋势统计。</p>
        <Tabs
          tabs={[
            { id: '1', label: '1 天' },
            { id: '7', label: '7 天' },
            { id: '30', label: '30 天' },
            { id: '90', label: '90 天' },
          ]}
          active={String(days)}
          onChange={(id) => setDays(Number(id) as 1 | 7 | 30 | 90)}
          size="sm"
        />
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--warning-soft)] bg-[var(--warning-soft)] px-3 py-2 text-sm text-[var(--warning)]"
        >
          趋势数据暂不可用：{error}
        </p>
      )}

      <section className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4" aria-busy={loading}>
        <StatCard label="总搜索量" value={totalSearches} icon={<SearchIcon className="size-4" />} accent="default" loading={loading} />
        <StatCard label="总对话数" value={totalChats} icon={<MessageSquare className="size-4" />} accent="success" loading={loading} />
        <StatCard label="活跃模型" value={data?.modelTrend?.length ?? 0} icon={<Cpu className="size-4" />} accent="info" loading={loading} />
        <StatCard label="任务状态" value={data?.taskTrend?.length ?? 0} icon={<CheckCircle2 className="size-4" />} accent="warning" loading={loading} />
      </section>

      <Tabs
        tabs={TREND_TABS.map((t) => ({ id: t.id, label: t.label, icon: t.icon }))}
        active={activeTab}
        onChange={(id) => setActiveTab(id as TrendTab)}
        fullWidth={false}
      />

      {activeTab === 'search' && (
        <ShimmerCard>
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--text)]">
            <SearchIcon className="size-4 text-[var(--accent)]" />
            搜索趋势
          </h2>
          {loading ? (
            <Skeleton height="10rem" />
          ) : data?.searchTrend?.length ? (
            <BarChart
              data={data.searchTrend.map((d) => ({ label: d.day.slice(5), value: d.count }))}
              color="accent"
            />
          ) : (
            <InlineEmptyState icon={<SearchIcon className="size-5" />} title="暂无搜索数据" />
          )}
        </ShimmerCard>
      )}

      {activeTab === 'chat' && (
        <ShimmerCard>
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--text)]">
            <MessageSquare className="size-4 text-[var(--accent)]" />
            对话趋势
          </h2>
          {loading ? (
            <Skeleton height="10rem" />
          ) : data?.chatTrend?.length ? (
            <BarChart
              data={data.chatTrend.map((d) => ({ label: d.day.slice(5), value: d.count }))}
              color="success"
            />
          ) : (
            <InlineEmptyState icon={<MessageSquare className="size-5" />} title="暂无对话数据" />
          )}
        </ShimmerCard>
      )}

      {activeTab === 'models' && (
        <ShimmerCard>
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--text)]">
            <Cpu className="size-4 text-[var(--accent)]" />
            模型调用 ({data?.modelTrend?.length ?? 0})
          </h2>
          {loading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} height="2rem" />
              ))}
            </div>
          ) : !data?.modelTrend?.length ? (
            <InlineEmptyState icon={<Cpu className="size-5" />} title="暂无模型调用" />
          ) : (
            <div className="space-y-2">
              {data.modelTrend.map((m, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-lg border border-[var(--border)] p-2 text-sm transition-colors hover:bg-[var(--surface-hover)]"
                >
                  <span className="truncate font-medium text-[var(--text)]" title={m.model_name}>
                    {m.model_name}
                  </span>
                  <div className="flex shrink-0 items-center gap-4 text-xs text-[var(--text-muted)]">
                    <span>{m.count} 次</span>
                    <span>~{Math.round(m.avg_latency ?? 0)}ms</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ShimmerCard>
      )}

      {activeTab === 'tasks' && (
        <ShimmerCard>
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--text)]">
            <BarChart3 className="size-4 text-[var(--accent)]" />
            任务状态分布
          </h2>
          {!data?.taskTrend?.length ? (
            <InlineEmptyState icon={<CheckCircle2 className="size-5" />} title="暂无任务" />
          ) : (
            <div className="flex flex-wrap gap-3">
              {data.taskTrend.map((t, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface-high)]/50 px-3 py-2"
                >
                  <p className="text-xs text-[var(--text-muted)]">{t.status}</p>
                  <p className="text-lg font-semibold text-[var(--text)]">{t.count}</p>
                </div>
              ))}
            </div>
          )}
        </ShimmerCard>
      )}
    </div>
  )
}

/* ── OCR ──────────────────────────────────────────────────────── */

interface OcrStatus {
  ready: boolean
  languages: string[]
  version?: string
}

export function OcrPanel() {
  const [status, setStatus] = useState<OcrStatus | null>(null)
  const [path, setPath] = useState('')
  const [languages, setLanguages] = useState<string[]>(['eng'])
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const toast = useApp((s) => s.toast)

  useEffect(() => {
    endpoints.ocr
      .status()
      .then((d) => {
        const s = d as Partial<OcrStatus> & { status?: string; supportedLanguages?: string[] }
        setStatus({ ready: s.status === 'ready', languages: s.supportedLanguages ?? ['eng'] })
        if (s.supportedLanguages?.length) setLanguages(s.supportedLanguages)
      })
      .catch((e) => setError(String((e as Error)?.message ?? e)))
  }, [])

  const handleScan = async () => {
    if (!path.trim()) {
      toast('请输入文件路径', 'warning')
      return
    }
    setScanning(true)
    setError(null)
    setResult(null)
    try {
      const res = await endpoints.ocr.scan({ path: path.trim(), languages })
      const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2)
      setResult(text)
      toast('扫描完成', 'success')
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      setError(msg)
      toast('扫描失败：' + msg, 'error')
    } finally {
      setScanning(false)
    }
  }

  const handleExport = async (format: 'md' | 'txt' | 'json') => {
    if (!result) return
    try {
      const res = await endpoints.ocr.export({ path: path.trim(), format })
      const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2)
      const blob = new Blob([text], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${path.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') ?? 'ocr'}.${format}`
      a.click()
      URL.revokeObjectURL(url)
      toast('导出成功', 'success')
    } catch (e) {
      toast('导出失败：' + ((e as Error)?.message ?? String(e)), 'error')
    }
  }

  return (
    <div className="space-y-6">
      {status && (
        <div
          role="status"
          aria-label={`OCR ${status.ready ? '就绪' : '未就绪'}`}
          className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
            status.ready
              ? 'border-[var(--success-soft)] bg-[var(--success-soft)] text-[var(--success)]'
              : 'border-[var(--warning-soft)] bg-[var(--warning-soft)] text-[var(--warning)]'
          }`}
        >
          {status.ready ? (
            <CheckCircle2 className="size-4" />
          ) : (
            <AlertCircle className="size-4" />
          )}
          <span>
            OCR {status.ready ? '就绪' : '未就绪'}
          </span>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          <AlertCircle className="size-4" />
          {error}
        </p>
      )}

      <ShimmerCard>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--text)]">
          <Upload className="size-4 text-[var(--accent)]" />
          扫描文档
        </h2>
        <div className="space-y-3">
          <Input
            id="ocr-path"
            label="文件路径"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/path/to/image.png"
          />
          <Input
            id="ocr-languages"
            label="识别语言（逗号分隔）"
            value={languages.join(',')}
            onChange={(e) =>
              setLanguages(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))
            }
            placeholder="eng, chi_sim"
          />
          <Button
            onClick={handleScan}
            loading={scanning}
            disabled={!path.trim()}
            icon={<ScanText className="size-4" />}
          >
            {scanning ? '扫描中…' : '开始扫描'}
          </Button>
          {scanning && (
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <LoadingDots size="sm" />
              正在处理图像…
            </div>
          )}
        </div>
      </ShimmerCard>

      {result && (
        <ShimmerCard>
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--text)]">
              <FileText className="size-4 text-[var(--accent)]" />
              识别结果
            </h2>
            <div className="flex gap-1">
              {(['md', 'txt', 'json'] as const).map((fmt) => (
                <Button
                  key={fmt}
                  size="sm"
                  variant="secondary"
                  onClick={() => handleExport(fmt)}
                  icon={<Download className="size-3" />}
                >
                  {fmt.toUpperCase()}
                </Button>
              ))}
            </div>
          </div>
          <pre className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--text-secondary)]">
            {result}
          </pre>
        </ShimmerCard>
      )}
    </div>
  )
}