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

  const loading = m === null

  return (
    <div className="fade-in stagger space-y-4">
      <header className="fade-in stagger space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Activity className="size-6 text-accent" />
          鎬ц兘
        </h1>
        <p className="text-text-secondary">杩愯鏃舵寚鏍囦笌鍘熺敓妯″潡缁熻銆?/p>
      </header>

      {error && (
        <p role="alert" className="text-sm text-warning">
          閮ㄥ垎鎸囨爣鏆備笉鍙敤锛歿error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-busy={loading}>
        <ShimmerCard glow>
          <p className="text-sm text-text-muted">CPU</p>
          {loading ? (
            <div className="mt-2 h-8 w-16 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-3xl font-bold">{m?.cpu !== undefined ? `${m.cpu.toFixed(1)}%` : '鈥?}</p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">鍐呭瓨</p>
          {loading ? (
            <div className="mt-2 h-8 w-16 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-3xl font-bold">{m?.memory !== undefined ? `${m.memory.toFixed(1)}%` : '鈥?}</p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">RPS</p>
          {loading ? (
            <div className="mt-2 h-8 w-12 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-3xl font-bold">{m?.rps ?? '鈥?}</p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">P95</p>
          {loading ? (
            <div className="mt-2 h-8 w-14 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-3xl font-bold">{m?.p95 !== undefined ? `${m.p95}ms` : '鈥?}</p>
          )}
        </ShimmerCard>
      </div>

      <ShimmerCard>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Cpu className="size-4 text-accent" />
          鍘熺敓妯″潡
        </h2>
        {native ? (
          <pre className="mt-3 max-h-72 overflow-y-auto rounded-xl border border-border bg-bg p-3 text-xs text-text-secondary">
            {JSON.stringify(native, null, 2)}
          </pre>
        ) : (
          <div className="mt-3 space-y-2" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-3 w-full animate-pulse rounded bg-bg-tertiary" />
            ))}
            <p className="mt-2 text-xs text-text-muted">鍘熺敓妯″潡鏈惎鐢ㄦ垨鏆傛棤鏁版嵁銆?/p>
          </div>
        )}
      </ShimmerCard>
    </div>
  )
}
