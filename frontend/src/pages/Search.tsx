import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search as SearchIcon, Microscope, TrendingUp, ScanText } from 'lucide-react'
import { PageHeader, Tabs } from '@/components/ui'
import { FadeIn } from '@/components/motion'
import { SearchPanel, ResearchPanel, TrendsPanel, OcrPanel } from '@/components/search-panels'

/* ── 搜索 Hub：/search?tab=search|research|trends|ocr，默认 search ── */

type HubTab = 'search' | 'research' | 'trends' | 'ocr'
const HUB_TABS: Array<{ id: HubTab; label: string; icon: ReactNode }> = [
  { id: 'search', label: '搜索', icon: <SearchIcon className="size-3.5" /> },
  { id: 'research', label: '深度研究', icon: <Microscope className="size-3.5" /> },
  { id: 'trends', label: '趋势', icon: <TrendingUp className="size-3.5" /> },
  { id: 'ocr', label: 'OCR', icon: <ScanText className="size-3.5" /> },
]

export default function Search() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab: HubTab = HUB_TABS.some((t) => t.id === tabParam) ? (tabParam as HubTab) : 'search'

  const handleTabChange = (id: string) => {
    // 默认 tab 不写 param，保持 /search 直达搜索
    setSearchParams(id === 'search' ? {} : { tab: id })
  }

  return (
    <div className="space-y-5 fade-in">
      <PageHeader
        icon={<SearchIcon className="size-5" />}
        title="搜索"
        description="搜索笔记与代码、深度研究、趋势分析与文字识别。"
      />

      <Tabs
        tabs={HUB_TABS.map((t) => ({ id: t.id, label: t.label, icon: t.icon }))}
        active={tab}
        onChange={handleTabChange}
      />

      <FadeIn key={tab}>
        {tab === 'search' && <SearchPanel />}
        {tab === 'research' && <ResearchPanel />}
        {tab === 'trends' && <TrendsPanel />}
        {tab === 'ocr' && <OcrPanel />}
      </FadeIn>
    </div>
  )
}