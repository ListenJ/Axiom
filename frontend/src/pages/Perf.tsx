import { useEffect, useState } from 'react'
import { Activity, Cpu } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
import { endpoints } from '@/lib/api'

interface PerfMetrics {
  cpu?: number
  memory?: number
  rps?: number
  p50?: number
  p95?: number
}

export default function Perf() {
  const [m, setM] = useState<PerfMetrics | null>(null)
  const [native, setNative] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.allSettled([
      endpoints.perf.metrics().then((d) => d as PerfMetrics).catch(() => null),
      endpoints.perf.native().then((d) => d).catch(() => null),
    ]).then(([metrics, nat]) => {
      setM(metrics.status === 'fulfilled' ? metrics.value : null)
      setNative(nat.status === 'fulfilled' ? nat.value : null)
      const failed = [metrics, nat].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
      if (failed) setError(String(failed.reason?.message ?? failed.reason))
    })
  }, [])

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Activity className="size-6 text-accent" />
          性能
        </h1>
        <p className="text-text-secondary">运行时指标与原生模块统计。</p>
      </header>

      {error && <p className="text-sm text-warning">部分指标暂不可用：{error}</p>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <ShimmerCard glow>
          <p className="text-sm text-text-muted">CPU</p>
          <p className="mt-1 text-3xl font-bold">{m?.cpu !== undefined ? `${m.cpu.toFixed(1)}%` : '—'}</p>
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">内存</p>
          <p className="mt-1 text-3xl font-bold">{m?.memory !== undefined ? `${m.memory.toFixed(1)}%` : '—'}</p>
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">RPS</p>
          <p className="mt-1 text-3xl font-bold">{m?.rps ?? '—'}</p>
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">P95</p>
          <p className="mt-1 text-3xl font-bold">{m?.p95 !== undefined ? `${m.p95}ms` : '—'}</p>
        </ShimmerCard>
      </div>

      <ShimmerCard>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Cpu className="size-4 text-accent" />
          原生模块
        </h2>
        <pre className="mt-3 max-h-72 overflow-y-auto rounded-xl border border-border bg-bg p-3 text-xs text-text-secondary">
          {native ? JSON.stringify(native, null, 2) : '原生模块未启用或暂无数据。'}
        </pre>
      </ShimmerCard>
    </div>
  )
}
