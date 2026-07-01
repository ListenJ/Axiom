import { useEffect, useState } from 'react'
import { Search as SearchIcon, Code, FileText } from 'lucide-react'
import {
  ShimmerCard,
  PageHeader,
  Input,
  Skeleton,
  InlineEmptyState,
} from '@/components/ui'
import { endpoints } from '@/lib/api'

interface SearchResult {
  title: string
  type: 'code' | 'note'
  snippet?: string
  path?: string
}

export default function Search() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!q.trim()) {
      setResults([])
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    const timer = setTimeout(() => {
      Promise.allSettled([
        endpoints.search.vault(q).then((d) => toList(d)).catch(() => []),
        endpoints.search.code(q).then((d) => toList(d)).catch(() => []),
      ])
        .then(([vault, code]) => {
          if (cancelled) return
          const vaultResults = vault.status === 'fulfilled' ? vault.value : []
          const codeResults = code.status === 'fulfilled' ? code.value : []
          setResults([...vaultResults, ...codeResults])
        })
        .catch((e) => !cancelled && setError(String(e?.message ?? e)))
        .finally(() => !cancelled && setLoading(false))
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [q])

  return (
    <div className="space-y-6 fade-in">
      <PageHeader
        icon={<SearchIcon className="size-5" />}
        title="搜索"
        description="统一搜索 Vault 笔记与代码库。"
      />

      <Input
        autoFocus
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索…"
        aria-label="搜索关键词"
        iconLeft={<SearchIcon className="size-4 text-[var(--text-muted)]" />}
      />

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          {error}
        </p>
      )}

      {loading && (
        <div className="space-y-3" aria-busy="true" aria-label="正在搜索">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
            >
              <Skeleton className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && q && results.length === 0 && (
        <InlineEmptyState
          icon={<SearchIcon className="size-5" />}
          title="没有匹配结果"
        />
      )}

      <div className="space-y-3">
        {results.map((r, i) => {
          const Icon = r.type === 'code' ? Code : FileText
          return (
            <ShimmerCard key={i}>
              <div className="flex items-start gap-3">
                <Icon className="mt-0.5 size-4 text-[var(--accent)]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-[var(--text)]">{r.title}</p>
                  {r.snippet && (
                    <p className="mt-1 line-clamp-2 text-sm text-[var(--text-secondary)]">
                      {r.snippet}
                    </p>
                  )}
                  {r.path && (
                    <p className="mt-1 truncate text-xs text-[var(--text-muted)]">{r.path}</p>
                  )}
                </div>
              </div>
            </ShimmerCard>
          )
        })}
      </div>
    </div>
  )
}

function toList(raw: unknown): SearchResult[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>
        return {
          title: String(o.title ?? o.name ?? o.path ?? 'Untitled'),
          type: (o.type === 'code' ? 'code' : 'note') as 'code' | 'note',
          snippet: typeof o.snippet === 'string' ? o.snippet : undefined,
          path: typeof o.path === 'string' ? o.path : undefined,
        }
      }
      return { title: String(item), type: 'note' as const }
    })
  }
  return []
}
