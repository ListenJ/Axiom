import { useEffect, useState } from 'react'
import { Folder, Tag, Network as NetworkIcon } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
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

  const loading = stats === null

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Folder className="size-6 text-accent" />
          知识库
        </h1>
        <p className="text-text-secondary">Obsidian Vault 笔记与 PARA 视图。</p>
      </header>

      {error && (
        <p role="alert" className="text-sm text-warning">
          部分指标暂不可用：{error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-busy={loading}>
        <ShimmerCard glow>
          <p className="text-sm text-text-muted">笔记</p>
          {loading ? (
            <div className="mt-2 h-8 w-16 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-3xl font-bold">{stats?.notes ?? '—'}</p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">标签</p>
          {loading ? (
            <div className="mt-2 h-8 w-12 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-3xl font-bold">{stats?.tags ?? '—'}</p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">链接</p>
          {loading ? (
            <div className="mt-2 h-8 w-16 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-3xl font-bold">{stats?.links ?? '—'}</p>
          )}
        </ShimmerCard>
      </div>

      <ShimmerCard>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Tag className="size-4 text-accent" />
          标签
        </h2>
        {tags.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">暂无标签。</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {tags.map((t, i) => (
              <span
                key={i}
                className="rounded-full border border-border bg-bg-tertiary px-3 py-1 text-xs text-text-secondary"
              >
                #{t}
              </span>
            ))}
          </div>
        )}
      </ShimmerCard>

      <ShimmerCard>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <NetworkIcon className="size-4 text-accent" />
          PARA 视图
        </h2>
        <p className="mt-2 text-sm text-text-secondary">
          在原生 OpenClaw 应用中打开 Vault 浏览器以查看 PARA 分类与反向链接。
        </p>
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
