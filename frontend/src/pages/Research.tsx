import { useState } from 'react'
import { Microscope, Search, Loader2, ExternalLink, AlertCircle, Sparkles } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
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
      toast('璇疯緭鍏ョ爺绌堕棶棰?, 'warning')
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
      toast('鐮旂┒瀹屾垚', 'success')
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      setError(msg)
      toast('鐮旂┒澶辫触锛? + msg, 'error')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="fade-in space-y-4">
      <header className="fade-in space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Microscope className="size-6 text-accent" />
          娣卞害鐮旂┒
        </h1>
        <p className="text-text-secondary">鍩轰簬鐭ヨ瘑鍥捐氨鐨勫婧愭繁搴︾爺绌躲€?/p>
      </header>

      <ShimmerCard>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Sparkles className="size-4 text-accent" />
          鐮旂┒闂
        </h2>
        <div className="mt-3 space-y-3">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={3}
            placeholder="杈撳叆鐮旂┒闂锛屼緥濡傦細Rust vs Go 鍦ㄥ井鏈嶅姟涓殑鎬ц兘瀵规瘮"
            className="w-full rounded-lg border border-border bg-bg p-3 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-text-muted">鎼滅储娣卞害 (1-5)</label>
              <input
                type="number"
                min={1}
                max={5}
                value={depth}
                onChange={(e) => setDepth(Math.max(1, Math.min(5, Number(e.target.value) || 3)))}
                className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-text-muted">鏈€澶ф潵婧愭暟</label>
              <input
                type="number"
                min={1}
                max={50}
                value={maxSources}
                onChange={(e) => setMaxSources(Math.max(1, Math.min(50, Number(e.target.value) || 10)))}
                className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={handleRun}
            disabled={running || !query.trim()}
            className="focus-ring flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            {running ? '鐮旂┒涓€? : '寮€濮嬬爺绌?}
          </button>
        </div>
      </ShimmerCard>

      {error && (
        <p role="alert" className="flex items-center gap-2 text-sm text-danger">
          <AlertCircle className="size-4" />
          {error}
        </p>
      )}

      {result && (
        <>
          {result.summary && (
            <ShimmerCard>
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <Sparkles className="size-4 text-accent" />
                鐮旂┒鎽樿
              </h2>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-text">
                {result.summary}
              </p>
            </ShimmerCard>
          )}

          {result.entities && result.entities.length > 0 && (
            <ShimmerCard>
              <h2 className="text-base font-semibold">鐩稿叧瀹炰綋 ({result.entities.length})</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {result.entities.map((e, i) => (
                  <span
                    key={i}
                    className="rounded-full border border-border bg-bg-tertiary px-3 py-1 text-xs text-text-secondary"
                  >
                    {e.name} <span className="text-text-muted">路 {e.type}</span>
                  </span>
                ))}
              </div>
            </ShimmerCard>
          )}

          <ShimmerCard>
            <h2 className="text-base font-semibold">鍙傝€冩潵婧?({result.sources.length})</h2>
            {result.sources.length === 0 ? (
              <p className="mt-3 text-sm text-text-muted">鏈壘鍒版潵婧?/p>
            ) : (
              <div className="mt-3 space-y-2">
                {result.sources.map((s, i) => (
                  <a
                    key={i}
                    href={s.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-lg border border-border p-3 transition-colors hover:bg-bg-secondary"
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-1 text-sm font-medium text-text">{s.title}</p>
                        {s.snippet && (
                          <p className="mt-1 line-clamp-2 text-xs text-text-muted">{s.snippet}</p>
                        )}
                        <p className="mt-1 truncate text-2xs text-text-muted">
                          {s.source} 路 {s.link}
                        </p>
                      </div>
                      <ExternalLink className="size-3.5 shrink-0 text-text-muted" />
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
