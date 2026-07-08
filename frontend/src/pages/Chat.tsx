import { useEffect, useRef, useState, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import {
  Send, Bot, User, MessageSquare,
  Clock, Activity, ChevronLeft, ChevronRight,
  Plus, Square,
} from 'lucide-react'
import {
  ShimmerCard,
  Button,
  InlineEmptyState,
  LoadingDots,
} from '@/components/ui'
import { endpoints, HttpError, type ChatMessage, type ChatStreamEvent } from '@/lib/api'
import { useApp } from '@/state/useApp'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  error?: boolean
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
  if (diffMin < 1) return 'now'
  if (diffMin < 60) return `${diffMin}m`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h`
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
  const abortRef = useRef<AbortController | null>(null)

  // Sessions sidebar
  const [sessions, setSessions] = useState<Session[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [activeSession, setActiveSession] = useState<string | null>(null)

  const loadSessions = useCallback(() => {
    endpoints.memory
      .sessions()
      .then((d) => {
        const data = d as { sessions: Session[] }
        if (Array.isArray(data.sessions)) {
          setSessions(data.sessions.sort((a, b) => b.last_active - a.last_active))
        }
      })
      .catch(() => {})
  }, [])

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
    loadSessions()
  }, [loadSessions])

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

  // Refresh sessions when messages change
  useEffect(() => {
    if (messages.length > 0) loadSessions()
  }, [messages.length, loadSessions])

  const newChat = () => {
    setMessages([])
    setActiveSession(null)
    setInput('')
  }

  const loadSession = async (sessionId: string) => {
    setActiveSession(sessionId)
    try {
      const data = (await endpoints.memory.conversations(sessionId)) as { messages: Array<{ role: string; content: string }> }
      if (Array.isArray(data.messages)) {
        setMessages(
          data.messages.map((m) => ({
            id: nextId(),
            role: m.role === 'user' ? 'user' : 'assistant',
            content: String(m.content ?? ''),
          })),
        )
      }
    } catch {
      toast('Failed to load session', 'error')
    }
  }

  const send = async (text?: string) => {
    const msg = (text ?? input).trim()
    if (!msg || sending) return
    const userMsg: Message = { id: nextId(), role: 'user', content: msg }
    const assistantId = nextId()
    setMessages((m) => [...m, userMsg, { id: assistantId, role: 'assistant', content: '', streaming: true }])
    setInput('')
    setSending(true)

    const appendToken = (chunk: string) => {
      setMessages((m) =>
        m.map((item) =>
          item.id === assistantId ? { ...item, content: item.content + chunk } : item,
        ),
      )
    }
    const clearStreaming = () => {
      setMessages((m) =>
        m.map((item) =>
          item.id === assistantId ? { ...item, streaming: false } : item,
        ),
      )
    }
    const appendError = (text: string) => {
      setMessages((m) =>
        m.map((item) =>
          item.id === assistantId
            ? {
                ...item,
                streaming: false,
                error: true,
                content: item.content ? `${item.content}\n[Error] ${text}` : `[Error] ${text}`,
              }
            : item,
        ),
      )
    }

    try {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const streamMessages: ChatMessage[] = [{ role: 'user', content: msg }]
      await endpoints.chat.stream(
        streamMessages,
        (event: ChatStreamEvent) => {
          switch (event.type) {
            case 'start':
              break
            case 'token':
              appendToken(event.content)
              break
            case 'done':
              clearStreaming()
              break
            case 'error':
              appendError(event.message ?? event.content ?? 'stream error')
              toast('Stream error: ' + (event.message ?? 'unknown'), 'error')
              break
          }
        },
        { signal: controller.signal },
      )
    } catch (e) {
      const errMsg = e instanceof HttpError ? e.message : String((e as Error)?.message ?? e)
      appendError(errMsg)
      toast('Send failed: ' + errMsg, 'error')
    } finally {
      setSending(false)
      abortRef.current = null
    }
  }

  const stop = () => {
    abortRef.current?.abort()
  }

  return (
    <div className="flex h-full gap-0 fade-in">
      {/* Sessions Sidebar */}
      <div
        className={`${
          sidebarOpen ? 'w-64' : 'w-0'
        } shrink-0 overflow-hidden border-r border-[var(--border)] bg-[var(--surface)] transition-all duration-300`}
      >
        <div className="flex h-full w-64 flex-col">
          <div className="flex items-center justify-between border-b border-[var(--border)] p-3">
            <span className="text-sm font-semibold text-[var(--text)]">Sessions</span>
            <div className="flex gap-1">
              <button
                onClick={newChat}
                className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                title="New chat"
              >
                <Plus size={14} />
              </button>
              <button
                onClick={() => setSidebarOpen(false)}
                className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
              >
                <ChevronLeft size={14} />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {sessions.length === 0 ? (
              <p className="p-4 text-center text-xs text-[var(--text-muted)]">No sessions</p>
            ) : (
              <div className="space-y-1">
                {sessions.map((s) => (
                  <div
                    key={s.session_id}
                    onClick={() => void loadSession(s.session_id)}
                    className={`cursor-pointer rounded-lg p-2.5 transition-colors ${
                      activeSession === s.session_id
                        ? 'bg-[var(--accent-soft)] border border-[var(--accent)]/20'
                        : 'hover:bg-[var(--surface-hover)] border border-transparent'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="truncate text-xs font-medium text-[var(--text)]">
                        {s.session_id.slice(0, 16)}
                      </span>
                      <span className="flex items-center gap-1 text-2xs text-[var(--text-muted)]">
                        <MessageSquare size={10} />
                        {s.message_count}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-2xs text-[var(--text-muted)]">
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
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2">
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
              aria-label="Open sessions"
            >
              <ChevronRight size={16} />
            </button>
          )}
          <MessageSquare size={16} className="text-[var(--accent)]" />
          <span className="text-sm font-semibold text-[var(--text)]">Chat</span>
          {activeSession && (
            <span className="text-2xs text-[var(--text-muted)]">
              ({activeSession.slice(0, 8)})
            </span>
          )}
          <div className="ml-auto flex items-center gap-3 text-2xs text-[var(--text-muted)]">
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
            <InlineEmptyState
              icon={<MessageSquare className="size-5" />}
              title="Start chatting"
            />
          )}
          {messages.map((msg) => {
            const isUser = msg.role === 'user'
            return (
              <ShimmerCard
                key={msg.id}
                variant={isUser ? 'default' : 'accent'}
                className={`max-w-[85%] ${isUser ? 'self-end' : 'self-start'}`}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                      isUser
                        ? 'bg-[var(--surface-hover)] text-[var(--text-secondary)]'
                        : 'bg-[var(--accent-soft)] text-[var(--accent)]'
                    }`}
                  >
                    {isUser ? <User size={16} /> : <Bot size={16} />}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--text-secondary)]">
                      {isUser ? 'You' : 'Axiom'}
                    </p>
                    {msg.streaming && msg.content === '' ? (
                      <div className="mt-1 flex items-center gap-2 text-sm text-[var(--text-muted)]">
                        <LoadingDots size="sm" />
                        <span>Thinking...</span>
                      </div>
                    ) : (
                      <p className={`mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed ${msg.error ? 'text-[var(--danger)]' : 'text-[var(--text)]'}`}>
                        {msg.content}
                      </p>
                    )}
                  </div>
                </div>
              </ShimmerCard>
            )
          })}
        </div>

        {/* Input bar */}
        <div className="flex gap-2 border-t border-[var(--border)] p-3 sm:gap-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder="Type a message..."
            aria-label="Message input"
            rows={1}
            className="h-11 min-w-0 flex-1 resize-none rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
          />
          {sending ? (
            <Button
              type="button"
              onClick={stop}
              variant="secondary"
              aria-label="Stop generating"
              icon={<Square size={18} />}
            >
              <span className="hidden sm:inline">Stop</span>
            </Button>
          ) : (
            <Button
              onClick={() => void send()}
              disabled={!input.trim()}
              icon={<Send size={18} />}
            >
              <span className="hidden sm:inline">Send</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
