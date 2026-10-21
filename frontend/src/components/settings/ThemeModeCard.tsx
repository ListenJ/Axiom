import type { ReactNode } from 'react'
import { Moon, Monitor, Sun } from 'lucide-react'
import { Button, ShimmerCard } from '@/components/ui'

export type ThemeMode = 'system' | 'dark' | 'light'

export function themeLabel(t: ThemeMode): string {
  return t === 'system' ? '系统' : t === 'dark' ? '深色' : '浅色'
}

/**
 * 外观分区的「主题」卡（2026-10-22 从 pages/Settings.tsx 抽出）
 *
 * 抽出原因：同批把 search/security 分区的说明卡加进设置页后，结构门禁
 * `tests/e2e-layout.test.ts` 的「页面应小于 650 行（防止臃肿）」变红（702 行）。
 * 该卡片自带完整交互（三态单选 + 即时高亮），独立成组件后页面回到门槛内，
 * 行为不变（外层 appearance 渲染器仍负责其它外观控件）。
 */
export default function ThemeModeCard({
  theme,
  setTheme,
  highlight,
}: {
  theme: ThemeMode
  setTheme: (t: ThemeMode) => void
  highlight: boolean
}): ReactNode {
  const icon =
    theme === 'system' ? (
      <Monitor className="size-5" />
    ) : theme === 'dark' ? (
      <Moon className="size-5" />
    ) : (
      <Sun className="size-5 text-[var(--warning)]" />
    )
  return (
    <ShimmerCard
      variant="accent"
      padding="md"
      className={highlight ? 'ring-2 ring-[var(--accent)]' : undefined}
    >
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex size-10 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
          {icon}
        </div>
        <div className="min-w-[10rem] flex-1 sm:min-w-0">
          <h3 className="text-sm font-medium text-[var(--text)]">主题</h3>
          <p className="text-xs text-[var(--text-secondary)]">
            当前：{themeLabel(theme)}；跟随系统时随系统深/浅实时切换。
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="主题切换"
          className="flex gap-1 rounded-lg bg-[var(--bg-tertiary)] p-1"
        >
          {(['system', 'dark', 'light'] as const).map((t) => (
            <Button
              key={t}
              size="sm"
              variant={theme === t ? 'primary' : 'ghost'}
              onClick={() => setTheme(t)}
              role="radio"
              aria-checked={theme === t}
              aria-label={`${themeLabel(t)}主题`}
            >
              {themeLabel(t)}
            </Button>
          ))}
        </div>
      </div>
    </ShimmerCard>
  )
}
