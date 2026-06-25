import { useEffect, useState } from 'react'
import { TrendingUp, BarChart3, Search, MessageSquare, Cpu, CheckCircle2 } from 'lucide-react'
import {
  ShimmerCard,
  Tabs,
  PageHeader,
  BarChart,
  StatCard,
  Skeleton,
  InlineEmptyState,
} from '@/components/ui'
import { endpoints } from '@/lib/api'

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
  { id: 'search', label: '搜索', icon: <Search className="size-3.5" /> },
  { id: 'chat', label: '对话', icon: <MessageSquare className="size-3.5" /> },
  { id: 'models', label: '模型', icon: <Cpu className="size-3.5" /> },
  { id: 'tasks', label: '任务', icon: <CheckCircle2 className="size-3.5" /> },
] as const

export default function Trends() {
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
    <div className="space-y-6 fade-in">
      <PageHeader
        icon={<TrendingUp className="size-5" />}
        title="趋势分析"
        description="搜索、对话、模型调用、任务的趋势统计。"
        actions={
          <Tabs
            tabs={[
              { id: '1', label: '1 天', onClick: () => setDays(1) },
              { id: '7', label: '7 天', onClick: () => setDays(7) },
              { id: '30', label: '30 天', onClick: () => setDays(30) },
              { id: '90', label: '90 天', onClick: () => setDays(90) },
            ].map((t) => ({ id: t.id, label: t.label }))}
            active={String(days)}
            onChange={(id) => setDays(Number(id) as 1 | 7 | 30 | 90)}
            size="sm"
          />
        }
      />

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--warning-soft)] bg-[var(--warning-soft)] px-3 py-2 text-sm text-[var(--warning)]"
        >
          趋势数据暂不可用：{error}
        </p>
      )}

      <section className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4" aria-busy={loading}>
        <StatCard label="总搜索量" value={totalSearches} icon={<Search className="size-4" />} accent="default" loading={loading} />
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
            <Search className="size-4 text-[var(--accent)]" />
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
            <InlineEmptyState icon={<Search className="size-5" />} title="暂无搜索数据" />
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
                  className="rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)]/50 px-3 py-2"
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
