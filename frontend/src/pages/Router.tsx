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

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Compass className="size-6 text-accent" />
          模型路由
        </h1>
        <p className="text-text-secondary">Advisor + Health + Token 使用统计。</p>
      </header>

      {error && <p className="text-sm text-warning">部分指标暂不可用：{error}</p>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <ShimmerCard glow>
          <div className="flex items-center gap-2 text-text-muted">
            <Heart className="size-4" />
            <span className="text-sm">健康模型</span>
          </div>
          <p className="mt-2 text-3xl font-bold">{status?.healthy ?? '—'}</p>
          <p className="mt-1 text-xs text-text-muted">共 {status?.models ?? '—'} 个模型</p>
        </ShimmerCard>

        <ShimmerCard>
          <div className="flex items-center gap-2 text-text-muted">
            <Coins className="size-4" />
            <span className="text-sm">Token 使用</span>
          </div>
          <p className="mt-2 text-3xl font-bold">
            {status?.tokens ? status.tokens.used.toLocaleString() : '—'}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            / {status?.tokens ? status.tokens.total.toLocaleString() : '—'}
          </p>
        </ShimmerCard>

        <ShimmerCard>
          <div className="flex items-center gap-2 text-text-muted">
            <Compass className="size-4" />
            <span className="text-sm">路由状态</span>
          </div>
          <p className="mt-2 text-3xl font-bold capitalize text-success">{status?.status ?? '—'}</p>
        </ShimmerCard>
      </div>
    </div>
  )
}
