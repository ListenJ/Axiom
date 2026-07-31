/**
 * Chat 页面子组件与辅助函数
 *
 * 从 pages/Chat.tsx 拆分出来，以满足"页面 < 600 行"的架构约束。
 * 包含：
 *  - Message 接口（聊天消息结构）
 *  - parseTokenContent（解析 SSE token 中嵌入的结构化事件）
 *  - ToggleChip（可复用的切换按钮）
 *  - ThinkingPanel / FileChangesPanel / ToolCallsPanel（三个折叠面板）
 *  - UsageStatsPanel（模型使用统计，自 Sessions 页并入 Chat hub）
 */
import { useEffect, useState } from 'react'
import {
  Activity, AlertTriangle, Brain, FileEdit, Wrench, AlertCircle, CheckCircle2,
  ChevronUp, ChevronDown, Clock,
} from 'lucide-react'
import { InlineEmptyState, Select, Skeleton } from '@/components/ui'
import { endpoints } from '@/lib/api'
import { formatTokens } from './chat-utils'

// ─── 类型定义 ────────────────────────────────────────────────────────────

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  error?: boolean
  /** 思考过程片段（来自 reasoning trace） */
  thinking?: string[]
  /** 文件修改明细 */
  fileChanges?: Array<{ path: string; action: 'create' | 'edit' | 'delete'; diff?: string }>
  /** 工具调用明细 */
  toolCalls?: Array<{ name: string; args?: string; result?: string; status?: 'ok' | 'error'; duration?: number }>
  /** 元数据：模型、provider、用量 */
  meta?: { model?: string; provider?: string; usage?: Record<string, unknown> }
}

// ─── 辅助函数 ────────────────────────────────────────────────────────────

/** 解析 SSE token 内容，提取嵌入的思考/文件变更/工具调用标记。
 *
 * 约定：模型/agent 可在 token 流中嵌入结构化标记（JSON 行），
 * 以 `{"_axon":"<event-type>",...}` 格式表示。未匹配的内容原样作为正文返回。
 */
export function parseTokenContent(raw: string, msg: Message): { text: string; msg: Message } {
  if (raw.startsWith('{"_axon":"thinking"')) {
    try {
      const obj = JSON.parse(raw) as { _axon: 'thinking'; content: string }
      return { text: '', msg: { ...msg, thinking: [...(msg.thinking ?? []), obj.content] } }
    } catch { /* fallthrough */ }
  }
  if (raw.startsWith('{"_axon":"file-change"')) {
    try {
      const obj = JSON.parse(raw) as {
        _axon: 'file-change'
        path: string
        action: 'create' | 'edit' | 'delete'
        diff?: string
      }
      return {
        text: '',
        msg: {
          ...msg,
          fileChanges: [...(msg.fileChanges ?? []), { path: obj.path, action: obj.action, diff: obj.diff }],
        },
      }
    } catch { /* fallthrough */ }
  }
  if (raw.startsWith('{"_axon":"tool-call"')) {
    try {
      const obj = JSON.parse(raw) as {
        _axon: 'tool-call'
        name: string
        args?: string
        result?: string
        status?: 'ok' | 'error'
        duration?: number
      }
      return {
        text: '',
        msg: {
          ...msg,
          toolCalls: [...(msg.toolCalls ?? []), {
            name: obj.name,
            args: obj.args,
            result: obj.result,
            status: obj.status,
            duration: obj.duration,
          }],
        },
      }
    } catch { /* fallthrough */ }
  }
  return { text: raw, msg }
}

// ─── 子组件 ──────────────────────────────────────────────────────────────

export function ToggleChip({
  active,
  onClick,
  icon,
  label,
  title,
  variant = 'default',
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  title: string
  variant?: 'default' | 'success'
}) {
  const base = 'flex items-center gap-1 rounded-full border px-2 py-1 text-2xs transition-colors'
  const styles =
    variant === 'success' && active
      ? 'border-[var(--success)] bg-[var(--success-soft)] text-[var(--success)]'
      : active
        ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`${base} ${styles}`}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

