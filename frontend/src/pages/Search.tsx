import { useEffect, useState } from 'react'
import { Search as SearchIcon, Code, FileText, SlidersHorizontal, X } from 'lucide-react'
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

type SearchSource = 'all' | 'vault' | 'code'
type ViewMode = 'list' | 'compact'

export default function Search() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<SearchSource>('all')
  const [view, setView] = useState<ViewMode>('list')
  const [showFilters, setShowFilters] = useState(false)

  useEffect(() => {
    if (!q.trim()) { setResults([]); return }
    let cancelled = false
    setLoading(true)
    setError(null)
    const timer = setTimeout(() => {
      const queries: Promise<SearchResult[]>[] = []
      if (source === 'all' || source === 'vault') queries.push(endpoints.search.vault(q).then(toList).catch(() => []))
      if (source === 'all' || source === 'code') queries.push(endpoints.search.code(q).then(toList).catch(() => []))
      Promise.allSettled(queries)
        .then((settled) => {
          if (cancelled) return
          setResults(settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])))
        })
        .catch((e) => !cancelled && setError(String(e?.message ?? e)))
        .finally(() => !cancelled && setLoading(false))
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [q, source])

  return (
    <div className="space-y-5 fade-in">
      <PageHeader
        icon={<SearchIcon className="size-5" />}
        title="搜索"
        description="搜索笔记与代码。"
      />

      <div className="flex items-start gap-2">
        <div className="flex-1">
          <Input
            autoFocus
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索关键词…"
            aria-label="搜索关键词"
            iconLeft={<SearchIcon className="size-4 text-[var(--text-muted)]" />}
          />
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`flex h-10 w-10 items-center justify-center rounded-xl border transition-colors ${
            showFilters
              ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
              : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-hover)]'
          }`}
          aria-label="搜索设置"
          aria-expanded={showFilters}
        >
          {showFilters ? <X className="size-4" /> : <SlidersHorizontal className="size-4" />}
        </button>
      </div>

      {showFilters && (
        <div className="animate-fadeIn rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--text-secondary)]">搜索范围</p>
            <div className="flex gap-2">
              {(['all', 'vault', 'code'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSource(s)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    source === s
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-[var(--surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text)]'
                  }`}
                >
                  {s === 'all' ? '全部' : s === 'vault' ? '笔记' : '代码'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--text-secondary)]">显示方式</p>
            <div className="flex gap-2">
              {(['list', 'compact'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    view === v
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-[var(--surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text)]'
                  }`}
                >
                  {v === 'list' ? '列表' : '紧凑'}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}

      {q && results.length > 0 && (
        <p className="text-xs text-[var(--text-muted)]">
          共 {results.length} 条结果
        </p>
      )}

      {loading && (
        <div className="space-y-3" aria-busy="true" aria-label="正在搜索">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
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
        <InlineEmptyState icon={<SearchIcon className="size-5" />} title="没有匹配结果" />
      )}

      <div className={view === 'compact' ? 'space-y-1' : 'space-y-3'}>
        {results.map((r, i) => {
          const Icon = r.type === 'code' ? Code : FileText
          return view === 'compact' ? (
            <div key={i} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-[var(--text)] hover:bg-[var(--surface-hover)] transition-colors">
              <Icon className="size-3.5 shrink-0 text-[var(--text-muted)]" />
              <span className="truncate">{r.title}</span>
              {r.path && <span className="ml-auto shrink-0 truncate text-xs text-[var(--text-muted)]">{r.path}</span>}
            </div>
          ) : (
            <ShimmerCard key={i}>
              <div className="flex items-start gap-3">
                <Icon className="mt-0.5 size-4 text-[var(--accent)]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-[var(--text)]">{r.title}</p>
                  {r.snippet && (
                    <p className="mt-1 line-clamp-2 text-sm text-[var(--text-secondary)]">{r.snippet}</p>
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
