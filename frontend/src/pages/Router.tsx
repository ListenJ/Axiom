import { useEffect, useState } from 'react'
import { Compass, Heart, Coins } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
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
    <div className="fade-in space-y-4">
      <header className="fade-in space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Compass className="size-6 text-accent" />
          妯″瀷璺敱
        </h1>
        <p className="text-text-secondary">Advisor + Health + Token 浣跨敤缁熻銆?/p>
      </header>

      {error && (
        <p role="alert" className="text-sm text-warning">
          閮ㄥ垎鎸囨爣鏆備笉鍙敤锛歿error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-busy={loading}>
        <ShimmerCard glow>
          <div className="flex items-center gap-2 text-text-muted">
            <Heart className="size-4" />
            <span className="text-sm">鍋ュ悍妯″瀷</span>
          </div>
          {loading ? (
            <>
              <div className="mt-3 h-8 w-16 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
              <div className="mt-2 h-3 w-24 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
            </>
          ) : (
            <>
              <p className="mt-2 text-3xl font-bold">{status?.healthy ?? '鈥?}</p>
              <p className="mt-1 text-xs text-text-muted">鍏?{status?.models ?? '鈥?} 涓ā鍨?/p>
            </>
          )}
        </ShimmerCard>

        <ShimmerCard>
          <div className="flex items-center gap-2 text-text-muted">
            <Coins className="size-4" />
            <span className="text-sm">Token 浣跨敤</span>
          </div>
          {loading ? (
            <>
              <div className="mt-3 h-8 w-24 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
              <div className="mt-2 h-3 w-20 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
            </>
          ) : (
            <>
              <p className="mt-2 text-3xl font-bold">
                {status?.tokens ? status.tokens.used.toLocaleString() : '鈥?}
              </p>
              <p className="mt-1 text-xs text-text-muted">
                / {status?.tokens ? status.tokens.total.toLocaleString() : '鈥?}
              </p>
            </>
          )}
        </ShimmerCard>

        <ShimmerCard>
          <div className="flex items-center gap-2 text-text-muted">
            <Compass className="size-4" />
            <span className="text-sm">璺敱鐘舵€?/span>
          </div>
          {loading ? (
            <div className="mt-3 h-8 w-20 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-2 text-3xl font-bold capitalize text-success">{status?.status ?? '鈥?}</p>
          )}
        </ShimmerCard>
      </div>
    </div>
  )
}
