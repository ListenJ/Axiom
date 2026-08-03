import { useState, useEffect } from 'react'
import {
  MessageSquare,
  Clock,
  Activity,
  Database,
  ChevronRight,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react'
import {
  ShimmerCard,
  Button,
  PageHeader,
  Tabs,
  Select,
  Skeleton,
  InlineEmptyState,
} from '@/components/ui'
import { endpoints } from '@/lib/api'

/* ── Types ─────────────────────────────────────────────────────────── */

interface Session {
  session_id: string
  message_count: number
  user_messages: number
  assistant_messages: number
  total_tokens: number
  started_at: number
  last_active: number
}

interface Message {
  id: string
  session_id: string
  role: string
  content: string
  agent_id?: string
  tokens_used?: number
  latency_ms?: number
  created_at: number
}

interface UsageStat {
  provider: string
  model_name: string
  call_count: number
  total_prompt_tokens: number
  total_completion_tokens: number
  avg_latency_ms: number
  success_count: number
}

/* ── Helpers ───────────────────────────────────────────────────────── */

function formatTime(epoch: number): string {
  if (!epoch) return '—'
  const date = new Date(epoch * 1000)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin}分钟前`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}小时前`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}天前`
  return date.toLocaleDateString('zh-CN')
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
  return String(tokens)
}

function truncateText(text: string, maxLen: number): string {
  if (!text) return ''
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text
}

/* ── Session List Component ────────────────────────────────────────── */

function SessionList({
  sessions,
  onSelect,
  selectedId,
}: {
  sessions: Session[]
  onSelect: (id: string) => void
  selectedId: string | null
}) {
  const sorted = [...sessions].sort((a, b) => b.last_active - a.last_active)

  if (sorted.length === 0) {
    return (
      <InlineEmptyState
        icon={<MessageSquare className="size-5" />}
        title="暂无会话记录"
      />
    )
  }

  return (
    <div className="space-y-2">
      {sorted.map((s) => (
        <div
          key={s.session_id}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(s.session_id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onSelect(s.session_id)
          }}
          className={`cursor-pointer rounded-xl border p-3 transition-colors ${
            selectedId === s.session_id
              ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
              : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]'
          }`}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="max-w-[200px] truncate text-sm font-medium text-[var(--text)]">
              {s.session_id.slice(0, 8)}...
            </span>
            <span className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
              <MessageSquare className="size-3" />
              {s.message_count}
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs text-[var(--text-muted)]">
            <span className="flex items-center gap-1">
              <Clock className="size-3" />
              {formatTime(s.last_active)}
            </span>
            <span>{formatTokens(s.total_tokens)} tokens</span>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ── Conversation Viewer Component ─────────────────────────────────── */

function ConversationViewer({ messages }: { messages: Message[] }) {
  if (messages.length === 0) {
    return (
      <InlineEmptyState
        icon={<MessageSquare className="size-5" />}
        title="选择一个会话"
      />
    )
  }

  return (
    <div className="max-h-[500px] space-y-3 overflow-y-auto">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`rounded-xl border p-3 ${
            msg.role === 'user'
              ? 'ml-8 border-[var(--accent-soft)] bg-[var(--accent-soft)]'
              : 'mr-8 border-[var(--border)] bg-[var(--surface)]'
          }`}
        >
          <div className="mb-2 flex items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                msg.role === 'user'
                  ? 'bg-[var(--accent)] text-white'
                  : 'border border-[var(--border)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
              }`}
            >
              {msg.role === 'user' ? '用户' : '助手'}
            </span>
            {msg.agent_id && (
              <span className="text-xs text-[var(--text-muted)]">{msg.agent_id}</span>
            )}
            {msg.latency_ms && (
              <span className="text-xs text-[var(--text-muted)]">{msg.latency_ms}ms</span>
            )}
          </div>
          <p className="whitespace-pre-wrap text-sm text-[var(--text)]">
            {truncateText(msg.content, 500)}
          </p>
        </div>
      ))}
    </div>
  )
}

/* ── Usage Stats Component ─────────────────────────────────────────── */

function UsageStats({ usage }: { usage: UsageStat[] }) {
  if (usage.length === 0) {
    return (
      <InlineEmptyState
        icon={<Activity className="size-5" />}
        title="暂无使用数据"
      />
    )
  }

  return (
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
            <span>{u.call_count} 次调用 · {' '}
              {u.call_count > 0
                ? Math.round((u.success_count / u.call_count) * 100)
                : 0}
              %
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ── Main Component ────────────────────────────────────────────────── */

export default function Sessions() {
  const [activeTab, setActiveTab] = useState<'sessions' | 'usage'>('sessions')
  const [sessions, setSessions] = useState<Session[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [usage, setUsage] = useState<UsageStat[]>([])
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState(7)

  const fetchAll = async () => {
    setLoading(true)
    setError(null)
    try {
      const [sessionsRes, usageRes] = await Promise.allSettled([
        endpoints.memory.sessions(),
        endpoints.memory.usage(days),
      ])

      if (sessionsRes.status === 'fulfilled') {
        const data = sessionsRes.value as { sessions: Session[] }
        setSessions(data.sessions || [])
      }

      if (usageRes.status === 'fulfilled') {
        const data = usageRes.value as { usage: UsageStat[] }
        setUsage(data.usage || [])
      }

      const rejected = [sessionsRes, usageRes].find((r) => r.status === 'rejected') as
        | PromiseRejectedResult
        | undefined
      if (rejected) {
        setError(String(rejected.reason?.message ?? rejected.reason))
      }
    } catch {
      setError('加载失败')
    } finally {
      setLoading(false)
    }
  }

  const fetchMessages = async (sessionId: string) => {
    setSelectedSession(sessionId)
    try {
      const data = (await endpoints.memory.conversations(sessionId)) as {
        messages: Message[]
      }
      setMessages(data.messages || [])
    } catch {
      setMessages([])
    }
  }

  useEffect(() => {
    fetchAll()
  }, [days])

  const tabs = [
    {
      id: 'sessions' as const,
      label: '会话列表',
      icon: <MessageSquare className="size-3.5" />,
      badge: sessions.length,
    },
    {
      id: 'usage' as const,
      label: '使用统计',
      icon: <Activity className="size-3.5" />,
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Database className="size-5" />}
        title="会话管理"
        description="查看会话历史、对话记录和使用统计。"
        actions={
          <Button
            variant="secondary"
            onClick={fetchAll}
            loading={loading}
            icon={<RefreshCw className="size-4" />}
          >
            刷新
          </Button>
        }
      />

      <Tabs
        tabs={tabs}
        active={activeTab}
        onChange={(id) => setActiveTab(id as typeof activeTab)}
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

      {loading ? (
        <div className="grid gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : (
        <ShimmerCard>
          {activeTab === 'sessions' && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div>
                <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--text)]">
                  <MessageSquare className="size-4 text-[var(--accent)]" />
                  会话列表 ({sessions.length})
                </h2>
                <SessionList
                  sessions={sessions}
                  onSelect={fetchMessages}
                  selectedId={selectedSession}
                />
              </div>
              <div>
                <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--text)]">
                  <ChevronRight className="size-4 text-[var(--success)]" />
                  对话记录
                </h2>
                <ConversationViewer messages={messages} />
              </div>
            </div>
          )}

          {activeTab === 'usage' && (
            <div>
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--text)]">
                  <Activity className="size-4 text-[var(--accent)]" />
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
              <UsageStats usage={usage} />
            </div>
          )}
        </ShimmerCard>
      )}
    </div>
  )
}
