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
import { endpoints } from '../lib/api'
import ShimmerCard from '../components/ui/ShimmerCard'

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

type Tab = 'sessions' | 'usage'

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
      <div className="text-center py-12 text-text-secondary">
        <MessageSquare className="w-12 h-12 mx-auto mb-4 text-text-muted" />
        <p>暂无会话记录</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {sorted.map((s) => (
        <div
          key={s.session_id}
          onClick={() => onSelect(s.session_id)}
          className={`p-3 rounded-xl cursor-pointer transition-colors ${
            selectedId === s.session_id
              ? 'bg-blue-600/20 border border-blue-500/30'
              : 'bg-surface hover:bg-surface-hover border border-transparent'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-text truncate max-w-[200px]">
              {s.session_id.slice(0, 8)}...
            </span>
            <span className="text-xs text-text-secondary flex items-center gap-1">
              <MessageSquare className="w-3 h-3" />
              {s.message_count}
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs text-text-muted">
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
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
      <div className="text-center py-12 text-text-secondary">
        <MessageSquare className="w-12 h-12 mx-auto mb-4 text-text-muted" />
        <p>选择一个会话查看对话记录</p>
      </div>
    )
  }

  return (
    <div className="space-y-3 max-h-[500px] overflow-y-auto">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`p-3 rounded-xl ${
            msg.role === 'user'
              ? 'bg-blue-600/10 border border-blue-500/20 ml-8'
              : 'bg-surface border border-border mr-8'
          }`}
        >
          <div className="flex items-center gap-2 mb-2">
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                msg.role === 'user'
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'bg-green-600/20 text-green-400'
              }`}
            >
              {msg.role === 'user' ? '用户' : '助手'}
            </span>
            {msg.agent_id && (
              <span className="text-xs text-text-muted">{msg.agent_id}</span>
            )}
            {msg.latency_ms && (
              <span className="text-xs text-text-muted">
                {msg.latency_ms}ms
              </span>
            )}
          </div>
          <p className="text-sm text-text whitespace-pre-wrap">
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
      <div className="text-center py-12 text-text-secondary">
        <Activity className="w-12 h-12 mx-auto mb-4 text-text-muted" />
        <p>暂无使用数据</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {usage.map((u, i) => (
        <div key={i} className="p-3 rounded-xl bg-surface border border-border">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text">
                {u.provider}
              </span>
              <span className="text-xs text-text-muted">/ {u.model_name}</span>
            </div>
            <span className="text-xs text-text-secondary">
              {u.call_count} 次调用
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs text-text-muted">
            <span>
              提示: {formatTokens(u.total_prompt_tokens)}
            </span>
            <span>
              输出: {formatTokens(u.total_completion_tokens)}
            </span>
            <span>
              平均延迟: {Math.round(u.avg_latency_ms)}ms
            </span>
            <span>
              成功率: {u.call_count > 0 ? Math.round((u.success_count / u.call_count) * 100) : 0}%
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ── Main Component ────────────────────────────────────────────────── */

export default function Sessions() {
  const [activeTab, setActiveTab] = useState<Tab>('sessions')
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
    } catch {
      setError('加载失败')
    } finally {
      setLoading(false)
    }
  }

  const fetchMessages = async (sessionId: string) => {
    setSelectedSession(sessionId)
    try {
      const data = (await endpoints.memory.conversations(
        sessionId
      )) as { messages: Message[] }
      setMessages(data.messages || [])
    } catch {
      setMessages([])
    }
  }

  useEffect(() => {
    fetchAll()
  }, [days])

  const tabs = [
    { id: 'sessions' as Tab, label: '会话列表', icon: MessageSquare },
    { id: 'usage' as Tab, label: '使用统计', icon: Activity },
  ]

  return (
    <div className="min-h-screen bg-background p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Database className="w-8 h-8 text-blue-500" />
          <div>
            <h1 className="text-2xl font-bold text-text">会话管理</h1>
            <p className="text-sm text-text-secondary">
              查看会话历史、对话记录和使用统计
            </p>
          </div>
        </div>
        <button
          onClick={fetchAll}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          刷新
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-colors ${
              activeTab === tab.id
                ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                : 'bg-surface text-text-secondary hover:bg-surface-hover border border-transparent'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {error && (
        <div
          role="alert"
          className="p-4 mb-6 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 flex items-center gap-2"
        >
          <AlertTriangle className="w-5 h-5" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid gap-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 rounded-xl bg-surface animate-pulse"
            />
          ))}
        </div>
      ) : (
        <ShimmerCard>
          {activeTab === 'sessions' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <h2 className="text-lg font-semibold text-text mb-4 flex items-center gap-2">
                  <MessageSquare className="w-5 h-5 text-blue-400" />
                  会话列表 ({sessions.length})
                </h2>
                <SessionList
                  sessions={sessions}
                  onSelect={fetchMessages}
                  selectedId={selectedSession}
                />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-text mb-4 flex items-center gap-2">
                  <ChevronRight className="w-5 h-5 text-green-400" />
                  对话记录
                </h2>
                <ConversationViewer messages={messages} />
              </div>
            </div>
          )}

          {activeTab === 'usage' && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-text flex items-center gap-2">
                  <Activity className="w-5 h-5 text-purple-400" />
                  模型使用统计
                </h2>
                <select
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                  className="px-3 py-1 bg-surface border border-border rounded-lg text-sm text-text"
                >
                  <option value={7}>近7天</option>
                  <option value={30}>近30天</option>
                  <option value={90}>近90天</option>
                </select>
              </div>
              <UsageStats usage={usage} />
            </div>
          )}
        </ShimmerCard>
      )}
    </div>
  )
}
