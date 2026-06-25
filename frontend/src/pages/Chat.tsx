import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Send, Paperclip, Bot, User, MessageSquare } from 'lucide-react'
import {
  ShimmerCard,
  Button,
  PageHeader,
  InlineEmptyState,
  LoadingDots,
  Input,
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
  const abortRef = useRef<AbortController | null>(null)

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
        // history endpoint may be unavailable
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
                content: item.content ? `${item.content}\n[错误] ${text}` : `[错误] ${text}`,
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
              // No rendering needed; placeholder already shown.
              break
            case 'token':
              appendToken(event.content)
              break
            case 'done':
              clearStreaming()
              break
            case 'error':
              appendError(event.message ?? event.content ?? 'stream error')
              toast('流式响应出错：' + (event.message ?? '未知错误'), 'error')
              break
          }
        },
        { signal: controller.signal },
      )
    } catch (e) {
      const errMsg = e instanceof HttpError ? e.message : String((e as Error)?.message ?? e)
      appendError(errMsg)
      toast('发送失败：' + errMsg, 'error')
    } finally {
      setSending(false)
      abortRef.current = null
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 fade-in">
      <PageHeader
        icon={<MessageSquare className="size-5" />}
        title="对话"
      />

      <div
        ref={scroller}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        {messages.length === 0 && (
          <InlineEmptyState
            icon={<MessageSquare className="size-5" />}
            title="开始对话吧"
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
                    {isUser ? '你' : 'OpenClaw'}
                  </p>
                  {msg.streaming && msg.content === '' ? (
                    <div className="mt-1 flex items-center gap-2 text-sm text-[var(--text-muted)]">
                      <LoadingDots size="sm" />
                      <span>思考中…</span>
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

      <div className="flex gap-2 sm:gap-3">
        <Button
          type="button"
          size="icon"
          variant="secondary"
          aria-label="附件"
          className="hidden h-11 w-11 shrink-0 sm:flex"
          icon={<Paperclip size={18} />}
        />
        <Input
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
          aria-label="消息输入"
          className="h-11 min-w-0 flex-1"
        />
        <Button
          onClick={() => void send()}
          loading={sending}
          disabled={!input.trim()}
          icon={<Send size={18} />}
        >
          <span className="hidden sm:inline">发送</span>
        </Button>
      </div>
    </div>
  )
}
