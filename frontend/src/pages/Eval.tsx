import { useEffect, useState } from 'react'
import { BarChart3, Zap, RefreshCw, Play, Settings } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
import { endpoints } from '@/lib/api'

interface EvalStats {
  totalModels?: number
  evaluatedModels?: number
  avgScore?: number
  lastEvalTime?: string
  activeAssignments?: number
}

interface EvalResult {
  id: string
  provider: string
  overall: number
  quality: number
  speed: number
  cost: number
  lastEvaluated: string
}

interface EvalAssignment {
  id: string
  role: string
  model: string
  provider: string
  score: number
  lastAssigned: string
}

interface EvalModel {
  id: string
  name: string
  provider: string
  contextLength: number
  pricing: { prompt: number; completion: number }
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
      endpoints.eval.results({ days, sortBy, limit: 50 }).then((d) => d as EvalResult[]).catch(() => []),
      endpoints.eval.assignments().then((d) => d as EvalAssignment[]).catch(() => []),
      endpoints.eval.models({ limit: 50 }).then((d) => d as EvalModel[]).catch(() => []),
    ]).then(([s, r, a, m]) => {
      setStats(s.status === 'fulfilled' ? s.value : null)
      setResults(r.status === 'fulfilled' ? (r.value as EvalResult[]) : [])
      setAssignments(a.status === 'fulfilled' ? (a.value as EvalAssignment[]) : [])
      setModels(m.status === 'fulfilled' ? (m.value as EvalModel[]) : [])
      const failed = [s, r, a, m].find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined
      if (failed) setError(String(failed.reason?.message ?? failed.reason))
    })
  }, [days, sortBy])

  const handleRunEval = async (mode: 'quick' | 'full') => {
    setRunning(true)
    try {
      await endpoints.eval.run({ mode })
      // Refresh data after eval
      const [s, r] = await Promise.allSettled([
        endpoints.eval.stats(),
        endpoints.eval.results({ days, sortBy, limit: 50 }),
      ])
      if (s.status === 'fulfilled') setStats(s.value as EvalStats)
      if (r.status === 'fulfilled') setResults(r.value as EvalResult[])
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
      setAssignments(a as EvalAssignment[])
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }

  const loading = stats === null
  const sortedResults = [...results].sort((a, b) => b[sortBy] - a[sortBy])

  const getScoreColor = (score: number) => {
    if (score >= 0.8) return 'text-green-500'
    if (score >= 0.6) return 'text-yellow-500'
    return 'text-red-500'
  }

  const tabs = [
    { id: 'results' as const, label: '璇勪及缁撴灉', icon: BarChart3 },
    { id: 'assignments' as const, label: '鍔ㄦ€佸垎閰?, icon: Settings },
    { id: 'models' as const, label: '妯″瀷鍒楄〃', icon: Zap },
  ]

  return (
    <div className="fade-in stagger space-y-4">
      <header className="flex items-center justify-between">
        <div className="fade-in stagger space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <BarChart3 className="size-6 text-accent" />
            妯″瀷璇勪及
          </h1>
          <p className="text-text-secondary">璇勪及妯″瀷璐ㄩ噺銆侀€熷害鍜屾垚鏈紝鏀寔鍔ㄦ€佸垎閰嶃€?/p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => handleRunEval('quick')}
            disabled={running}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {running ? <RefreshCw className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            蹇€熻瘎浼?
          </button>
          <button
            onClick={handleAssign}
            disabled={running}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-bg-secondary disabled:opacity-50"
          >
            <Settings className="size-3.5" />
            閲嶆柊鍒嗛厤
          </button>
        </div>
      </header>

      {error && (
        <p role="alert" className="text-sm text-warning">
          閮ㄥ垎鏁版嵁鏆備笉鍙敤锛歿error}
        </p>
      )}

      {/* 缁熻鍗＄墖 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-busy={loading}>
        <ShimmerCard glow>
          <p className="text-sm text-text-muted">宸茶瘎浼版ā鍨?/p>
          {loading ? (
            <div className="mt-2 h-8 w-16 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-3xl font-bold">
              {stats?.evaluatedModels ?? 0}
              <span className="ml-1 text-sm text-text-muted">/ {stats?.totalModels ?? 0}</span>
            </p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">骞冲潎鍒?/p>
          {loading ? (
            <div className="mt-2 h-8 w-16 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className={`mt-1 text-3xl font-bold ${getScoreColor(stats?.avgScore ?? 0)}`}>
              {stats?.avgScore !== undefined ? `${(stats.avgScore * 100).toFixed(1)}%` : '鈥?}
            </p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">娲昏穬鍒嗛厤</p>
          {loading ? (
            <div className="mt-2 h-8 w-12 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-3xl font-bold">{stats?.activeAssignments ?? 0}</p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">涓婃璇勪及</p>
          {loading ? (
            <div className="mt-2 h-8 w-20 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-lg font-bold">
              {stats?.lastEvalTime ? new Date(stats.lastEvalTime).toLocaleDateString() : '鈥?}
            </p>
          )}
        </ShimmerCard>
      </div>

      {/* 绛涢€夊櫒 */}
      <div className="flex items-center gap-4">
        <div className="flex gap-1 rounded-lg border border-border p-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:bg-bg-secondary'
              }`}
            >
              <tab.icon className="size-3.5" />
              {tab.label}
            </button>
          ))}
        </div>
        {activeTab === 'results' && (
          <>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text-secondary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="overall">缁煎悎鍒?/option>
              <option value="quality">璐ㄩ噺</option>
              <option value="speed">閫熷害</option>
              <option value="cost">鎴愭湰</option>
            </select>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text-secondary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value={1}>1 澶?/option>
              <option value={7}>7 澶?/option>
              <option value={30}>30 澶?/option>
              <option value={90}>90 澶?/option>
            </select>
          </>
        )}
      </div>

      {/* 璇勪及缁撴灉 */}
      {activeTab === 'results' && (
        <ShimmerCard>
          {loading ? (
            <div className="fade-in stagger space-y-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="h-12 w-full animate-pulse rounded bg-bg-tertiary" />
              ))}
            </div>
          ) : sortedResults.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-text-muted">
              <BarChart3 className="mb-3 size-12 opacity-30" />
              <p>鏆傛棤璇勪及缁撴灉</p>
              <p className="text-sm">鐐瑰嚮"蹇€熻瘎浼?寮€濮嬭瘎浼版ā鍨?/p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-text-muted">
                    <th className="pb-2 font-medium">妯″瀷</th>
                    <th className="pb-2 font-medium">鎻愪緵鍟?/th>
                    <th className="pb-2 font-medium">缁煎悎</th>
                    <th className="pb-2 font-medium">璐ㄩ噺</th>
                    <th className="pb-2 font-medium">閫熷害</th>
                    <th className="pb-2 font-medium">鎴愭湰</th>
                    <th className="pb-2 font-medium">涓婃璇勪及</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedResults.map((r) => (
                    <tr key={r.id} className="border-b border-border/50 hover:bg-bg-secondary/50">
                      <td className="py-3 font-medium">{r.id}</td>
                      <td className="py-3 text-text-muted">{r.provider}</td>
                      <td className={`py-3 font-bold ${getScoreColor(r.overall)}`}>
                        {(r.overall * 100).toFixed(1)}%
                      </td>
                      <td className="py-3">{(r.quality * 100).toFixed(1)}%</td>
                      <td className="py-3">{(r.speed * 100).toFixed(1)}%</td>
                      <td className="py-3">{(r.cost * 100).toFixed(1)}%</td>
                      <td className="py-3 text-text-muted">
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

      {/* 鍔ㄦ€佸垎閰?*/}
      {activeTab === 'assignments' && (
        <ShimmerCard>
          {loading ? (
            <div className="fade-in stagger space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-16 w-full animate-pulse rounded bg-bg-tertiary" />
              ))}
            </div>
          ) : assignments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-text-muted">
              <Settings className="mb-3 size-12 opacity-30" />
              <p>鏆傛棤娲昏穬鍒嗛厤</p>
              <p className="text-sm">鐐瑰嚮"閲嶆柊鍒嗛厤"寮€濮嬪姩鎬佸垎閰嶆ā鍨?/p>
            </div>
          ) : (
            <div className="fade-in stagger space-y-3">
              {assignments.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between rounded-xl border border-border p-4"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-accent/10">
                      <Zap className="size-5 text-accent" />
                    </div>
                    <div>
                      <p className="font-medium">{a.role}</p>
                      <p className="text-sm text-text-muted">
                        {a.model} ({a.provider})
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={`font-bold ${getScoreColor(a.score)}`}>
                      {(a.score * 100).toFixed(1)}%
                    </p>
                    <p className="text-xs text-text-muted">
                      {new Date(a.lastAssigned).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ShimmerCard>
      )}

      {/* 妯″瀷鍒楄〃 */}
      {activeTab === 'models' && (
        <ShimmerCard>
          {loading ? (
            <div className="fade-in stagger space-y-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="h-14 w-full animate-pulse rounded bg-bg-tertiary" />
              ))}
            </div>
          ) : models.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-text-muted">
              <Zap className="mb-3 size-12 opacity-30" />
              <p>鏆傛棤鍙敤妯″瀷</p>
            </div>
          ) : (
            <div className="fade-in stagger space-y-2">
              {models.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between rounded-xl border border-border p-3 hover:bg-bg-secondary/50"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex size-8 items-center justify-center rounded-lg bg-accent/10">
                      <Zap className="size-4 text-accent" />
                    </div>
                    <div>
                      <p className="font-medium">{m.name}</p>
                      <p className="text-xs text-text-muted">{m.provider}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-6 text-sm text-text-muted">
                    <span>涓婁笅鏂? {m.contextLength.toLocaleString()}</span>
                    <span>
                      ${(m.pricing.prompt * 1000).toFixed(4)}/1K
                    </span>
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
