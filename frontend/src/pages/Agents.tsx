import { useEffect, useState } from 'react'
import { Bot, Wand2, FileSearch, FlaskConical, AlertTriangle } from 'lucide-react'
import {
  ShimmerCard,
  Button,
  PageHeader,
  Textarea,
  LoadingDots,
  Skeleton,
} from '@/components/ui'
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
        ? await endpoints.agents.refactor(code, '重构为 TypeScript 并添加 JSDoc')
        : await fn(code, '')
      setReview(typeof res === 'string' ? res : JSON.stringify(res, null, 2))
      toast(`${action} 完成`, 'success')
    } catch (e) {
      const msg = e instanceof HttpError ? e.message : String((e as Error)?.message ?? e)
      setError(msg)
      toast(msg, 'error')
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Bot className="size-5" />}
        title="智能体"
        description="管理 OpenCode 智能体并触发代码任务。"
      />

      {error && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          <AlertTriangle className="size-4" />
          {error}
        </p>
      )}

      <section
        className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        aria-busy={agents.length === 0 && !error}
        aria-label="智能体列表"
      >
        {agents.length === 0 ? (
          error ? null : (
            <>
              {[0, 1, 2].map((i) => (
                <ShimmerCard key={i}>
                  <Skeleton width="40%" height="1rem" />
                  <div className="mt-3">
                    <Skeleton width="60%" height="0.75rem" />
                  </div>
                </ShimmerCard>
              ))}
            </>
          )
        ) : (
          agents.map((a) => (
            <ShimmerCard key={a.name} variant={a.available ? 'accent' : 'default'}>
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-[var(--text)]">{a.name}</h3>
                <span
                  className={
                    a.available
                      ? 'rounded-full bg-[var(--success-soft)] px-2 py-0.5 text-xs text-[var(--success)]'
                      : 'text-xs text-[var(--text-muted)]'
                  }
                >
                  {a.available ? '可用' : '不可用'}
                </span>
              </div>
              {a.last_used && <p className="mt-1 text-xs text-[var(--text-muted)]">最近：{a.last_used}</p>}
            </ShimmerCard>
          ))
        )}
      </section>

      <ShimmerCard>
        <h2 className="mb-3 text-base font-semibold text-[var(--text)]">代码任务</h2>
        <Textarea
          label="代码"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          rows={6}
          placeholder="代码片段"
          className="font-mono text-xs"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            onClick={() => run('review')}
            loading={running === 'review'}
            disabled={running !== null}
            icon={<FileSearch className="size-4" />}
          >
            审查
          </Button>
          <Button
            onClick={() => run('test')}
            loading={running === 'test'}
            disabled={running !== null}
            variant="secondary"
            icon={<FlaskConical className="size-4" />}
          >
            生成测试
          </Button>
          <Button
            onClick={() => run('refactor')}
            loading={running === 'refactor'}
            disabled={running !== null}
            variant="secondary"
            icon={<Wand2 className="size-4" />}
          >
            重构
          </Button>
        </div>
        {review && (
          <pre className="mt-3 max-h-80 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--text-secondary)]">
            {review}
          </pre>
        )}
        {running && (
          <p className="mt-2 flex items-center gap-2 text-sm text-[var(--text-muted)]" aria-live="polite">
            <LoadingDots size="sm" />
            正在执行 {running}…
          </p>
        )}
      </ShimmerCard>
    </div>
  )
}
