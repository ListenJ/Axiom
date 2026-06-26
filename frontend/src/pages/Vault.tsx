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
    <div className="fade-in stagger space-y-4">
      <header className="fade-in stagger space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Folder className="size-6 text-accent" />
          鐭ヨ瘑搴?
        </h1>
        <p className="text-text-secondary">Obsidian Vault 绗旇涓?PARA 瑙嗗浘銆?/p>
      </header>

      {error && (
        <p role="alert" className="text-sm text-warning">
          閮ㄥ垎鎸囨爣鏆備笉鍙敤锛歿error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-busy={loading}>
        <ShimmerCard glow>
          <p className="text-sm text-text-muted">绗旇</p>
          {loading ? (
            <div className="mt-2 h-8 w-16 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-3xl font-bold">{stats?.notes ?? '鈥?}</p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">鏍囩</p>
          {loading ? (
            <div className="mt-2 h-8 w-12 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-3xl font-bold">{stats?.tags ?? '鈥?}</p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">閾炬帴</p>
          {loading ? (
            <div className="mt-2 h-8 w-16 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-3xl font-bold">{stats?.links ?? '鈥?}</p>
          )}
        </ShimmerCard>
      </div>

      <ShimmerCard>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Tag className="size-4 text-accent" />
          鏍囩
        </h2>
        {tags.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">鏆傛棤鏍囩銆?/p>
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
          PARA 瑙嗗浘
        </h2>
        <p className="mt-2 text-sm text-text-secondary">
          鍦ㄥ師鐢?OpenClaw 搴旂敤涓墦寮€ Vault 娴忚鍣ㄤ互鏌ョ湅 PARA 鍒嗙被涓庡弽鍚戦摼鎺ャ€?
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
