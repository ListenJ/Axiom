/**
 * 调试与检查 — 子面板组
 *
 * 将原先独立路由的调试/检查页（性能 / Token 用量 / 模型路由 / 代理 / 模型评估）
 * 收敛进设置页「调试与检查」分区，独立路由保留用于深链兼容。
 */
import { Gauge, Coins, Compass, Globe, BarChart3 } from 'lucide-react'
import { Collapsible } from '@/components/ui'
import { PerfPanel } from '@/pages/Perf'
import { TokensPanel } from '@/pages/Tokens'
import { RouterPanel } from '@/pages/Router'
import { ProxiesPanel } from '@/pages/Proxies'
import { EvalPanel } from '@/pages/Eval'

export default function DebugPanelsSection() {
  return (
    <div className="stagger space-y-3">
      <Collapsible
        icon={<Gauge className="size-4" />}
        title="性能指标"
        description="运行时 CPU / 内存 / RPS / P95 与原生模块统计"
        className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]"
      >
        <PerfPanel />
      </Collapsible>

      <Collapsible
        icon={<Coins className="size-4" />}
        title="Token 用量"
        description="近 7 天模型调用、Token 消耗与缓存命中率"
        className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]"
      >
        <TokensPanel />
      </Collapsible>

      <Collapsible
        icon={<Compass className="size-4" />}
        title="模型路由"
        description="健康模型数、Token 使用与路由状态"
        className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]"
      >
        <RouterPanel />
      </Collapsible>

      <Collapsible
        icon={<Globe className="size-4" />}
        title="代理状态"
        description="出站代理配置与活跃状态（只读）"
        className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]"
      >
        <ProxiesPanel />
      </Collapsible>

      <Collapsible
        icon={<BarChart3 className="size-4" />}
        title="模型评估"
        description="评估结果、动态分配与模型清单，可触发快速评估"
        className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]"
      >
        <EvalPanel />
      </Collapsible>
    </div>
  )
}