export function ThinkingPanel({ items }: { items: string[] }) {
  const [expanded, setExpanded] = useState(true)
  return (
    <div className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-2xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
      >
        <Brain size={12} className="text-[var(--accent)]" />
        <span>思考过程 ({items.length})</span>
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {expanded && (
        <div className="mt-2 space-y-1.5">
          {items.map((t, i) => (
            <p key={i} className="whitespace-pre-wrap break-words text-xs italic leading-relaxed text-[var(--text-muted)]">
              {t}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

export function FileChangesPanel({
  items,
  defaultExpanded,
}: {
  items: NonNullable<Message['fileChanges']>
  defaultExpanded: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const actionColor: Record<string, string> = {
    create: 'text-[var(--success)]',
    edit: 'text-[var(--warning)]',
    delete: 'text-[var(--danger)]',
  }
  return (
    <div className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-2xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
      >
        <FileEdit size={12} className="text-[var(--warning)]" />
        <span>文件修改明细 ({items.length})</span>
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {expanded && (
        <div className="mt-2 space-y-1.5">
          {items.map((c, i) => (
            <div key={i} className="rounded border border-[var(--border)] bg-[var(--surface)] p-1.5">
              <div className="flex items-center gap-2">
                <span className={`text-2xs font-semibold uppercase ${actionColor[c.action] ?? ''}`}>
                  {c.action}
                </span>
                <code className="flex-1 truncate font-mono text-xs text-[var(--text)]">{c.path}</code>
              </div>
              {c.diff && (
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-[var(--bg-tertiary)] p-1.5 font-mono text-2xs text-[var(--text-secondary)]">
                  {c.diff}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 尝试将字符串格式化为 pretty JSON；失败则原样返回 */
function tryFormatJSON(text: string): string {
  try {
    const parsed = JSON.parse(text)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return text
  }
}

/** 格式化耗时（毫秒） */
function formatDuration(ms?: number): string | null {
  if (ms === undefined || ms === null) return null
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ─── 使用统计面板（自 Sessions 页并入 Chat hub）────────────────────────────

interface UsageStat {
  provider: string
  model_name: string
  call_count: number
  total_prompt_tokens: number
  total_completion_tokens: number
  avg_latency_ms: number
  success_count: number
}

/** 模型使用统计面板——自 Sessions 页"使用统计"页签并入 Chat hub，数据与交互保持一致。 */
export function UsageStatsPanel() {
  const [usage, setUsage] = useState<UsageStat[]>([])
  const [days, setDays] = useState(7)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    endpoints.memory
      .usage(days)
      .then((d) => {
        if (cancelled) return
        const data = d as { usage: UsageStat[] }
        setUsage(Array.isArray(data.usage) ? data.usage : [])
      })
      .catch((e) => {
        if (!cancelled) setError(String((e as Error)?.message ?? e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [days])

  return (
    <div className="mx-auto w-full max-w-2xl p-4">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="type-title-m flex items-center gap-2 text-[var(--text)]">
          <Activity size={16} className="text-[var(--accent)]" />
          模型使用统计
        </h2>
        <Select
          label="统计周期"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="sm:w-40"
        >
          <option value={7}>近7天</option>
          <option value={30}>近30天</option>
          <option value={90}>近90天</option>
        </Select>
      </div>

      {error && (
        <p
          role="alert"
          className="mb-4 flex items-center gap-2 rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          <AlertTriangle size={16} className="shrink-0" />
          {error}
        </p>
      )}

      {loading ? (
        <div className="grid gap-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : usage.length === 0 ? (
        <InlineEmptyState
          icon={<Activity className="size-5" />}
          title="暂无使用数据"
        />
      ) : (
        <div className="space-y-3">
          {usage.map((u, i) => (
            <div
              key={i}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--text)]">{u.provider}</span>
                  <span className="text-xs text-[var(--text-muted)]">/ {u.model_name}</span>
                </div>
                <span className="text-xs text-[var(--text-secondary)]">
                  {u.call_count} 次调用
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]">
                <span>{formatTokens(u.total_prompt_tokens)}</span>
                <span>{formatTokens(u.total_completion_tokens)}</span>
                <span>{Math.round(u.avg_latency_ms)}ms</span>
                <span>
                  {u.call_count} 次调用 ·{' '}
                  {u.call_count > 0
                    ? Math.round((u.success_count / u.call_count) * 100)
                    : 0}
                  %
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ToolCallsPanel({
  items,
  defaultExpanded,
}: {
  items: NonNullable<Message['toolCalls']>
  defaultExpanded: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const okCount = items.filter((t) => t.status === 'ok').length
  const errCount = items.filter((t) => t.status === 'error').length
  return (
    <div className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-2xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
      >
        <Wrench size={12} className="text-[var(--info)]" />
        <span>工具调用 ({items.length})</span>
        {okCount > 0 && (
          <span className="flex items-center gap-0.5 text-[var(--success)]">
            <CheckCircle2 size={10} /> {okCount}
          </span>
        )}
        {errCount > 0 && (
          <span className="flex items-center gap-0.5 text-[var(--danger)]">
            <AlertCircle size={10} /> {errCount}
          </span>
        )}
        <span className="ml-auto">{expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-1.5">
          {items.map((t, i) => {
            const isError = t.status === 'error'
            const duration = formatDuration(t.duration)
            return (
              <div
                key={i}
                className={`rounded border p-1.5 ${
                  isError
                    ? 'border-[var(--danger-soft)] bg-[var(--danger-soft)]'
                    : 'border-[var(--border)] bg-[var(--surface)]'
                }`}
              >
                <div className="flex items-center gap-2">
                  {isError ? (
                    <AlertCircle size={11} className="shrink-0 text-[var(--danger)]" />
                  ) : t.status === 'ok' ? (
                    <CheckCircle2 size={11} className="shrink-0 text-[var(--success)]" />
                  ) : (
                    <Wrench size={11} className="shrink-0 text-[var(--info)]" />
                  )}
                  <code className="flex-1 truncate font-mono text-xs text-[var(--text)]">{t.name}</code>
                  {duration && (
                    <span className="flex items-center gap-0.5 text-2xs text-[var(--text-muted)]">
                      <Clock size={9} /> {duration}
                    </span>
                  )}
                  {isError && (
                    <span className="rounded bg-[var(--danger)] px-1 py-0.5 text-2xs font-bold text-white">
                      失败
                    </span>
                  )}
                </div>
                {t.args && (
                  <div className="mt-1">
                    <p className="mb-0.5 text-2xs font-medium text-[var(--text-muted)]">参数</p>
                    <pre className="max-h-32 overflow-auto rounded bg-[var(--bg-tertiary)] p-1.5 font-mono text-2xs text-[var(--text-secondary)]">
                      {tryFormatJSON(t.args)}
                    </pre>
                  </div>
                )}
                {t.result && (
                  <div className="mt-1">
                    <p className="mb-0.5 text-2xs font-medium text-[var(--text-muted)]">
                      {isError ? '错误信息' : '返回结果'}
                    </p>
                    <pre className={`max-h-32 overflow-auto rounded p-1.5 font-mono text-2xs ${
                      isError
                        ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
                        : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
                    }`}>
                      {tryFormatJSON(t.result)}
                    </pre>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
