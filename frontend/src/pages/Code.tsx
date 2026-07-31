import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Code2,
  RefreshCw,
  FileCode,
  Network,
  AlertTriangle,
  Layers,
  Share2,
  GitBranch,
} from 'lucide-react'
import {
  ShimmerCard,
  StatCard,
  Button,
  PageHeader,
  InlineEmptyState,
  Skeleton,
  Tabs,
} from '@/components/ui'
import { FadeIn } from '@/components/motion'
import { endpoints } from '@/lib/api'

type CodeTab = 'search' | 'graph'

export default function Code() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab: CodeTab = searchParams.get('tab') === 'graph' ? 'graph' : 'search'
  const setTab = (id: string) =>
    setSearchParams(id === 'search' ? {} : { tab: id }, { replace: true })

  return (
    <div className="space-y-6 fade-in">
      <PageHeader
        icon={<Code2 className="size-5" />}
        title="代码"
        description="代码搜索与知识图谱。"
      />

      <Tabs
        tabs={[
          { id: 'search', label: '代码搜索', icon: <Code2 className="size-4" /> },
          { id: 'graph', label: '图谱', icon: <Network className="size-4" /> },
        ]}
        active={tab}
        onChange={setTab}
      />

      <FadeIn key={tab} className="space-y-6">
        {tab === 'search' ? <SearchTab /> : <GraphTab />}
      </FadeIn>
    </div>
  )
}

interface CodegraphStatus {
  indexed?: number
  status?: string
  last_build?: string
}

function SearchTab() {
  const [status, setStatus] = useState<CodegraphStatus | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, f] = await Promise.all([
        endpoints.codegraph.status(),
        endpoints.codegraph.fileIndex().catch(() => []),
      ])
      setStatus((s as CodegraphStatus) ?? null)
      setFiles(toFileList(f))
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-[var(--text-secondary)]">CodeGraph 索引状态与文件列表。</p>
        <Button
          onClick={refresh}
          loading={loading}
          size="sm"
          icon={<RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />}
        >
          刷新
        </Button>
      </div>

      {error && (
        <ShimmerCard variant="muted">
          <p role="alert" className="text-sm text-[var(--danger)]">
            加载失败：{error}
          </p>
        </ShimmerCard>
      )}

      <section className="stagger grid grid-cols-1 gap-4 sm:grid-cols-3" aria-busy={loading && !status}>
        <StatCard label="已索引文件" value={status?.indexed ?? '—'} icon={<FileCode className="size-4" />} accent="default" loading={loading && !status} />
        <StatCard label="状态" value={status?.status ?? '未知'} icon={<Code2 className="size-4" />} accent="success" loading={loading && !status} />
        <StatCard label="最近构建" value={status?.last_build ?? '—'} icon={<RefreshCw className="size-4" />} accent="info" loading={loading && !status} />
      </section>

      <ShimmerCard>
        <h2 className="mb-3 text-base font-semibold text-[var(--text)]">文件列表</h2>
        {loading && files.length === 0 ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} height="1rem" />
            ))}
          </div>
        ) : files.length === 0 ? (
          <InlineEmptyState
            icon={<FileCode className="size-5" />}
            title="暂无文件"
            description="请先运行 CodeGraph 索引。"
          />
        ) : (
          <ul className="max-h-80 space-y-1 overflow-y-auto font-mono text-xs text-[var(--text-secondary)]">
            {files.map((f, i) => (
              <li key={i} className="truncate rounded px-2 py-1 transition-colors hover:bg-[var(--surface-hover)]">
                {f}
              </li>
            ))}
          </ul>
        )}
      </ShimmerCard>
    </div>
  )
}

interface KgStats {
  entities?: number
  relations?: number
  communities?: number
}

function GraphTab() {
  const [stats, setStats] = useState<KgStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loading = stats === null

  useEffect(() => {
    endpoints.kg.stats().then((d) => setStats(d as KgStats)).catch((e) => setError(String((e as Error)?.message ?? e)))
  }, [])

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      {error && (
        <p role="alert" className="flex items-center gap-2 rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          <AlertTriangle className="size-4" />
          {error}
        </p>
      )}

      <section className="stagger grid grid-cols-3 gap-3" aria-busy={loading}>
        <StatCard label="实体" value={stats?.entities ?? '—'} icon={<Layers className="size-4" />} accent="default" loading={loading} />
        <StatCard label="关系" value={stats?.relations ?? '—'} icon={<Share2 className="size-4" />} accent="info" loading={loading} />
        <StatCard label="社区" value={stats?.communities ?? '—'} icon={<GitBranch className="size-4" />} accent="success" loading={loading} />
      </section>

      <ShimmerCard variant="muted">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <Network className="size-4 text-[var(--accent)]" />
          关于知识图谱
        </h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          知识图谱使用 SQLite 本地存储。实体、关系和社区数据通过图谱分析管道构建。
        </p>
      </ShimmerCard>
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
