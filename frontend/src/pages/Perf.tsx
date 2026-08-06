import { useEffect, useState } from 'react'
import { Activity, Cpu } from 'lucide-react'
import { ShimmerCard, PageHeader, Skeleton } from '@/components/ui'
import { endpoints } from '@/lib/api'
import { normalizeMetrics, normalizeNative, type PerfMetrics } from '@/lib/normalize'

/** 性能面板（设置页「调试与检查」嵌入用，不含页头） */
export function PerfPanel() {
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
    <div className="space-y-4">
      {error && (
        <p
          role="alert"
          title={error}
          className="rounded-lg border border-[var(--warning-soft)] bg-[var(--warning-soft)] px-3 py-2 text-sm text-[var(--warning)]"
        >
          部分指标暂不可用，请稍后重试。
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

export default function Perf() {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Activity className="size-5" />}
        title="性能"
        description="运行时指标与原生模块统计。"
      />
      <PerfPanel />
    </div>
  )
}
