import { useEffect, useState } from 'react'
import { Bot, Wand2, FileSearch, FlaskConical } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
import PageHeader from '@/components/ui/PageHeader'
import { endpoints, HttpError } from '@/lib/api'
import { useApp } from '@/state/useApp'

interface AgentStatus {
  name: string
  available: boolean
  last_used?: string
}

export default function Agents() {
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [code, setCode] = useState('function add(a, b) { return a + b }')
  const [review, setReview] = useState<string | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const toast = useApp((s) => s.toast)

  useEffect(() => {
    endpoints.agents
      .status()
      .then((d) => {
        if (Array.isArray(d)) {
          setAgents(d as AgentStatus[])
        } else if (d && typeof d === 'object' && Array.isArray((d as { agents?: unknown }).agents)) {
          setAgents((d as { agents: AgentStatus[] }).agents)
        } else {
          setAgents([])
        }
      })
      .catch((e) => setError(String((e as Error)?.message ?? e)))
  }, [])

  const run = async (action: 'review' | 'test' | 'refactor') => {
    setRunning(action)
    setError(null)
    setReview(null)
    try {
      const fn =
        action === 'review'
          ? endpoints.agents.review
          : action === 'test'
            ? endpoints.agents.test
            : (c: string, i: string) => endpoints.agents.refactor(c, i)
      const res = action === 'refactor'
        ? await endpoints.agents.refactor(code, '閲嶆瀯涓?TypeScript 骞舵坊鍔?JSDoc')
        : await fn(code, '')
      setReview(typeof res === 'string' ? res : JSON.stringify(res, null, 2))
      toast(`${action} 瀹屾垚`, 'success')
    } catch (e) {
      const msg = e instanceof HttpError ? e.message : String((e as Error)?.message ?? e)
      setError(msg)
      toast(msg, 'error')
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="fade-in stagger space-y-4">
      <PageHeader
        icon={<Bot className="size-5 text-accent" />}
        title="鏅鸿兘浣?
        description="绠＄悊 OpenCode 鏅鸿兘浣撳苟瑙﹀彂浠ｇ爜浠诲姟銆?
      />

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <section
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        aria-busy={agents.length === 0 && !error}
        aria-label="鏅鸿兘浣撳垪琛?
      >
        {agents.length === 0 ? (
          error ? (
            <ShimmerCard>
              <p className="text-sm text-danger">鍔犺浇澶辫触锛歿error}</p>
            </ShimmerCard>
          ) : (
            <>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="rounded-2xl border border-border bg-surface p-4"
                  aria-hidden="true"
                >
                  <div className="flex items-center justify-between">
                    <div className="h-4 w-24 animate-pulse rounded bg-bg-tertiary" />
                    <div className="h-3 w-10 animate-pulse rounded bg-bg-tertiary" />
                  </div>
                  <div className="mt-3 h-3 w-32 animate-pulse rounded bg-bg-tertiary" />
                </div>
              ))}
            </>
          )
        ) : (
          agents.map((a) => (
            <ShimmerCard key={a.name} glow={a.available}>
              <div className="flex items-center justify-between">
                <h3 className="font-medium">{a.name}</h3>
                <span className={a.available ? 'text-xs text-success' : 'text-xs text-text-muted'}>
                  {a.available ? '鍙敤' : '涓嶅彲鐢?}
                </span>
              </div>
              {a.last_used && (
                <p className="mt-1 text-xs text-text-muted">鏈€杩戯細{a.last_used}</p>
              )}
            </ShimmerCard>
          ))
        )}
      </section>

      <ShimmerCard>
        <h2 className="text-base font-semibold">浠ｇ爜浠诲姟</h2>
        <label htmlFor="agents-code-input" className="sr-only">
          浠ｇ爜杈撳叆
        </label>
        <textarea
          id="agents-code-input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          rows={6}
          aria-label="浠ｇ爜杈撳叆"
          placeholder="鍦ㄦ绮樿创鎴栬緭鍏ヤ唬鐮佲€?
          className="mt-3 w-full rounded-xl border border-border bg-bg p-3 font-mono text-xs text-text placeholder:text-text-muted transition-colors focus:border-accent focus:outline-none"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => run('review')}
            disabled={running !== null}
            aria-label="瀹℃煡浠ｇ爜"
            className="focus-ring flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FileSearch className="size-4" />
            瀹℃煡
          </button>
          <button
            type="button"
            onClick={() => run('test')}
            disabled={running !== null}
            aria-label="鐢熸垚娴嬭瘯"
            className="focus-ring flex h-10 items-center gap-2 rounded-xl border border-border bg-bg-tertiary px-4 text-sm font-medium text-text transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FlaskConical className="size-4" />
            鐢熸垚娴嬭瘯
          </button>
          <button
            type="button"
            onClick={() => run('refactor')}
            disabled={running !== null}
            aria-label="閲嶆瀯浠ｇ爜"
            className="focus-ring flex h-10 items-center gap-2 rounded-xl border border-border bg-bg-tertiary px-4 text-sm font-medium text-text transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Wand2 className="size-4" />
            閲嶆瀯
          </button>
        </div>
        {review && (
          <pre className="mt-3 max-h-80 overflow-y-auto rounded-xl border border-border bg-bg p-3 text-xs text-text-secondary">
            {review}
          </pre>
        )}
        {running && (
          <p className="mt-2 flex items-center gap-2 text-sm text-text-muted" aria-live="polite">
            <span className="inline-flex gap-1" aria-hidden="true">
              <span className="size-1.5 animate-pulse rounded-full bg-accent" />
              <span className="size-1.5 animate-pulse rounded-full bg-accent [animation-delay:120ms]" />
              <span className="size-1.5 animate-pulse rounded-full bg-accent [animation-delay:240ms]" />
            </span>
            姝ｅ湪鎵ц {running}鈥?
          </p>
        )}
      </ShimmerCard>
    </div>
  )
}
