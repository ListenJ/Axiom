import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  Send, Paperclip, Bot, User, MessageSquare,
  Clock, Activity, ChevronLeft, ChevronRight,
} from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
import { endpoints, HttpError } from '@/lib/api'
import { useApp } from '@/state/useApp'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
}

interface Session {
  session_id: string
  message_count: number
  total_tokens: number
  last_active: number
}

function nextId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

function formatTime(epoch: number): string {
  if (!epoch) return '-'
  const date = new Date(epoch * 1000)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return date.toLocaleDateString()
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
  return String(tokens)
}

export default function Chat() {
  const location = useLocation()
  const initialMessage = (location.state as { initialMessage?: string } | null)?.initialMessage
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scroller = useRef<HTMLDivElement | null>(null)
  const toast = useApp((s) => s.toast)

  // Sessions sidebar state
  const [sessions, setSessions] = useState<Session[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(false)

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
      .catch(() => {})
  }, [])

  // Load sessions for sidebar
  useEffect(() => {
    endpoints.memory
      .sessions()
      .then((d) => {
        const data = d as { sessions: Session[] }
        if (Array.isArray(data.sessions)) {
          setSessions(data.sessions.sort((a, b) => b.last_active - a.last_active))
        }
      })
      .catch(() => {})
  }, [messages.length]) // Refresh when messages change

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
      setMessages((m) => [...m, { id: nextId(), role: 'assistant', content: `[Error] ${errMsg}` }])
      toast('Send failed: ' + errMsg, 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full gap-0">
      {/* Sessions Sidebar */}
      <div
        className={`${
          sidebarOpen ? 'w-64' : 'w-0'
        } shrink-0 overflow-hidden border-r border-border bg-surface transition-all duration-300`}
      >
        <div className="flex h-full w-64 flex-col">
          <div className="flex items-center justify-between border-b border-border p-3">
            <span className="text-sm font-semibold text-text">Sessions</span>
            <button
              onClick={() => setSidebarOpen(false)}
              className="rounded-lg p-1 text-text-muted hover:text-text"
            >
              <ChevronLeft size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {sessions.length === 0 ? (
              <p className="p-4 text-center text-xs text-text-muted">No sessions yet</p>
            ) : (
              <div className="space-y-1">
                {sessions.map((s) => (
                  <div
                    key={s.session_id}
                    className="cursor-pointer rounded-lg p-2 transition-colors hover:bg-surface-hover"
                  >
                    <div className="flex items-center justify-between">
                      <span className="truncate text-xs font-medium text-text">
                        {s.session_id.slice(0, 12)}
                      </span>
                      <span className="flex items-center gap-1 text-2xs text-text-muted">
                        <MessageSquare size={10} />
                        {s.message_count}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-2xs text-text-muted">
                      <span className="flex items-center gap-1">
                        <Clock size={10} />
                        {formatTime(s.last_active)}
                      </span>
                      <span>{formatTokens(s.total_tokens)} tok</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header with sidebar toggle + status */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
              aria-label="Open sessions"
            >
              <ChevronRight size={16} />
            </button>
          )}
          <div className="flex items-center gap-2">
            <MessageSquare size={16} className="text-accent" />
            <span className="text-sm font-semibold text-text">Chat</span>
          </div>
          <div className="ml-auto flex items-center gap-3 text-2xs text-text-muted">
            <span className="flex items-center gap-1">
              <Activity size={12} />
              {messages.length} msgs
            </span>
          </div>
        </div>

        {/* Messages */}
        <div
          ref={scroller}
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
        >
          {messages.length === 0 && (
            <p className="m-auto text-sm text-text-muted">Start chatting (press 2 to focus).</p>
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
                    {msg.role === 'assistant' ? 'OpenClaw' : 'You'}
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
                Thinking...
              </div>
            </ShimmerCard>
          )}
        </div>

        {/* Input bar */}
        <div className="flex gap-2 border-t border-border p-3 sm:gap-3">
          <button
            type="button"
            className="focus-ring hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-text-secondary transition hover:text-text sm:flex"
            aria-label="Attach"
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
            placeholder="Type a message..."
            className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-bg px-4 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
            aria-label="Message input"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || !input.trim()}
            className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-white transition hover:bg-accent-hover disabled:opacity-50 sm:w-auto sm:px-5"
            aria-label="Send"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}
