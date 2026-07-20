import { useEffect, useState } from 'react'
import { Network, AlertTriangle, Layers, Share2, GitBranch } from 'lucide-react'
import { StatCard, PageHeader, ShimmerCard } from '@/components/ui'
import { endpoints } from '@/lib/api'

interface KgStats {
  entities?: number
  relations?: number
  communities?: number
}

export default function KG() {
  const [stats, setStats] = useState<KgStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loading = stats === null

  useEffect(() => {
    endpoints.kg.stats().then((d) => setStats(d as KgStats)).catch((e) => setError(String((e as Error)?.message ?? e)))
  }, [])

  return (
    <div className="mx-auto max-w-2xl space-y-5 fade-in">
      <PageHeader icon={<Network className="size-5" />} title="知识图谱" description="SQLite 本地知识图谱。" />

      {error && (
        <p role="alert" className="flex items-center gap-2 rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          <AlertTriangle className="size-4" />
          {error}
        </p>
      )}

      <section className="stagger grid grid-cols-3 gap-3" aria-busy={loading}>
        <StatCard label="实体" value={stats?.entities ?? '—'} icon={<Layers className="size-4" />} accent="default" loading={loading} />
        <StatCard label="关系" value={stats?.relations ?? '—'} icon={<Share2 className="size-4" />} accent="info" loading={loading} />
        <StatCard label="社区" value={stats?.communities ?? '—'} icon={<GitBranch className="size-4" />} accent="success" loading={loading} />
      </section>

      <ShimmerCard variant="muted">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <Network className="size-4 text-[var(--accent)]" />
          关于知识图谱
        </h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          知识图谱使用 SQLite 本地存储。实体、关系和社区数据通过图谱分析管道构建。
        </p>
      </ShimmerCard>
    </div>
  )
}
