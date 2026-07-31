import { TrendingUp, ArrowRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { PageHeader, Button, ShimmerCard } from '@/components/ui'

// 趋势分析内容已迁入搜索 Hub（/search?tab=trends），保留本页以兼容旧路由并引导跳转。
export default function Trends() {
  const navigate = useNavigate()
  return (
    <div className="stagger space-y-5 fade-in">
      <PageHeader
        icon={<TrendingUp className="size-5" />}
        title="趋势分析"
        description="搜索、对话、模型调用与任务的统计趋势。"
      />
      <ShimmerCard>
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
          趋势分析已并入「搜索」Hub 的趋势页签：支持 1/7/30/90 天周期切换，
          含总搜索量、总对话数、活跃模型与任务状态分布。本页保留仅为兼容旧链接。
        </p>
        <Button
          className="mt-4"
          icon={<ArrowRight className="size-4" />}
          onClick={() => navigate('/search?tab=trends')}
        >
          前往搜索 Hub · 趋势
        </Button>
      </ShimmerCard>
    </div>
  )
}