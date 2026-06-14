import { useEffect, useState } from 'react'
import { Search as SearchIcon, Code, FileText } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
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
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">搜索</h1>
        <p className="text-text-secondary">统一搜索 Vault 笔记与代码库。</p>
      </header>

      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
        <input
          autoFocus
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="输入关键词，按 / 聚焦…"
          className="h-11 w-full rounded-xl border border-border bg-surface pl-9 pr-4 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {loading && <p className="text-sm text-text-muted">搜索中…</p>}

      {!loading && q && results.length === 0 && (
        <ShimmerCard>
          <p className="text-sm text-text-secondary">没有匹配结果。</p>
        </ShimmerCard>
      )}

      <div className="space-y-3">
        {results.map((r, i) => {
          const Icon = r.type === 'code' ? Code : FileText
          return (
            <ShimmerCard key={i}>
              <div className="flex items-start gap-3">
                <Icon className="mt-0.5 size-4 text-accent" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{r.title}</p>
                  {r.snippet && (
                    <p className="mt-1 line-clamp-2 text-sm text-text-secondary">{r.snippet}</p>
                  )}
                  {r.path && (
                    <p className="mt-1 truncate text-xs text-text-muted">{r.path}</p>
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
