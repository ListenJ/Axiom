import { TrendingUp, Cpu, Search as SearchIcon, Sparkles } from 'lucide-react'

const suggestions = [
  { label: '深度研究', icon: TrendingUp, query: '帮我深入研究一个技术主题' },
  { label: '代码审查', icon: Cpu, query: '审查以下代码是否有问题' },
  { label: '知识问答', icon: SearchIcon, query: '解释一下什么是确定性记忆引擎' },
  { label: '创意写作', icon: Sparkles, query: '写一篇关于AI未来的短文' },
]

/** 首页欢迎建议卡片（与合并后的对话页共用）。 */
export default function WelcomePanel({ onSuggestion }: { onSuggestion: (query: string) => void }) {
  return (
    <div className="m-auto flex w-full max-w-2xl flex-col items-center gap-6 text-center">
      <div>
        <h1 className="text-shadow-readable font-display text-3xl font-bold tracking-tight text-[var(--text)] sm:text-4xl">
          有什么可以帮助你的？
        </h1>
        <p className="text-shadow-readable mt-2 text-base text-[var(--text-secondary)]">
          知识管理、代码分析、深度研究 — 尽在 Axiom
        </p>
      </div>
      <div className="stagger grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
        {suggestions.map((s) => {
          const Icon = s.icon
          return (
            <button
              key={s.label}
              type="button"
              onClick={() => onSuggestion(s.query)}
              className="group flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-transparent p-5 text-left shadow-[var(--shadow-sm)] transition-[border-color,box-shadow,transform] duration-200 hover:border-[var(--accent)] hover:shadow-[var(--shadow-md)]"
            >
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)] text-[var(--on-accent)] shadow-[var(--shadow-sm)] transition-transform group-hover:scale-110">
                <Icon className="size-6" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-base font-medium text-[var(--text)]">{s.label}</p>
                <p className="mt-0.5 truncate text-sm text-[var(--text-secondary)]">{s.query}</p>
              </div>
              <Sparkles className="size-4 shrink-0 text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          )
        })}
      </div>
    </div>
  )
}
