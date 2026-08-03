import { useEffect, useState } from 'react'
import { BarChart3, Zap, RefreshCw, Play, Settings } from 'lucide-react'
import {
  ShimmerCard,
  Button,
  PageHeader,
  Tabs,
  Select,
  Skeleton,
  InlineEmptyState,
} from '@/components/ui'
import { endpoints } from '@/lib/api'
import {
  normalizeEvalResults,
  normalizeEvalAssignments,
  normalizeEvalModels,
  type EvalResult,
  type EvalAssignment,
  type EvalModel,
} from '@/lib/normalize'

interface EvalStats {
  totalModels?: number
  evaluatedModels?: number
  avgScore?: number
  lastEvalTime?: string
  activeAssignments?: number
}

export default function Eval() {
  const [stats, setStats] = useState<EvalStats | null>(null)
  const [results, setResults] = useState<EvalResult[]>([])
  const [assignments, setAssignments] = useState<EvalAssignment[]>([])
  const [models, setModels] = useState<EvalModel[]>([])
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [activeTab, setActiveTab] = useState<'results' | 'assignments' | 'models'>('results')
  const [sortBy, setSortBy] = useState<'overall' | 'quality' | 'speed' | 'cost'>('overall')
  const [days, setDays] = useState(7)

  useEffect(() => {
    Promise.allSettled([
      endpoints.eval.stats().then((d) => d as EvalStats).catch(() => null),
      endpoints.eval.results({ days, sortBy, limit: 50 }).then((d) => normalizeEvalResults(d)).catch(() => []),
      endpoints.eval.assignments().then((d) => normalizeEvalAssignments(d)).catch(() => []),
      endpoints.eval.models({ limit: 50 }).then((d) => normalizeEvalModels(d)).catch(() => []),
    ]).then(([s, r, a, m]) => {
      setStats(s.status === 'fulfilled' ? s.value : null)
      setResults(r.status === 'fulfilled' ? r.value : [])
      setAssignments(a.status === 'fulfilled' ? a.value : [])
      setModels(m.status === 'fulfilled' ? m.value : [])
      const failed = [s, r, a, m].find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined
      if (failed) setError(String(failed.reason?.message ?? failed.reason))
    })
  }, [days, sortBy])

  const handleRunEval = async (mode: 'quick' | 'full') => {
    setRunning(true)
    try {
      await endpoints.eval.run({ mode })
      const [s, r] = await Promise.allSettled([
        endpoints.eval.stats(),
        endpoints.eval.results({ days, sortBy, limit: 50 }),
      ])
      if (s.status === 'fulfilled') setStats(s.value as EvalStats)
      if (r.status === 'fulfilled') setResults(normalizeEvalResults(r.value))
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }

  const handleAssign = async () => {
    setRunning(true)
    try {
      await endpoints.eval.assign()
      const a = await endpoints.eval.assignments()
      setAssignments(normalizeEvalAssignments(a))
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }

  const loading = stats === null
  const sortedResults = [...results].sort((a, b) => b[sortBy] - a[sortBy])

  const getScoreColor = (score: number) => {
    if (score >= 0.8) return 'text-[var(--success)]'
    if (score >= 0.6) return 'text-[var(--warning)]'
    return 'text-[var(--danger)]'
  }

  const tabs = [
    { id: 'results' as const, label: '评估结果', icon: <BarChart3 className="size-3.5" /> },
    { id: 'assignments' as const, label: '动态分配', icon: <Settings className="size-3.5" /> },
    { id: 'models' as const, label: '模型列表', icon: <Zap className="size-3.5" /> },
  ]

  return (
    <div className="space-y-6">
        <PageHeader
          icon={<BarChart3 className="size-5" />}
          title="模型评估"
          actions={
          <>
            <Button
              size="sm"
              onClick={() => handleRunEval('quick')}
              loading={running}
              icon={running ? <RefreshCw className="size-3.5" /> : <Play className="size-3.5" />}
            >
              快速评估
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleAssign}
              disabled={running}
              icon={<Settings className="size-3.5" />}
            >
              重新分配
            </Button>
          </>
        }
      />

      {error && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-[var(--warning-soft)] bg-[var(--warning-soft)] px-3 py-2 text-sm text-[var(--warning)]"
        >
          部分数据暂不可用：{error}
        </p>
      )}

      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4" aria-busy={loading}>
        <ShimmerCard glow>
          <p className="text-sm text-[var(--text-muted)]">已评估模型</p>
          {loading ? (
            <Skeleton className="mt-2" width="4rem" height="2rem" rounded="md" />
          ) : (
            <p className="mt-1 text-3xl font-bold">
              {stats?.evaluatedModels ?? 0}
              <span className="ml-1 text-sm text-[var(--text-muted)]">/ {stats?.totalModels ?? 0}</span>
            </p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-[var(--text-muted)]">平均分</p>
          {loading ? (
            <Skeleton className="mt-2" width="4rem" height="2rem" rounded="md" />
          ) : (
            <p className={`mt-1 text-3xl font-bold ${getScoreColor(stats?.avgScore ?? 0)}`}>
              {stats?.avgScore !== undefined ? `${(stats.avgScore * 100).toFixed(1)}%` : '—'}
            </p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-[var(--text-muted)]">活跃分配</p>
          {loading ? (
            <Skeleton className="mt-2" width="3rem" height="2rem" rounded="md" />
          ) : (
            <p className="mt-1 text-3xl font-bold">{stats?.activeAssignments ?? 0}</p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-[var(--text-muted)]">上次评估</p>
          {loading ? (
            <Skeleton className="mt-2" width="5rem" height="2rem" rounded="md" />
          ) : (
            <p className="mt-1 text-lg font-bold">
              {stats?.lastEvalTime ? new Date(stats.lastEvalTime).toLocaleDateString() : '—'}
            </p>
          )}
        </ShimmerCard>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          tabs={tabs}
          active={activeTab}
          onChange={(id) => setActiveTab(id as typeof activeTab)}
        />
        {activeTab === 'results' && (
          <>
            <Select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="w-28"
            >
              <option value="overall">综合分</option>
              <option value="quality">质量</option>
              <option value="speed">速度</option>
              <option value="cost">成本</option>
            </Select>
            <Select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="w-24"
            >
              <option value={1}>1 天</option>
              <option value={7}>7 天</option>
              <option value={30}>30 天</option>
              <option value={90}>90 天</option>
            </Select>
          </>
        )}
      </div>

      {activeTab === 'results' && (
        <ShimmerCard>
          {loading ? (
            <div className="space-y-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} height="3rem" rounded="md" />
              ))}
            </div>
          ) : sortedResults.length === 0 ? (
            <InlineEmptyState
              icon={<BarChart3 className="size-5" />}
              title="暂无评估结果"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
                    <th className="pb-2 font-medium">模型</th>
                    <th className="pb-2 font-medium">提供商</th>
                    <th className="pb-2 font-medium">综合</th>
                    <th className="pb-2 font-medium">质量</th>
                    <th className="pb-2 font-medium">速度</th>
                    <th className="pb-2 font-medium">成本</th>
                    <th className="pb-2 font-medium">上次评估</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedResults.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-[var(--border)]/50 hover:bg-[var(--surface-hover)]/50"
                    >
                      <td className="py-3 font-medium">{r.id}</td>
                      <td className="py-3 text-[var(--text-muted)]">{r.provider}</td>
                      <td className={`py-3 font-bold ${getScoreColor(r.overall)}`}>
                        {(r.overall * 100).toFixed(1)}%
                      </td>
                      <td className="py-3">{(r.quality * 100).toFixed(1)}%</td>
                      <td className="py-3">{(r.speed * 100).toFixed(1)}%</td>
                      <td className="py-3">{(r.cost * 100).toFixed(1)}%</td>
                      <td className="py-3 text-[var(--text-muted)]">
                        {new Date(r.lastEvaluated).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ShimmerCard>
      )}

      {activeTab === 'assignments' && (
        <ShimmerCard>
          {loading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} height="4rem" rounded="md" />
              ))}
            </div>
          ) : assignments.length === 0 ? (
            <InlineEmptyState
              icon={<Settings className="size-5" />}
              title="暂无活跃分配"
            />
          ) : (
            <div className="space-y-3">
              {assignments.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between rounded-xl border border-[var(--border)] p-4 transition-colors hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
                      <Zap className="size-5 text-[var(--accent)]" />
                    </div>
                    <div>
                      <p className="font-medium text-[var(--text)]">{a.role}</p>
                      <p className="text-sm text-[var(--text-muted)]">
                        {a.model} ({a.provider})
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={`font-bold ${getScoreColor(a.score)}`}>
                      {(a.score * 100).toFixed(1)}%
                    </p>
                    <p className="text-xs text-[var(--text-muted)]">
                      {new Date(a.lastAssigned).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ShimmerCard>
      )}

      {activeTab === 'models' && (
        <ShimmerCard>
          {loading ? (
            <div className="space-y-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} height="3.5rem" rounded="md" />
              ))}
            </div>
          ) : models.length === 0 ? (
            <InlineEmptyState
              icon={<Zap className="size-5" />}
              title="暂无可用模型"
            />
          ) : (
            <div className="space-y-2">
              {models.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between rounded-xl border border-[var(--border)] p-3 transition-colors hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex size-8 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
                      <Zap className="size-4 text-[var(--accent)]" />
                    </div>
                    <div>
                      <p className="font-medium text-[var(--text)]">{m.name}</p>
                      <p className="text-xs text-[var(--text-muted)]">{m.provider}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-6 text-sm text-[var(--text-muted)]">
                    <span>上下文: {m.contextLength.toLocaleString()}</span>
                    <span>${(m.pricing.prompt * 1000).toFixed(4)}/1K</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ShimmerCard>
      )}
    </div>
  )
}
