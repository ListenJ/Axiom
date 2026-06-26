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

  const loading = stats === null

  return (
    <div className="fade-in stagger space-y-4">
      <header className="fade-in stagger space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Network className="size-6 text-accent" />
          鐭ヨ瘑鍥捐氨
        </h1>
        <p className="text-text-secondary">PrimeKG 瀹炰綋銆佸叧绯讳笌绀惧尯缁熻銆?/p>
      </header>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-busy={loading}>
        <ShimmerCard glow>
          <p className="text-sm text-text-muted">瀹炰綋</p>
          {loading ? (
            <div className="mt-2 h-8 w-16 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-3xl font-bold">{stats?.entities ?? '鈥?}</p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">鍏崇郴</p>
          {loading ? (
            <div className="mt-2 h-8 w-16 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-3xl font-bold">{stats?.relations ?? '鈥?}</p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">绀惧尯</p>
          {loading ? (
            <div className="mt-2 h-8 w-12 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-3xl font-bold">{stats?.communities ?? '鈥?}</p>
          )}
        </ShimmerCard>
      </div>
    </div>
  )
}
