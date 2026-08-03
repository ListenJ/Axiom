/**
 * /providers hub 的子区块组件
 *
 * 由 pages/Router.tsx、pages/Tokens.tsx、pages/Proxies.tsx、pages/Perf.tsx
 * 迁入（hub 化后原页面文件改为占位导出），以满足"页面 < 600 行"的架构约束。
 * 包含：RouterSection（路由）/ TokensSection（用量）/ ProxiesSection（代理）/ PerfSection（性能）
 */
import { useEffect, useState, useCallback } from 'react'
import {
  Compass, Heart, Coins, Globe, Shield, CheckCircle2, XCircle, Server,
  AlertTriangle, Activity, Cpu, ArrowUp, ArrowDown, Clock, HardDrive, Database,
} from 'lucide-react'
import {
  ShimmerCard, StatCard, PageHeader, InlineEmptyState, Skeleton, BarChart,
} from '@/components/ui'
import { endpoints } from '@/lib/api'
import { normalizeMetrics, normalizeNative, type PerfMetrics } from '@/lib/normalize'

// ─── 路由 ────────────────────────────────────────────────────────────────

interface RouterStatus {
  status?: string
  models?: number
  healthy?: number
  tokens?: { used: number; total: number }
}

export function RouterSection() {
  const [status, setStatus] = useState<RouterStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.allSettled([
      endpoints.router.status().then((d) => d as RouterStatus).catch(() => null),
      endpoints.router.health().then((d) => d as RouterStatus).catch(() => null),
      endpoints.router.tokenStats().then((d) => d as RouterStatus).catch(() => null),
    ]).then(([s, h, t]) => {
      const sVal = s.status === 'fulfilled' ? s.value : null
      const hVal = h.status === 'fulfilled' ? h.value : null
      const tVal = t.status === 'fulfilled' ? t.value : null
      const merged: RouterStatus = {
        status: sVal?.status ?? hVal?.status ?? 'ok',
        models: sVal?.models,
        healthy: hVal?.healthy,
        tokens: tVal?.tokens,
      }
      setStatus(merged)
      const anyError = [s, h, t].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
      if (anyError) setError(String(anyError.reason?.message ?? anyError.reason))
    })
  }, [])

  const loading = status === null

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Compass className="size-5" />}
        title="模型路由"
        description="Advisor + Health + Token 使用统计。"
      />

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--warning-soft)] bg-[var(--warning-soft)] px-3 py-2 text-sm text-[var(--warning)]"
        >
          部分指标暂不可用：{error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-busy={loading}>
        <ShimmerCard glow>
          <div className="flex items-center gap-2 text-[var(--text-muted)]">
            <Heart className="size-4" />
            <span className="text-sm">健康模型</span>
          </div>
          {loading ? (
            <>
              <Skeleton className="mt-3 h-8 w-16" />
              <Skeleton className="mt-2 h-3 w-24" />
            </>
          ) : (
            <>
              <p className="mt-2 text-3xl font-bold text-[var(--text)]">{status?.healthy ?? '—'}</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">共 {status?.models ?? '—'} 个模型</p>
            </>
          )}
        </ShimmerCard>

        <ShimmerCard>
          <div className="flex items-center gap-2 text-[var(--text-muted)]">
            <Coins className="size-4" />
            <span className="text-sm">Token 使用</span>
          </div>
          {loading ? (
            <>
              <Skeleton className="mt-3 h-8 w-24" />
              <Skeleton className="mt-2 h-3 w-20" />
            </>
          ) : (
            <>
              <p className="mt-2 text-3xl font-bold text-[var(--text)]">
                {status?.tokens ? status.tokens.used.toLocaleString() : '—'}
              </p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                / {status?.tokens ? status.tokens.total.toLocaleString() : '—'}
              </p>
            </>
          )}
        </ShimmerCard>

        <ShimmerCard>
          <div className="flex items-center gap-2 text-[var(--text-muted)]">
            <Compass className="size-4" />
            <span className="text-sm">路由状态</span>
          </div>
          {loading ? (
            <Skeleton className="mt-3 h-8 w-20" />
          ) : (
            <p className="mt-2 text-3xl font-bold capitalize text-[var(--success)]">
              {status?.status ?? '—'}
            </p>
          )}
        </ShimmerCard>
      </div>
    </div>
  )
}

// ─── 用量 ────────────────────────────────────────────────────────────────

interface TokenDetail {
  perModel: Array<{ model: string; calls: number; promptTokens: number; completionTokens: number; avgLatency: number }>
  hourlyTrend: Array<{ date: string; totalCalls: number; totalTokens: number }>
  overall: { totalTokens: number; totalCalls: number; promptTokens: number; completionTokens: number; avgLatency: number }
  recentCalls: Array<{ timestamp: number; model: string; promptTokens: number; completionTokens: number; latencyMs: number; success: boolean }>
  cacheStats: { totalCalls: number; cacheHits: number; hitRate: number }
}

