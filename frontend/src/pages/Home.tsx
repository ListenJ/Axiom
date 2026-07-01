import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Activity,
  Cpu,
  Globe,
  Zap,
  ArrowUpRight,
  Sparkles,
  Send,
  TrendingUp,
  Database,
  Network,
  Puzzle,
  Bot,
  Search,
} from 'lucide-react'
import { ShimmerCard, StatCard, Button, Input } from '@/components/ui'
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

const features = [
  {
    title: '多智能体编排',
    desc: '多个专家智能体协同完成复杂任务。',
    icon: Bot,
  },
  {
    title: '响应式布局',
    desc: '自适应桌面与移动端的交互体验。',
    icon: TrendingUp,
  },
  {
    title: '确定性记忆',
    desc: '共享记忆库，持久化跨会话上下文。',
    icon: Database,
  },
  {
    title: '知识图谱',
    desc: '实体关系网络与路径分析。',
    icon: Network,
  },
  {
    title: '插件市场',
    desc: '插件扩展 Agent 能力。',
    icon: Puzzle,
  },
  {
    title: '多模型路由',
    desc: '多模型智能路由与调度。',
    icon: Sparkles,
  },
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
              if (item.label === '活跃任务' && typeof m.activeTasks === 'number') {
                return { ...item, value: String(m.activeTasks) }
              }
              if (item.label === '智能体' && typeof m.agents === 'number') {
                return { ...item, value: String(m.agents) }
              }
              if (item.label === '已完成' && typeof m.completed === 'number') {
                return { ...item, value: String(m.completed) }
              }
              if (item.label === 'Tokens' && typeof m.tokensUsed === 'string') {
                return { ...item, value: m.tokensUsed }
              }
              return item
            }),
          )
        }
      })
      .catch(() => {
        // metrics endpoint may be unavailable
      })
      .finally(() => setLoading(false))
  }, [])

  const handleQuickSend = () => {
    const text = quickInput.trim()
    if (!text) return
    navigate('/chat', { state: { initialMessage: text } })
  }

  return (
    <div className="space-y-6 fade-in">
      {/* Hero Section */}
      <section className="space-y-1">
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-[var(--accent)]" />
          <span className="text-2xs font-semibold uppercase tracking-wider text-[var(--accent)]">
            Axiom AI Agent
          </span>
        </div>
        <h1 className="font-display text-3xl tracking-tight text-[var(--text)]">
          欢迎回来
        </h1>
        <p className="text-sm text-[var(--text-secondary)]">
          今日任务与系统状态一览。
        </p>
      </section>

      {/* Quick Input */}
      <ShimmerCard padding="md">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleQuickSend()
          }}
          className="flex flex-col gap-3 sm:flex-row sm:items-center"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Sparkles className="size-4 shrink-0 text-[var(--accent)]" />
            <Input
              type="text"
              value={quickInput}
              onChange={(e) => setQuickInput(e.target.value)}
              placeholder="输入指令…"
              className="min-w-0 flex-1 border-transparent bg-transparent focus:ring-0"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {quickActions.map((action) => (
              <Button
                key={action.path}
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => navigate(action.path)}
                icon={<action.icon className="size-3.5" />}
              >
                <span className="hidden sm:inline">{action.label}</span>
              </Button>
            ))}
            <Button
              type="submit"
              size="sm"
              disabled={!quickInput.trim()}
              icon={<Send className="size-3.5" />}
            >
              <span className="hidden sm:inline">发送</span>
            </Button>
          </div>
        </form>
      </ShimmerCard>

      {/* Stats Grid */}
      <section
        className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
        aria-busy={loading}
      >
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

      {/* Features Grid */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-lg font-semibold text-[var(--text)]">
            核心能力
          </h2>
          <span className="text-2xs text-[var(--text-muted)]">
            {features.length} 项功能
          </span>
        </div>
        <div className="stagger grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <ShimmerCard
              key={feature.title}
              hoverable
              pressable
              animate
              className="group"
            >
              <div className="flex items-start gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] transition-transform duration-200 group-hover:scale-110">
                  <feature.icon className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-[var(--text)]">
                      {feature.title}
                    </h3>
                    <ArrowUpRight className="size-3.5 shrink-0 text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                    {feature.desc}
                  </p>
                </div>
              </div>
            </ShimmerCard>
          ))}
        </div>
      </section>

      {/* Status Banner */}
      <ShimmerCard variant="muted" padding="md">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="pulse-dot size-2 rounded-full bg-[var(--success)]" />
          <div>
            <p className="text-sm font-medium text-[var(--text)]">系统运行正常</p>
            <p className="text-2xs text-[var(--text-muted)]">全部服务在线</p>
          </div>
          </div>
          <span className="font-mono text-2xs text-[var(--text-muted)]">
            {new Date().toISOString().slice(0, 10)}
          </span>
        </div>
      </ShimmerCard>
    </div>
  )
}
