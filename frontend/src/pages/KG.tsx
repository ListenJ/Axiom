import { useEffect, useState } from 'react'
import { Network } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
import { endpoints } from '@/lib/api'

interface KgStats {
  entities?: number
  relations?: number
  communities?: number
}

export default function KG() {
  const [stats, setStats] = useState<KgStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    endpoints.kg
      .stats()
      .then((d) => setStats(d as KgStats))
      .catch((e) => setError(String((e as Error)?.message ?? e)))
  }, [])

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Network className="size-6 text-accent" />
          知识图谱
        </h1>
        <p className="text-text-secondary">PrimeKG 实体、关系与社区统计。</p>
      </header>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <ShimmerCard glow>
          <p className="text-sm text-text-muted">实体</p>
          <p className="mt-1 text-3xl font-bold">{stats?.entities ?? '—'}</p>
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">关系</p>
          <p className="mt-1 text-3xl font-bold">{stats?.relations ?? '—'}</p>
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">社区</p>
          <p className="mt-1 text-3xl font-bold">{stats?.communities ?? '—'}</p>
        </ShimmerCard>
      </div>
    </div>
  )
}
