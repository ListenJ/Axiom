import { Send, Paperclip, Bot, User } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'

const messages = [
  { role: 'user', content: '帮我分析这段代码的性能瓶颈。' },
  { role: 'assistant', content: '已收到请求。从代码结构看，主要瓶颈在于频繁的状态更新导致大量重渲染，建议将状态提升到公共父组件或使用 memo 优化。' },
  { role: 'user', content: '如何集成 Tauri 2.0 与 React？' },
  { role: 'assistant', content: '可以使用 Vite 创建 React 模板，然后通过 @tauri-apps/cli 初始化 Tauri，配置 frontendDist 指向 Vite 构建输出即可。' },
]

export default function Chat() {
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">对话</h1>
        <p className="text-text-secondary">与 OpenClaw AI Agent 实时交互。</p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-2xl border border-border bg-surface p-4">
        {messages.map((msg, i) => (
          <ShimmerCard key={i} glow={msg.role === 'assistant'} className="max-w-[85%] self-start">
            <div className="flex items-start gap-3">
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  msg.role === 'assistant' ? 'bg-accent/20 text-accent' : 'bg-surface-hover text-text-secondary'
                }`}
              >
                {msg.role === 'assistant' ? <Bot size={16} /> : <User size={16} />}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-secondary">{msg.role === 'assistant' ? 'OpenClaw' : '你'}</p>
                <p className="mt-1 text-sm leading-relaxed text-text">{msg.content}</p>
              </div>
            </div>
          </ShimmerCard>
        ))}
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-text-secondary transition-colors hover:text-text"
          aria-label="附件"
        >
          <Paperclip size={18} />
        </button>
        <input
          type="text"
          placeholder="输入消息..."
          className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-bg px-4 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-white transition-colors hover:bg-accent-hover"
          aria-label="发送"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  )
}
