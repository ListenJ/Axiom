import { useState, useEffect, useRef } from 'react'
import {
  Brain,
  Wrench,
  FileEdit,
  Terminal,
  XCircle,
  CheckCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Clock,
} from 'lucide-react'
import { endpoints } from '@/lib/api'

interface AgentStep {
  type: 'thinking' | 'tool-call' | 'file-change' | 'shell-command' | 'error' | 'result'
  timestamp: number
  content: string
  details?: Record<string, unknown>
}

interface AgentTrace {
  agentName: string
  taskId: string
  startTime: number
  steps: AgentStep[]
  status: 'running' | 'completed' | 'failed'
  result?: string
}

const STEP_ICONS: Record<string, typeof Brain> = {
  thinking: Brain,
  'tool-call': Wrench,
  'file-change': FileEdit,
  'shell-command': Terminal,
  error: XCircle,
  result: CheckCircle,
}

const STEP_LABELS: Record<string, string> = {
  thinking: '思考',
  'tool-call': '工具调用',
  'file-change': '文件变更',
  'shell-command': 'Shell 命令',
  error: '错误',
  result: '结果',
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function TracePanel({ active }: { active: boolean }) {
  const [traces, setTraces] = useState<AgentTrace[]>([])
  const [expanded, setExpanded] = useState(false)
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!active) {
      setTraces([])
      setExpanded(false)
      return
    }
    const fetchTraces = () => {
      endpoints.traces.list().then((data) => {
        const d = data as { traces: AgentTrace[] }
        if (d.traces?.length > 0) {
          setTraces(d.traces)
          setExpanded(true)
        }
      }).catch(() => {})
    }
    fetchTraces()
    intervalRef.current = setInterval(fetchTraces, 2000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [active])

  if (!active || traces.length === 0) return null

  const currentTrace = traces[traces.length - 1]
  const isRunning = currentTrace.status === 'running'

  const toggleStep = (idx: number) => {
    const key = `${currentTrace.taskId}-${idx}`
    setExpandedSteps((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="mx-4 mb-3 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/80 backdrop-blur-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 transition-colors hover:bg-[var(--surface-hover)]"
      >
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Loader2 className="size-4 animate-spin text-[var(--accent)]" />
          ) : currentTrace.status === 'failed' ? (
            <XCircle className="size-4 text-[var(--danger)]" />
          ) : (
            <CheckCircle className="size-4 text-[var(--success)]" />
          )}
          <span className="text-sm font-medium text-[var(--text)]">
            Agent 交互追踪
          </span>
          <span className="rounded bg-[var(--surface)] px-1.5 py-0.5 text-2xs text-[var(--text-muted)]">
            {currentTrace.steps.length} 步
          </span>
        </div>
        {expanded ? <ChevronDown className="size-4 text-[var(--text-muted)]" /> : <ChevronRight className="size-4 text-[var(--text-muted)]" />}
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] px-4 py-2">
          <div className="mb-2 flex items-center gap-2 text-2xs text-[var(--text-muted)]">
            <Clock className="size-3" />
            <span>{formatTime(currentTrace.startTime)}</span>
            <span className="mx-1">·</span>
            <span>{currentTrace.agentName}</span>
            <span className="mx-1">·</span>
            <span className={isRunning ? 'text-[var(--accent)]' : currentTrace.status === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--success)]'}>
              {isRunning ? '运行中' : currentTrace.status === 'failed' ? '失败' : '完成'}
            </span>
          </div>

          <div className="space-y-1">
            {currentTrace.steps.map((step, idx) => {
              const Icon = STEP_ICONS[step.type] || Brain
              const key = `${currentTrace.taskId}-${idx}`
              const isExpanded = expandedSteps.has(key)

              return (
                <div key={key} className="group">
                  <button
                    onClick={() => toggleStep(idx)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface)]"
                  >
                    <Icon className={`size-3.5 shrink-0 ${
                      step.type === 'error' ? 'text-[var(--danger)]' :
                      step.type === 'result' ? 'text-[var(--success)]' :
                      'text-[var(--text-muted)]'
                    }`} />
                    <span className="text-2xs text-[var(--text-muted)] shrink-0 w-12">{formatTime(step.timestamp)}</span>
                    <span className="text-xs font-medium text-[var(--text-secondary)] shrink-0 w-16">{STEP_LABELS[step.type]}</span>
                    <span className="truncate text-xs text-[var(--text-muted)]">{step.content}</span>
                    {(step.details || step.content.length > 60) && (
                      isExpanded ? <ChevronDown className="ml-auto size-3 shrink-0 text-[var(--text-muted)]" /> : <ChevronRight className="ml-auto size-3 shrink-0 text-[var(--text-muted)]" />
                    )}
                  </button>
                  {isExpanded && step.details && (
                    <div className="ml-8 mr-2 mt-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2">
                      <pre className="overflow-x-auto text-2xs text-[var(--text-muted)] whitespace-pre-wrap">
                        {JSON.stringify(step.details, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
