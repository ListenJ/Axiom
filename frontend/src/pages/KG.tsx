import { Network, ArrowRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { PageHeader, Button, ShimmerCard } from '@/components/ui'

// 知识图谱内容已并入代码 hub（/code?tab=graph），保留本页以兼容旧路由并引导跳转。
export default function KG() {
  const navigate = useNavigate()
  return (
    <div className="stagger space-y-5 fade-in">
      <PageHeader
        icon={<Network className="size-5" />}
        title="知识图谱"
        description="实体关系、语义检索与深度研究入口。"
      />
      <ShimmerCard>
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
          知识图谱已并入「代码」Hub 的图谱页签，包含以下能力：实体与关系的统计概览（节点数、关系数、
          类型分布）、按名称的实体详情与邻接遍历、基于向量相似度的语义检索（需配置 embedding 模型）、
          以及 KG 增强的深度研究（research/run）。本页保留仅为兼容旧链接与直达入口，避免旧书签失效。
        </p>
        <Button
          className="mt-4"
          icon={<ArrowRight className="size-4" />}
          onClick={() => navigate('/code?tab=graph')}
        >
          前往代码 Hub · 图谱
        </Button>
      </ShimmerCard>
    </div>
  )
}