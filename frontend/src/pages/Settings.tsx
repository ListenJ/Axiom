import { Moon, Bell, Shield, Globe, Database, ChevronRight } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'

const settings = [
  { icon: Moon, label: '深色模式', desc: '始终使用深色主题', toggle: true },
  { icon: Bell, label: '通知', desc: '启用桌面通知', toggle: true },
  { icon: Shield, label: '隐私', desc: '本地优先，数据不离开设备', toggle: false },
  { icon: Globe, label: '语言', desc: '简体中文', toggle: false },
  { icon: Database, label: '数据存储', desc: '本地 SQLite + 远程同步', toggle: false },
]

export default function Settings() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">设置</h1>
        <p className="text-text-secondary">自定义 OpenClaw 的外观与行为。</p>
      </div>

      <div className="space-y-3">
        {settings.map((item) => {
          const Icon = item.icon
          return (
            <ShimmerCard key={item.label} glow={false}>
              <div className="flex items-center gap-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg text-text-secondary">
                  <Icon size={20} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium">{item.label}</h3>
                  <p className="text-sm text-text-secondary">{item.desc}</p>
                </div>
                {item.toggle ? (
                  <button
                    type="button"
                    className="relative h-6 w-11 rounded-full bg-accent transition-colors"
                    aria-label={`切换 ${item.label}`}
                  >
                    <span className="absolute right-1 top-1 h-4 w-4 rounded-full bg-white" />
                  </button>
                ) : (
                  <ChevronRight className="size-5 text-text-muted" />
                )}
              </div>
            </ShimmerCard>
          )
        })}
      </div>
    </div>
  )
}
