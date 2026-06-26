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
    <div className="fade-in space-y-4">
      <header className="fade-in space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">鎼滅储</h1>
        <p className="text-text-secondary">缁熶竴鎼滅储 Vault 绗旇涓庝唬鐮佸簱銆?/p>
      </header>

      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
        <input
          autoFocus
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="杈撳叆鍏抽敭璇嶏紝鎸?/ 鑱氱劍鈥?
          aria-label="鎼滅储鍏抽敭璇?
          className="h-11 w-full rounded-xl border border-border bg-surface pl-9 pr-4 text-sm text-text placeholder:text-text-muted transition-colors focus:border-accent focus:outline-none"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {loading && (
        <div className="fade-in space-y-3" aria-busy="true" aria-label="姝ｅ湪鎼滅储">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-start gap-3 rounded-2xl border border-border bg-surface p-4"
              aria-hidden="true"
            >
              <div className="mt-0.5 size-4 shrink-0 animate-pulse rounded bg-bg-tertiary" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-4 w-1/2 animate-pulse rounded bg-bg-tertiary" />
                <div className="h-3 w-full animate-pulse rounded bg-bg-tertiary" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-bg-tertiary" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && q && results.length === 0 && (
        <ShimmerCard>
          <p className="text-sm text-text-secondary">娌℃湁鍖归厤缁撴灉銆?/p>
        </ShimmerCard>
      )}

      <div className="fade-in space-y-3">
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
