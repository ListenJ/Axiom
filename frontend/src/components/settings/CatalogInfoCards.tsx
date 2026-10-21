import { ShimmerCard } from '@/components/ui'
import { SETTINGS_CATALOG } from './settings-data'

/**
 * 通用「后端配置项」信息卡（2026-10-22）
 *
 * 背景：`search` / `security` 两个分区在后端 `src/core/settings-catalog.ts` 中有条目
 * （type=panel），但它们的实际编辑入口在 `config/web-search.yaml` / 模型配置里，不在设置页。
 * 此前前端既无分区也无条目 ⇒ 设置搜索能命中、点击却没有任何可见反馈（“点不动”）。
 *
 * 这里为这些条提供**可定位、可高亮**的说明卡，保证
 * 「搜索结果 → 分区自动展开 → 目标项可见（高亮环）」的闭环成立；编辑仍指向配置文件/模型页。
 *
 * 从 pages/Settings.tsx 抽出（同批结构门禁 `tests/e2e-layout.test.ts` 要求页面 <650 行）。
 */
export default function CatalogInfoCards({
  sectionId,
  highlightKey,
}: {
  sectionId: string
  highlightKey: string | null
}) {
  const items = SETTINGS_CATALOG.filter((i) => i.section === sectionId)
  if (items.length === 0) return null
  return (
    <>
      {items.map((item) => (
        <ShimmerCard
          key={item.key}
          padding="md"
          className={highlightKey === item.key ? 'ring-2 ring-[var(--accent)]' : undefined}
        >
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="text-sm font-medium text-[var(--text)]">{item.label}</h3>
              <code className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-2xs text-[var(--text-muted)]">
                {item.key}
              </code>
            </div>
            <p className="text-xs text-[var(--text-secondary)]">{item.desc}</p>
            <p className="text-2xs text-[var(--text-muted)]">
              编辑位置：<code className="font-mono">config/web-search.yaml</code> 或「模型」分区（改后重启/重载生效）
            </p>
          </div>
        </ShimmerCard>
      ))}
    </>
  )
}
