import { useEffect, useState, useRef } from 'react'
import { Loader2, CheckCircle } from 'lucide-react'

interface PipelineEvent {
  type: 'step' | 'done' | 'error'
  stage: string
  progress: number
  message?: string
  tool?: string
  result?: string
}

const STAGE_LABELS: Record<string, string> = {
  classify: '分析意图',
  knowledge: '检索知识',
  reasoning: '推理思考',
  action: '执行操作',
  complete: '完成',
  error: '错误',
}

export default function PipelineIndicator({ active }: { active: boolean }) {
  const [events, setEvents] = useState<PipelineEvent[]>([])
  const [currentStage, setCurrentStage] = useState<string>('')
  const [currentProgress, setCurrentProgress] = useState(0)
  const [isDone, setIsDone] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!active) {
      setEvents([])
      setCurrentStage('')
      setCurrentProgress(0)
      setIsDone(false)
      return
    }

    const es = new EventSource('/pipeline/stream')
    eventSourceRef.current = es

    es.onmessage = (event) => {
      try {
        const data: PipelineEvent = JSON.parse(event.data)
        if (data.type === 'step') {
          setCurrentStage(data.stage)
          setCurrentProgress(data.progress || 0)
          setEvents(prev => [...prev.slice(-10), data])
        }
        if (data.type === 'done') {
          setIsDone(true)
          setCurrentProgress(1)
          setTimeout(() => {
            setEvents([])
            setCurrentStage('')
            setCurrentProgress(0)
            setIsDone(false)
          }, 3000)
        }
      } catch {}
    }

    // 不覆盖默认 onerror：EventSource 自带指数退避自动重连，
    // 主动 close() 会让一次瞬断变成永久失效
    return () => es.close()
  }, [active])

  if (!active && events.length === 0) return null

  const pct = Math.round(currentProgress * 100)

  return (
    <div className="mx-4 mb-3 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {isDone ? (
            <CheckCircle className="size-4 text-[var(--success)]" />
          ) : (
            <Loader2 className="size-4 animate-spin text-[var(--accent)]" />
          )}
          <span className="text-xs font-medium text-[var(--text)]">
            {isDone ? '完成' : (STAGE_LABELS[currentStage] || currentStage || '思考中...')}
          </span>
        </div>
        {!isDone && <span className="text-xs text-[var(--text-muted)]">{pct}%</span>}
      </div>
      <div className="h-1.5 w-full rounded-full bg-[var(--border)] overflow-hidden">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      {events.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {events.map((e, i) => (
            <span key={i} className="rounded bg-[var(--bg)] px-1.5 py-0.5 text-2xs text-[var(--text-muted)]">
              {STAGE_LABELS[e.stage] || e.stage}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