export function TokensSection() {
  const [data, setData] = useState<TokenDetail | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/token-details?days=7')
      const json = await res.json()
      setData(json)
    } catch {}
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 10000)
    return () => clearInterval(interval)
  }, [fetchData])

  const modelChartData = (data?.perModel ?? []).map(m => ({
    label: m.model.length > 15 ? m.model.slice(0, 12) + '...' : m.model,
    value: m.promptTokens + m.completionTokens,
  }))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader icon={<Coins className="size-5" />} title="Token 消耗分析" description="实时监控模型调用、Token 消耗和缓存命中率" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="总 Token" value={data?.overall.totalTokens.toLocaleString() ?? '—'} icon={<Coins className="size-5" />} accent="info" />
        <StatCard label="总调用" value={data?.overall.totalCalls.toLocaleString() ?? '—'} icon={<Activity className="size-5" />} accent="success" />
        <StatCard label="输入 Token" value={data?.overall.promptTokens.toLocaleString() ?? '—'} icon={<ArrowUp className="size-5" />} accent="warning" />
        <StatCard label="输出 Token" value={data?.overall.completionTokens.toLocaleString() ?? '—'} icon={<ArrowDown className="size-5" />} accent="danger" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard label="平均延迟" value={data ? `${data.overall.avgLatency}ms` : '—'} icon={<Clock className="size-5" />} accent="default" />
        <StatCard label="缓存命中率" value={data ? `${data.cacheStats.hitRate}%` : '—'} icon={<HardDrive className="size-5" />} accent="success" />
        <StatCard label="缓存条目" value={data?.cacheStats.cacheHits.toLocaleString() ?? '—'} icon={<Database className="size-5" />} accent="info" />
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
        <h3 className="mb-3 text-sm font-medium text-[var(--text)]">Token 消耗趋势 (7天)</h3>
        {modelChartData.length > 0 ? (
          <BarChart data={modelChartData} showLabels />
        ) : (
          <p className="text-xs text-[var(--text-muted)]">暂无数据</p>
        )}
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
        <h3 className="mb-3 text-sm font-medium text-[var(--text)]">按模型明细</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
                <th className="pb-2 font-medium">模型</th>
                <th className="pb-2 font-medium text-right">调用次数</th>
                <th className="pb-2 font-medium text-right">输入 Token</th>
                <th className="pb-2 font-medium text-right">输出 Token</th>
                <th className="pb-2 font-medium text-right">平均延迟</th>
              </tr>
            </thead>
            <tbody>
              {(data?.perModel ?? []).map((m, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  <td className="py-2 text-[var(--text)]">{m.model}</td>
                  <td className="py-2 text-right text-[var(--text-muted)]">{m.calls.toLocaleString()}</td>
                  <td className="py-2 text-right text-[var(--text-muted)]">{m.promptTokens.toLocaleString()}</td>
                  <td className="py-2 text-right text-[var(--text-muted)]">{m.completionTokens.toLocaleString()}</td>
                  <td className="py-2 text-right text-[var(--text-muted)]">{m.avgLatency}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
        <h3 className="mb-3 text-sm font-medium text-[var(--text)]">最近调用记录</h3>
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
                <th className="pb-2 font-medium">时间</th>
                <th className="pb-2 font-medium">模型</th>
                <th className="pb-2 font-medium text-right">输入</th>
                <th className="pb-2 font-medium text-right">输出</th>
                <th className="pb-2 font-medium text-right">延迟</th>
                <th className="pb-2 font-medium text-center">状态</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recentCalls ?? []).map((c, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  <td className="py-1.5 text-[var(--text-muted)]">{new Date(c.timestamp).toLocaleTimeString('zh-CN')}</td>
                  <td className="py-1.5 text-[var(--text)]">{c.model.length > 20 ? c.model.slice(0, 17) + '...' : c.model}</td>
                  <td className="py-1.5 text-right text-[var(--text-muted)]">{c.promptTokens.toLocaleString()}</td>
                  <td className="py-1.5 text-right text-[var(--text-muted)]">{c.completionTokens.toLocaleString()}</td>
                  <td className="py-1.5 text-right text-[var(--text-muted)]">{c.latencyMs}ms</td>
                  <td className="py-1.5 text-center">
                    <span className={c.success ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
                      {c.success ? '✓' : '✗'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─── 代理 ────────────────────────────────────────────────────────────────

interface Proxy {
  host: string
  port: string
  protocol: string
  country: string
  active: boolean
}

export function ProxiesSection() {
  const [proxies, setProxies] = useState<Proxy[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    endpoints.proxies
      .list()
      .then((d) => {
        if (Array.isArray(d)) {
          setProxies(d as Proxy[])
        } else if (d && typeof d === 'object' && Array.isArray((d as { proxies?: unknown }).proxies)) {
          setProxies((d as { proxies: Proxy[] }).proxies)
        } else {
          setProxies([])
        }
      })
      .catch((e) => setError(String((e as Error)?.message ?? e)))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Globe className="size-5" />}
        title="代理管理"
        description="系统代理状态 · 隐私保护配置。"
      />

      {error && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          <AlertTriangle className="size-4" />
          {error}
        </p>
      )}

      <section className="stagger grid grid-cols-1 gap-4 sm:grid-cols-3" aria-busy={loading}>
        <StatCard label="代理总数" value={proxies.length} icon={<Server className="size-4" />} accent="default" loading={loading} />
        <StatCard label="活跃代理" value={proxies.filter((p) => p.active).length} icon={<CheckCircle2 className="size-4" />} accent="success" loading={loading} />
        <StatCard label="非活跃" value={proxies.filter((p) => !p.active).length} icon={<XCircle className="size-4" />} accent="warning" loading={loading} />
      </section>

      <ShimmerCard>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--text)]">
          <Shield className="size-4 text-[var(--accent)]" />
          代理配置
        </h2>
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height="3rem" />
            ))}
          </div>
        ) : proxies.length === 0 ? (
          <InlineEmptyState
            icon={<Globe className="size-5" />}
            title="未配置代理"
            description={
              <>
                可通过 <code className="rounded bg-[var(--bg-tertiary)] px-1 font-mono">HTTP_PROXY</code> 和{' '}
                <code className="rounded bg-[var(--bg-tertiary)] px-1 font-mono">HTTPS_PROXY</code> 环境变量配置
              </>
            }
          />
        ) : (
          <div className="space-y-2">
            {proxies.map((p, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-xl border border-[var(--border)] p-3 transition-colors hover:bg-[var(--surface-hover)]"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`flex size-9 items-center justify-center rounded-lg ${
                      p.active ? 'bg-[var(--success-soft)]' : 'bg-[var(--bg-tertiary)]'
                    }`}
                  >
                    <Globe
                      className={`size-4 ${p.active ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'}`}
                    />
                  </div>
                  <div>
                    <p className="font-mono text-sm font-medium text-[var(--text)]">
                      {p.host}
                      {p.port && <span className="text-[var(--text-muted)]">:{p.port}</span>}
                    </p>
                    <p className="text-2xs text-[var(--text-muted)]">
                      {p.protocol} · {p.country}
                    </p>
                  </div>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    p.active
                      ? 'bg-[var(--success-soft)] text-[var(--success)]'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                  }`}
                >
                  {p.active ? '活跃' : '禁用'}
                </span>
              </div>
            ))}
          </div>
        )}
      </ShimmerCard>

      <p className="text-2xs text-[var(--text-muted)]">
        代理仅用于出站爬取请求，不会影响本地 API 访问。
      </p>
    </div>
  )
}

// ─── 性能 ────────────────────────────────────────────────────────────────

export function PerfSection() {
  const [m, setM] = useState<PerfMetrics | null>(null)
  const [native, setNative] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.allSettled([
      endpoints.perf.metrics().then(normalizeMetrics),
      endpoints.perf.native().then(normalizeNative).catch(() => null),
    ]).then(([metrics, nat]) => {
      if (metrics.status === 'fulfilled') {
        setM(metrics.value)
      } else {
        setError(String(metrics.reason?.message ?? metrics.reason))
      }
      setNative(nat.status === 'fulfilled' ? nat.value : null)
      setLoading(false)
    })
  }, [])

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Activity className="size-5" />}
        title="性能"
        description="运行时指标与原生模块统计。"
      />

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--warning-soft)] bg-[var(--warning-soft)] px-3 py-2 text-sm text-[var(--warning)]"
        >
          部分指标暂不可用：{error}
        </p>
      )}

      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4" aria-busy={loading}>
        <ShimmerCard glow>
          <p className="text-sm text-[var(--text-muted)]">CPU</p>
          {loading ? (
            <Skeleton className="mt-2 h-8 w-16" />
          ) : (
            <p className="mt-1 text-3xl font-bold text-[var(--text)]">
              {m?.cpu !== undefined ? `${m.cpu.toFixed(1)}%` : '—'}
            </p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-[var(--text-muted)]">内存</p>
          {loading ? (
            <Skeleton className="mt-2 h-8 w-16" />
          ) : (
            <p className="mt-1 text-3xl font-bold text-[var(--text)]">
              {m?.memory !== undefined ? `${m.memory.toFixed(1)}%` : '—'}
            </p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-[var(--text-muted)]">RPS</p>
          {loading ? (
            <Skeleton className="mt-2 h-8 w-12" />
          ) : (
            <p className="mt-1 text-3xl font-bold text-[var(--text)]">{m?.rps ?? '—'}</p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-[var(--text-muted)]">P95</p>
          {loading ? (
            <Skeleton className="mt-2 h-8 w-14" />
          ) : (
            <p className="mt-1 text-3xl font-bold text-[var(--text)]">
              {m?.p95 !== undefined ? `${m.p95}ms` : '—'}
            </p>
          )}
        </ShimmerCard>
      </div>

      <ShimmerCard>
        <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--text)]">
          <Cpu className="size-4 text-[var(--accent)]" />
          原生模块
        </h2>
        {native ? (
          <pre className="mt-3 max-h-72 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--text-secondary)]">
            {JSON.stringify(native, null, 2)}
          </pre>
        ) : (
          <div className="mt-3 space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-3 w-full" />
            ))}
            <p className="mt-2 text-xs text-[var(--text-muted)]">原生模块未启用或暂无数据。</p>
          </div>
        )}
      </ShimmerCard>
    </div>
  )
}
