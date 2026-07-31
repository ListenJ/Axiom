import { ScanText, ArrowRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { PageHeader, Button, ShimmerCard } from '@/components/ui'

// OCR 内容已迁入搜索 Hub（/search?tab=ocr），保留本页以兼容旧路由并引导跳转。
export default function OCR() {
  const navigate = useNavigate()
  return (
    <div className="space-y-5 fade-in">
      <PageHeader
        icon={<ScanText className="size-5" />}
        title="OCR 文字识别"
        description="本地 OCR 扫描、语言选择与结果导出。"
      />
      <ShimmerCard>
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
          文字识别已并入「搜索」Hub 的 OCR 页签：支持文件路径扫描、eng/chi_sim 等多语言识别、
          md/txt/json 结果导出。本页保留仅为兼容旧链接。
        </p>
        <Button
          className="mt-4"
          icon={<ArrowRight className="size-4" />}
          onClick={() => navigate('/search?tab=ocr')}
        >
          前往搜索 Hub · OCR
        </Button>
      </ShimmerCard>
    </div>
  )
}