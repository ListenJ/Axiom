import { useEffect, useState } from 'react'
import { Folder, Tag, Network as NetworkIcon, BookOpen } from 'lucide-react'
import { ShimmerCard, StatCard, PageHeader, InlineEmptyState, Skeleton } from '@/components/ui'
import { endpoints } from '@/lib/api'

interface VaultStats {
  notes?: number
  tags?: number
  links?: number
}

export default function Vault() {
  const [stats, setStats] = useState<VaultStats | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const loading = stats === null

  useEffect(() => {
    Promise.allSettled([
      endpoints.vault.stats().then((d) => d as VaultStats).catch(() => null),
      endpoints.vault.tags().then((d) => toTags(d)).catch(() => []),
    ]).then(([s, t]) => {
      setStats(s.status === 'fulfilled' ? s.value : null)
      setTags(t.status === 'fulfilled' ? t.value : [])
      const failed = [s, t].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
      if (failed) setError(String(failed.reason?.message ?? failed.reason))
    })
  }, [])

  return (
    <div className="mx-auto max-w-2xl space-y-5 fade-in">
      <PageHeader
        icon={<Folder className="size-5" />}
        title="知识库"
        description="笔记库概览。"
      />

      {error && <p role="alert" className="rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">{error}</p>}

      {/* Stats */}
      <section className="stagger grid grid-cols-3 gap-3" aria-busy={loading}>
        <StatCard label="笔记" value={stats?.notes ?? '—'} icon={<BookOpen className="size-4" />} accent="default" loading={loading} />
        <StatCard label="标签" value={stats?.tags ?? '—'} icon={<Tag className="size-4" />} accent="info" loading={loading} />
        <StatCard label="链接" value={stats?.links ?? '—'} icon={<NetworkIcon className="size-4" />} accent="success" loading={loading} />
      </section>

      {/* Tags */}
      <ShimmerCard className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <Tag className="size-4 text-[var(--accent)]" />
          标签
        </h2>
        {tags.length === 0 ? (
          <InlineEmptyState icon={<Tag className="size-5" />} title="暂无标签" />
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((t, i) => (
              <span key={i} className="rounded-full border border-[var(--border)] bg-[var(--bg-tertiary)] px-3 py-1 text-xs text-[var(--text-secondary)]">
                #{t}
              </span>
            ))}
          </div>
        )}
      </ShimmerCard>

      {/* PARA 视图 */}
      <ShimmerCard variant="muted">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <NetworkIcon className="size-4 text-[var(--accent)]" />
          PARA 视图
        </h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">在原生 Axiom 应用中查看 PARA 分类与反向链接。</p>
        <div className="mt-3 flex items-center gap-2 text-2xs text-[var(--text-muted)]">
          <Skeleton width="3rem" height="0.5rem" />
          <Skeleton width="6rem" height="0.5rem" />
          <Skeleton width="4rem" height="0.5rem" />
        </div>
      </ShimmerCard>
    </div>
  )
}

function toTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (raw && typeof raw === 'object' && Array.isArray((raw as { tags?: unknown }).tags)) {
    return ((raw as { tags: unknown[] }).tags).map(String)
  }
  return []
}
