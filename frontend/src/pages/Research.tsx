import { useState } from 'react'
import { Microscope, Search, ExternalLink, Sparkles, AlertCircle } from 'lucide-react'
import {
  ShimmerCard,
  Button,
  PageHeader,
  Input,
  Textarea,
  LoadingDots,
  InlineEmptyState,
} from '@/components/ui'
import { useApp } from '@/state/useApp'
import { endpoints } from '@/lib/api'

interface ResearchSource {
  title: string
  link: string
  snippet: string
  source: string
}

interface ResearchResult {
  query: string
  summary?: string
  sources: ResearchSource[]
  entities?: Array<{ name: string; type: string }>
  depth?: number
}

export default function Research() {
  const [query, setQuery] = useState('')
  const [depth, setDepth] = useState(3)
  const [maxSources, setMaxSources] = useState(10)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ResearchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const toast = useApp((s) => s.toast)

  const handleRun = async () => {
    const q = query.trim()
    if (!q) {
      toast('请输入研究问题', 'warning')
      return
    }
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await endpoints.research.run({ query: q, depth, maxSources })
      const r = res as Partial<ResearchResult>
      setResult({
        query: q,
        summary: r.summary,
        sources: Array.isArray(r.sources) ? r.sources : [],
        entities: Array.isArray(r.entities) ? r.entities : [],
        depth,
      })
      toast('研究完成', 'success')
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      setError(msg)
      toast('研究失败：' + msg, 'error')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-6 fade-in">
      <PageHeader
        icon={<Microscope className="size-5" />}
        title="深度研究"
        description="多源深度研究与摘要。"
      />

      <ShimmerCard>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--text)]">
          <Sparkles className="size-4 text-[var(--accent)]" />
          研究问题
        </h2>
        <div className="space-y-3">
          <Textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={3}
            placeholder="输入研究问题"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              type="number"
              label="搜索深度 (1-5)"
              min={1}
              max={5}
              value={depth}
              onChange={(e) => setDepth(Math.max(1, Math.min(5, Number(e.target.value) || 3)))}
            />
            <Input
              type="number"
              label="最大来源数"
              min={1}
              max={50}
              value={maxSources}
              onChange={(e) => setMaxSources(Math.max(1, Math.min(50, Number(e.target.value) || 10)))}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={handleRun}
              loading={running}
              disabled={!query.trim()}
              icon={<Search className="size-4" />}
            >
              {running ? '研究中…' : '开始研究'}
            </Button>
            {running && <LoadingDots size="sm" label="正在检索源" />}
          </div>
        </div>
      </ShimmerCard>

      {error && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          <AlertCircle className="size-4" />
          {error}
        </p>
      )}

      {result && (
        <>
          {result.summary && (
            <ShimmerCard>
              <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--text)]">
                <Sparkles className="size-4 text-[var(--accent)]" />
                研究摘要
              </h2>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--text)]">
                {result.summary}
              </p>
            </ShimmerCard>
          )}

          {result.entities && result.entities.length > 0 && (
            <ShimmerCard>
              <h2 className="mb-3 text-base font-semibold text-[var(--text)]">
                相关实体 ({result.entities.length})
              </h2>
              <div className="flex flex-wrap gap-2">
                {result.entities.map((e, i) => (
                  <span
                    key={i}
                    className="rounded-full border border-[var(--border)] bg-[var(--bg-tertiary)] px-3 py-1 text-xs text-[var(--text-secondary)]"
                  >
                    {e.name} <span className="text-[var(--text-muted)]">· {e.type}</span>
                  </span>
                ))}
              </div>
            </ShimmerCard>
          )}

          <ShimmerCard>
            <h2 className="mb-3 text-base font-semibold text-[var(--text)]">
              参考来源 ({result.sources.length})
            </h2>
            {result.sources.length === 0 ? (
              <InlineEmptyState
                icon={<Search className="size-5" />}
                title="未找到来源"
              />
            ) : (
              <div className="space-y-2">
                {result.sources.map((s, i) => (
                  <a
                    key={i}
                    href={s.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="press block rounded-lg border border-[var(--border)] p-3 transition-colors hover:bg-[var(--surface-hover)] hover:border-[var(--border-hover)]"
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-1 text-sm font-medium text-[var(--text)]">
                          {s.title}
                        </p>
                        {s.snippet && (
                          <p className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">
                            {s.snippet}
                          </p>
                        )}
                        <p className="mt-1 truncate font-mono text-2xs text-[var(--text-muted)]">
                          {s.source} · {s.link}
                        </p>
                      </div>
                      <ExternalLink className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                    </div>
                  </a>
                ))}
              </div>
            )}
          </ShimmerCard>
        </>
      )}
    </div>
  )
}
