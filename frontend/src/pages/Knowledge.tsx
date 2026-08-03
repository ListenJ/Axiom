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
          知识库的笔记浏览、待审核笔记（pending review）与审核操作已并入「知识」Hub 的待审核页签，
          支持 approve / reject 操作。本页保留仅为兼容旧链接。
        </p>
        <Button
          className="mt-4"
          icon={<ArrowRight className="size-4" />}
          onClick={() => navigate('/vault?tab=review')}
        >
          前往知识 Hub · 待审核
        </Button>
      </ShimmerCard>
    </div>
  )
}