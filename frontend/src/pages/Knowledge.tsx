import { BookOpen, ArrowRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { PageHeader, Button, ShimmerCard } from '@/components/ui'

// 待审核内容已并入知识库 hub（/vault?tab=review），保留本页以兼容旧路由并引导跳转。
export default function Knowledge() {
  const navigate = useNavigate()
  return (
    <div className="space-y-5">
      <PageHeader
        icon={<BookOpen className="size-5" />}
        title="知识库"
        description="待审核笔记与知识沉淀入口。"
      />
      <ShimmerCard>
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
          知识库的笔记浏览、待审核笔记（pending review）与审核操作已迁移至「知识」Hub：
          待审核页签支持 approve / reject，笔记浏览支持全文检索。本页保留仅为兼容旧链接，会自动带您前往新入口。
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button icon={<ArrowRight className="size-4" />} onClick={() => navigate('/vault?tab=review')}>
            前往知识 Hub · 待审核
          </Button>
          <Button variant="outline" onClick={() => navigate('/vault')}>
            前往知识 Hub · 全部笔记
          </Button>
        </div>
      </ShimmerCard>
    </div>
  )
}