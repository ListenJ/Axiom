import { useEffect, useState } from 'react'
import { Compass, Heart, Coins } from 'lucide-react'
import { ShimmerCard, PageHeader, Skeleton } from '@/components/ui'
import { endpoints } from '@/lib/api'

interface RouterStatus {
  status?: string
  models?: number
  healthy?: number
  tokens?: { used: number; total: number }
}

export default function Router() {
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
