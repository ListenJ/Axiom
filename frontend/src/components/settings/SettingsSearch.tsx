import { useEffect, useRef, useState } from 'react'
import { Search, Sparkles, CornerDownLeft, AlertCircle } from 'lucide-react'
import { Input, LoadingDots } from '@/components/ui'
import { endpoints } from '@/lib/api'
import { clientKeywordSearch, getSectionMeta } from './settings-data'

interface SettingsSearchProps {
  /** 点击结果：key → 展开分区并高亮对应设置项 */
  onSelect: (key: string, section: string) => void
}

interface SearchHit {
  key: string
  label: string
  desc: string
  section: string
  score: number
  matchType: 'semantic' | 'keyword'
}

const DEBOUNCE_MS = 250

/**
 * 设置搜索框：优先后端语义搜索（本地模型 embedding），失败时客户端关键词兜底。
 * 命中结果展示 label + 精确 desc + 分区徽标；点击后跳转展开对应分区。
 */
export default function SettingsSearch({ onSelect }: SettingsSearchProps) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [engine, setEngine] = useState<'semantic' | 'hybrid' | 'keyword' | 'offline' | null>(null)
  const [error, setError] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    const query = q.trim()
    if (!query) {
      setResults([])
      setEngine(null)
      setError(false)
      setLoading(false)
      return
    }
    setLoading(true)
    timer.current = setTimeout(async () => {
      try {
        const res = await endpoints.settings.search(query)
        if (res.results.length > 0) {
          setResults(res.results)
          setEngine(res.engine)
          setError(false)
        } else {
          // 后端无命中 → 客户端兜底
          const fallback = clientKeywordSearch(query)
          setResults(
            fallback.map((it) => ({
              key: it.key,
              label: it.label,
              desc: it.desc,
              section: getSectionMeta(it.section).label,
              score: 1,
              matchType: 'keyword' as const,
            })),
          )
          setEngine('offline')
          setError(false)
        }
      } catch {
        const fallback = clientKeywordSearch(query)
        setResults(
          fallback.map((it) => ({
            key: it.key,
            label: it.label,
            desc: it.desc,
            section: getSectionMeta(it.section).label,
            score: 1,
            matchType: 'keyword' as const,
          })),
        )
        setEngine('offline')
        setError(true)
      } finally {
        setLoading(false)
      }
    }, DEBOUNCE_MS)
  }, [q])

  const pick = (hit: SearchHit) => {
    onSelect(hit.key, hit.section)
    setQ('')
    setResults([])
    setEngine(null)
  }

  const engineLabel =
    engine === 'semantic' ? '语义匹配（本地模型）'
      : engine === 'hybrid' ? '语义 + 关键词匹配'
        : engine === 'offline' ? '关键词匹配（离线兜底）'
          : null

  return (
    <div ref={boxRef} className="relative">
      <Input
        aria-label="搜索设置项"
        placeholder="搜索设置项，如：缓存、权限、动画…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        iconLeft={<Search className="size-4" />}
        autoComplete="off"
      />
      {loading && (
        <span className="absolute right-3 top-3 text-[var(--text-muted)]">
          <LoadingDots size="sm" />
        </span>
      )}
      {engineLabel && !loading && (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-[var(--text-muted)]" aria-live="polite">
          {engine === 'offline' ? <AlertCircle className="size-3.5" /> : <Sparkles className="size-3.5" />}
          {engineLabel}
          {error && '（后端暂不可用）'}
        </p>
      )}
      {results.length > 0 && (
        <ul
          className="absolute z-30 mt-2 w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] shadow-lg"
          role="listbox"
          aria-label="设置搜索结果"
        >
          {results.map((hit, idx) => (
            <li key={hit.key} role="option" aria-selected="false">
              <button
                type="button"
                onClick={() => pick(hit)}
                className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--text)]">{hit.label}</span>
                    <span className="rounded-full bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-2xs text-[var(--text-muted)]">
                      {hit.section}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-[var(--text-secondary)]">
                    {hit.desc}
                  </span>
                </span>
                <CornerDownLeft className="mt-1 size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                {idx === 0 && (
                  <span className="sr-only">按 Enter 选择</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!loading && q.trim() !== '' && results.length === 0 && (
        <p className="mt-1.5 text-xs text-[var(--text-muted)]" role="status">
          未找到相关设置项，试试「缓存 / 权限 / 主题 / 并发」。
        </p>
      )}
    </div>
  )
}