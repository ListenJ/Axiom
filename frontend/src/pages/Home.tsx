import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, Cpu, Globe, Zap, Sparkles, Send, Bot, Search, TrendingUp } from 'lucide-react'
import { StatCard, Input } from '@/components/ui'
import { endpoints } from '@/lib/api'

interface StatItem {
  label: string
  value: string
  icon: typeof Activity
  accent: 'default' | 'success' | 'warning' | 'info' | 'danger'
}

const defaultStats: StatItem[] = [
  { label: '活跃任务', value: '—', icon: Activity, accent: 'success' },
  { label: '智能体', value: '—', icon: Cpu, accent: 'default' },
  { label: '已完成', value: '—', icon: Globe, accent: 'info' },
  { label: 'Tokens', value: '—', icon: Zap, accent: 'warning' },
]

const quickActions = [
  { label: '搜索', icon: Search, path: '/search' },
  { label: '对话', icon: Bot, path: '/chat' },
  { label: '代码', icon: Cpu, path: '/code' },
  { label: '评估', icon: TrendingUp, path: '/eval' },
]

export default function Home() {
  const navigate = useNavigate()
  const [quickInput, setQuickInput] = useState('')
  const [stats, setStats] = useState<StatItem[]>(defaultStats)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    endpoints.perf
      .metrics()
      .then((d) => {
        if (d && typeof d === 'object') {
          const m = d as Record<string, unknown>
          setStats((prev) =>
            prev.map((item: StatItem) => {
              if (item.label === '活跃任务' && typeof m.activeTasks === 'number')
                return { ...item, value: String(m.activeTasks) }
              if (item.label === '智能体' && typeof m.agents === 'number')
                return { ...item, value: String(m.agents) }
              if (item.label === '已完成' && typeof m.completed === 'number')
                return { ...item, value: String(m.completed) }
              if (item.label === 'Tokens' && typeof m.tokensUsed === 'string')
                return { ...item, value: m.tokensUsed }
              return item
            }),
          )
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleQuickSend = () => {
    const text = quickInput.trim()
    if (!text) navigate('/chat')
    else navigate('/chat', { state: { initialMessage: text } })
  }

  return (
    <div className="mx-auto max-w-2xl pt-16 fade-in">
      {/* Stats — breathing room from top */}
      <section className="stagger grid grid-cols-2 gap-4" aria-busy={loading}>
        {stats.map((stat) => (
          <StatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
            icon={<stat.icon className="size-4" />}
            accent={stat.accent}
            loading={loading}
          />
        ))}
      </section>

      {/* Spacer — deliberate white space before input */}
      <div className="h-12" />

      {/* Input — centered, minimal chrome */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 transition-shadow duration-200 focus-within:shadow-[0_0_0_2px_var(--accent)]">
        <form
          onSubmit={(e) => { e.preventDefault(); handleQuickSend() }}
          className="flex items-center gap-3"
        >
          <Sparkles className="ml-1 size-4 shrink-0 text-[var(--accent)]" />
          <Input
            type="text"
            value={quickInput}
            onChange={(e) => setQuickInput(e.target.value)}
            placeholder="搜索或输入指令…"
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-0"
          />
          <div className="flex gap-1">
            {quickActions.map((action) => (
              <button
                key={action.path}
                type="button"
                onClick={() => navigate(action.path)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                aria-label={action.label}
              >
                <action.icon className="size-4" />
              </button>
            ))}
            <button
              type="submit"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)]"
              aria-label="发送"
            >
              <Send className="size-4" />
            </button>
          </div>
        </form>
      </div>

      {/* Status — subtle, deferred */}
      <div className="mt-10 flex items-center justify-center gap-2">
        <div className="size-1.5 rounded-full bg-[var(--success)]" />
        <span className="text-2xs text-[var(--text-muted)]">系统运行正常</span>
        <span className="text-2xs text-[var(--text-muted)]">·</span>
        <span className="text-2xs text-[var(--text-muted)]">{new Date().toISOString().slice(0, 10)}</span>
      </div>
    </div>
  )
}
