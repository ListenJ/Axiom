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
import ShimmerCard from '@/components/ui/ShimmerCard'
import StatCard from '@/components/ui/StatCard'
import Button from '@/components/ui/Button'
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
    desc: 'Tauri 2.0 + React 提供原生性能与 Web 开发效率。',
    icon: Bot,
  },
  {
    title: '响应式布局',
    desc: '侧边栏、底部导航、卡片网格自适应移动端与桌面端。',
    icon: TrendingUp,
  },
  {
    title: '确定性记忆',
    desc: '零向量、零 embedding，Obsidian Vault 共享记忆库。',
    icon: Database,
  },
  {
    title: '知识图谱',
    desc: '基于 SQLite 的实体关系网络，支持 BFS/最短路径/中心性。',
    icon: Network,
  },
  {
    title: '插件市场',
    desc: '动态加载 MCP 工具，支持开发者扩展 Agent 能力。',
    icon: Puzzle,
  },
  {
    title: '多模型路由',
    desc: '硅基流动 → OfoxAI → DeepSeek → OpenRouter 智能调度。',
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
          setStats((s) =>
            s.map((item) => {
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
            OpenClaw AI Agent · v2.3
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
            <input
              type="text"
              value={quickInput}
              onChange={(e) => setQuickInput(e.target.value)}
              placeholder="输入指令或问题，按回车发送…"
              className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {quickActions.map((action) => (
              <button
                key={action.path}
                type="button"
                onClick={() => navigate(action.path)}
                className="press flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--border-hover)] hover:text-[var(--text)]"
              >
                <action.icon className="size-3.5" />
                <span className="hidden sm:inline">{action.label}</span>
              </button>
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
              <p className="text-2xs text-[var(--text-muted)]">
                Tauri 2.0 · React 19 · Vite 6 · Tailwind 3
              </p>
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
