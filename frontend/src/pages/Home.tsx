import { Activity, Cpu, Globe, Zap, ArrowUpRight, Sparkles } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'

const stats = [
  { label: '活跃任务', value: '12', icon: Activity, change: '+2', color: 'text-emerald-400' },
  { label: '智能体', value: '4', icon: Cpu, change: '+1', color: 'text-blue-400' },
  { label: '已完成', value: '128', icon: Globe, change: '+14', color: 'text-purple-400' },
  { label: 'Tokens', value: '2.4M', icon: Zap, change: '+8%', color: 'text-amber-400' },
]

const features = [
  {
    title: '多智能体编排',
    desc: 'Tauri 2.0 + React 提供原生性能与 Web 开发效率。',
    glow: true,
  },
  {
    title: '响应式布局',
    desc: '侧边栏、底部导航、卡片网格自适应移动端与桌面端。',
    glow: false,
  },
  {
    title: '光影动效',
    desc: 'Shimmer 与 Border Glow 为关键卡片注入视觉焦点。',
    glow: true,
  },
]

export default function Home() {
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Sparkles className="size-6 text-accent" />
          仪表盘
        </h1>
        <p className="text-text-secondary">欢迎回来，今日任务与系统状态一览。</p>
      </section>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon
          return (
            <ShimmerCard key={stat.label} glow={false}>
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-sm text-text-secondary">{stat.label}</p>
                  <p className="text-2xl font-bold">{stat.value}</p>
                </div>
                <div className={`rounded-lg bg-bg p-2 ${stat.color}`}>
                  <Icon size={20} />
                </div>
              </div>
              <div className="mt-3 flex items-center gap-1 text-xs">
                <span className="text-emerald-400">{stat.change}</span>
                <span className="text-text-muted">较昨日</span>
                <ArrowUpRight className="ml-auto size-3 text-text-muted" />
              </div>
            </ShimmerCard>
          )
        })}
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {features.map((feature) => (
          <ShimmerCard key={feature.title} glow={feature.glow}>
            <h3 className="text-lg font-semibold">{feature.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">{feature.desc}</p>
          </ShimmerCard>
        ))}
      </section>

      <section className="rounded-2xl border border-border bg-surface p-4">
        <h2 className="mb-3 text-base font-semibold">快速输入</h2>
        <div className="flex gap-3">
          <input
            type="text"
            placeholder="输入指令或问题..."
            className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-bg px-4 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            className="shrink-0 rounded-xl bg-accent px-5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
          >
            发送
          </button>
        </div>
      </section>
    </div>
  )
}
