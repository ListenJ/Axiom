import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Send, Paperclip, Bot, User, MessageSquare } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
import PageHeader from '@/components/ui/PageHeader'
import { endpoints, HttpError } from '@/lib/api'
import { useApp } from '@/state/useApp'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
}

function nextId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

export default function Chat() {
  const location = useLocation()
  const initialMessage = (location.state as { initialMessage?: string } | null)?.initialMessage
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scroller = useRef<HTMLDivElement | null>(null)
  const toast = useApp((s) => s.toast)

  useEffect(() => {
    endpoints.chat
      .history()
      .then((d) => {
        if (Array.isArray(d)) {
          setMessages(
            d
              .filter((m): m is { role: string; content: string } =>
                typeof m === 'object' && m !== null && 'role' in m && 'content' in m,
              )
              .map((m) => ({
                id: nextId(),
                role: m.role === 'user' ? 'user' : 'assistant',
                content: String(m.content ?? ''),
              })),
          )
        }
      })
      .catch(() => {
        // ignore — history endpoint may be unavailable
      })
  }, [])

  useEffect(() => {
    if (scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight
    }
  }, [messages])

  useEffect(() => {
    if (initialMessage && !sending && messages.length === 0) {
      setInput(initialMessage)
    }
  }, [initialMessage])

  const send = async (text?: string) => {
    const msg = (text ?? input).trim()
    if (!msg || sending) return
    const userMsg: Message = { id: nextId(), role: 'user', content: msg }
    setMessages((m) => [...m, userMsg])
    setInput('')
    setSending(true)
    try {
      const res = await endpoints.chat.send(msg)
      const content =
        typeof res === 'string'
          ? res
          : res && typeof res === 'object' && 'message' in (res as Record<string, unknown>)
            ? String((res as Record<string, unknown>).message)
            : JSON.stringify(res)
      setMessages((m) => [...m, { id: nextId(), role: 'assistant', content }])
    } catch (e) {
      const errMsg = e instanceof HttpError ? e.message : String((e as Error)?.message ?? e)
      setMessages((m) => [...m, { id: nextId(), role: 'assistant', content: `[错误] ${errMsg}` }])
      toast('发送失败：' + errMsg, 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <PageHeader
        icon={<MessageSquare className="size-5 text-accent" />}
        title="对话"
        description="与 OpenClaw AI Agent 实时交互"
      />

      <div
        ref={scroller}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-2xl border border-border bg-surface p-4"
      >
        {messages.length === 0 && (
          <p className="m-auto text-sm text-text-muted">开始对话吧（按 1 聚焦 /）。</p>
        )}
        {messages.map((msg) => (
          <ShimmerCard
            key={msg.id}
            glow={msg.role === 'assistant'}
            className={`max-w-[85%] ${msg.role === 'user' ? 'self-end' : 'self-start'}`}
          >
            <div className="flex items-start gap-3">
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  msg.role === 'assistant'
                    ? 'bg-accent/20 text-accent'
                    : 'bg-surface-hover text-text-secondary'
                }`}
              >
                {msg.role === 'assistant' ? <Bot size={16} /> : <User size={16} />}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-secondary">
                  {msg.role === 'assistant' ? 'OpenClaw' : '你'}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-text">
                  {msg.content}
                </p>
              </div>
            </div>
          </ShimmerCard>
        ))}
        {sending && (
          <ShimmerCard className="max-w-[40%] self-start" glow>
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <span className="size-1.5 animate-pulse rounded-full bg-accent" />
              <span className="size-1.5 animate-pulse rounded-full bg-accent [animation-delay:120ms]" />
              <span className="size-1.5 animate-pulse rounded-full bg-accent [animation-delay:240ms]" />
              思考中…
            </div>
          </ShimmerCard>
        )}
      </div>

      <div className="flex gap-2 sm:gap-3">
        <button
          type="button"
          className="focus-ring hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-text-secondary transition hover:text-text sm:flex"
          aria-label="附件"
        >
          <Paperclip size={18} />
        </button>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder="输入消息，回车发送…"
          className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-bg px-4 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          aria-label="消息输入"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || !input.trim()}
          className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-white transition hover:bg-accent-hover disabled:opacity-50 sm:w-auto sm:px-5"
          aria-label="发送"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  )
}
