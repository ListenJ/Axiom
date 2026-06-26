import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles, Send, MessageSquare, Search } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
import Button from '@/components/ui/Button'

export default function Home() {
  const navigate = useNavigate()
  const [quickInput, setQuickInput] = useState('')

  const handleQuickSend = () => {
    const text = quickInput.trim()
    if (!text) return
    navigate('/chat', { state: { initialMessage: text } })
  }

  return (
    <div className="fade-in space-y-6">
      {/* Hero */}
      <section className="space-y-1">
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-[var(--accent)]" />
          <span className="text-2xs font-semibold uppercase tracking-wider text-[var(--accent)]">
            OpenClaw AI Agent
          </span>
        </div>
        <h1 className="font-display text-3xl tracking-tight text-[var(--text)]">
          Welcome back
        </h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Ask anything. The agent handles the rest.
        </p>
      </section>

      {/* Quick Input */}
      <ShimmerCard padding="md">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleQuickSend()
          }}
          className="flex flex-col gap-3 sm:flex-row sm:items-center"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Sparkles className="size-4 shrink-0 text-[var(--accent)]" />
            <input
              type="text"
              value={quickInput}
              onChange={(e) => setQuickInput(e.target.value)}
              placeholder="Ask a question or give a command..."
              className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => navigate('/chat')}
              className="press flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--border-hover)] hover:text-[var(--text)]"
            >
              <MessageSquare className="size-3.5" />
              <span className="hidden sm:inline">Chat</span>
            </button>
            <button
              type="button"
              onClick={() => navigate('/search')}
              className="press flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--border-hover)] hover:text-[var(--text)]"
            >
              <Search className="size-3.5" />
              <span className="hidden sm:inline">Search</span>
            </button>
            <Button
              type="submit"
              size="sm"
              disabled={!quickInput.trim()}
              icon={<Send className="size-3.5" />}
            >
              <span className="hidden sm:inline">Send</span>
            </Button>
          </div>
        </form>
      </ShimmerCard>

      {/* Status */}
      <ShimmerCard variant="muted" padding="md">
        <div className="flex items-center gap-3">
          <div className="pulse-dot size-2 rounded-full bg-[var(--success)]" />
          <p className="text-sm text-[var(--text-secondary)]">All systems operational</p>
        </div>
      </ShimmerCard>
    </div>
  )
}
