import { useEffect, useState } from 'react'
import { Network, AlertTriangle } from 'lucide-react'
import { StatCard, PageHeader } from '@/components/ui'
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
    <div className="space-y-6 fade-in">
      <PageHeader
        icon={<Network className="size-5" />}
        title="知识图谱"
        description="PrimeKG 实体、关系与社区统计。"
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

      <section
        className="stagger grid grid-cols-1 gap-4 sm:grid-cols-3"
        aria-busy={loading}
      >
        <StatCard
          label="实体"
          value={stats?.entities ?? '—'}
          icon={<Network className="size-4" />}
          accent="default"
          loading={loading}
        />
        <StatCard
          label="关系"
          value={stats?.relations ?? '—'}
          icon={<Network className="size-4" />}
          accent="info"
          loading={loading}
        />
        <StatCard
          label="社区"
          value={stats?.communities ?? '—'}
          icon={<Network className="size-4" />}
          accent="success"
          loading={loading}
        />
      </section>
    </div>
  )
}
