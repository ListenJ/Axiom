import { Microscope, ArrowRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { PageHeader, Button, ShimmerCard } from '@/components/ui'

// 深度研究内容已迁入搜索 Hub（/search?tab=research），保留本页以兼容旧路由并引导跳转。
export default function Research() {
  const navigate = useNavigate()
  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Microscope className="size-5" />}
        title="深度研究"
        description="KG 增强的多源检索与结构化研究报告。"
      />
      <ShimmerCard>
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
          深度研究已并入「搜索」Hub 的研究页签：可配置搜索深度（1-5）与最大来源数，
          输出研究摘要、相关实体与可追溯来源列表。本页保留仅为兼容旧链接。
        </p>
        <Button
          className="mt-4"
          icon={<ArrowRight className="size-4" />}
          onClick={() => navigate('/search?tab=research')}
        >
          前往搜索 Hub · 深度研究
        </Button>
      </ShimmerCard>
    </div>
  )
}