import { useState, useRef, useEffect } from 'react'
import { Sparkles, Send, TrendingUp, Cpu, Search as SearchIcon, ArrowRight, Bot, User, Square, ChevronDown } from 'lucide-react'
import { endpoints, HttpError } from '@/lib/api'
import { Button, LoadingDots } from '@/components/ui'
import PipelineIndicator from '@/components/PipelineIndicator'
import TracePanel from '@/components/TracePanel'
import IntroOutline from '@/components/intro/IntroOutline'
import { useIntro } from '@/components/intro/useIntro'
import type { ChatStreamEvent } from '@/lib/api'

interface ModelOption { id: string; label: string }

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  error?: boolean
}

const suggestions = [
  { label: '深度研究', icon: TrendingUp, query: '帮我深入研究一个技术主题' },
  { label: '代码审查', icon: Cpu, query: '审查以下代码是否有问题' },
  { label: '知识问答', icon: SearchIcon, query: '解释一下什么是确定性记忆引擎' },
  { label: '创意写作', icon: Sparkles, query: '写一篇关于AI未来的短文' },
]

function nextId(): string { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36) }

const MODELS: ModelOption[] = [
  { id: 'glm-4-flash-zhipu', label: 'GLM-4-Flash (智谱)' },
  { id: 'glm-4.7-flash-free', label: 'GLM-4.7-Flash (免费)' },
]

export default function Home() {
  const { showIntro, finish, skip } = useIntro()
  const [input, setInput] = useState('')
  const [selectedModel, setSelectedModel] = useState(MODELS[0].id)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [sending, setSending] = useState(false)
  const [pipelineActive, setPipelineActive] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const hasMessages = messages.length > 0

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [messages])

  useEffect(() => {
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
    }
  }, [input])

  const append = (role: 'user' | 'assistant', content: string, opts?: Partial<Message>) => {
    setMessages((prev) => [...prev, { id: nextId(), role, content, ...opts }])
  }

  const appendError = (msg: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.role === 'assistant' && last.streaming) {
        return [...prev.slice(0, -1), { ...last, content: msg, streaming: false, error: true }]
      }
      return [...prev, { id: nextId(), role: 'assistant', content: msg, error: true }]
    })
  }

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    append('user', text)
    append('assistant', '', { streaming: true })
    setSending(true)
    setPipelineActive(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await endpoints.chat.stream(
        [{ role: 'user', content: text }],
        (event: ChatStreamEvent) => {
          if (event.type === 'token') {
            setMessages((prev) => {
              const last = prev[prev.length - 1]
              if (last && last.role === 'assistant' && last.streaming) {
                return [...prev.slice(0, -1), { ...last, content: last.content + event.content }]
              }
              return prev
            })
          } else if (event.type === 'error') {
            appendError(event.message ?? 'stream error')
          }
        },
        { signal: controller.signal, model: selectedModel },
      )
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return
      appendError(e instanceof HttpError ? e.message : String((e as Error)?.message ?? e))
    } finally {
      setSending(false)
      setPipelineActive(false)
      abortRef.current = null
    }
  }

  const stop = () => abortRef.current?.abort()

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  // 开场动画：首访先勾勒线框，结束后卸载覆盖层、挂载真实内容
  // （内容挂载时现有的 fade-in / stagger CSS 类即完成依次上浮入场）
  if (showIntro) {
    return <IntroOutline onDone={finish} onSkip={skip} />
  }

  return (
    <div className="fade-in mx-auto flex h-full w-full max-w-2xl flex-col px-4">
      {!hasMessages ? (
        <>
          <div className="flex-1" />
          <div className="text-center">
            <h1 className="font-display text-3xl font-bold tracking-tight text-[var(--text)] sm:text-4xl">
              有什么可以帮助你的？
            </h1>
            <p className="mt-2 text-base text-[var(--text-secondary)]">知识管理、代码分析、深度研究 — 尽在 Axiom</p>
          </div>
          <div className="stagger mt-8 grid grid-cols-2 gap-3">
            {suggestions.map((s) => {
              const Icon = s.icon
              return (
                <button key={s.label} onClick={() => { setInput(s.query); setTimeout(() => textareaRef.current?.focus(), 100) }}
                  className="group flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-left shadow-[var(--shadow-sm)] transition-all duration-200 hover:border-[var(--accent)] hover:shadow-[var(--shadow-md)]">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] transition-transform group-hover:scale-110">
                    <Icon className="size-6" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-base font-medium text-[var(--text)]">{s.label}</p>
                    <p className="mt-0.5 truncate text-sm text-[var(--text-secondary)]">{s.query}</p>
                  </div>
                  <ArrowRight className="size-4 shrink-0 text-[var(--text-muted)] opacity-0 transition-all group-hover:opacity-100" />
                </button>
              )
            })}
          </div>
          <div className="flex-1" />
        </>
      ) : (
        <div ref={scroller} className="stagger flex-1 space-y-4 overflow-y-auto py-4">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex items-start gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${msg.role === 'user' ? 'bg-[var(--surface-hover)] text-[var(--text-secondary)]' : 'bg-[var(--accent-soft)] text-[var(--accent)]'}`}>
                {msg.role === 'user' ? <User size={18} /> : <Bot size={18} />}
              </div>
              <div className={`min-w-0 max-w-[85%] rounded-2xl px-5 py-3 ${msg.role === 'user' ? 'bg-[var(--accent)] text-white' : 'border border-[var(--border)] bg-[var(--surface)]'}`}>
                {msg.streaming && !msg.content ? (
                  <LoadingDots size="md" />
                ) : (
                  <p className={`whitespace-pre-wrap break-words text-lg leading-relaxed ${msg.error ? 'text-[var(--danger)]' : msg.role === 'user' ? 'text-white' : 'text-[var(--text)]'}`}>
                    {msg.content}
                  </p>
                )}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={stop} icon={<Square size={14} />}>
                停止生成
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Agent interaction trace */}
      <TracePanel active={pipelineActive} />

      {/* Input — bottom, auto-expanding textarea */}
      <div className="pb-2 pt-2">
        <PipelineIndicator active={pipelineActive} />
        <form onSubmit={(e) => { e.preventDefault(); send() }}
          className="relative flex items-end gap-1 rounded-[16px] border border-[var(--border)] bg-[var(--surface)] pl-1 pr-2 transition-all duration-200 focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_1px_var(--accent)]">
          <div className="relative shrink-0 self-center">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setShowModelPicker(!showModelPicker)}
              icon={<Sparkles className="size-4 text-[var(--accent)]" />}
              iconRight={<ChevronDown className="size-3" />}
            >
              <span className="hidden sm:inline">{MODELS.find((m) => m.id === selectedModel)?.label ?? selectedModel}</span>
            </Button>
            {showModelPicker && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowModelPicker(false)} aria-hidden="true" />
                <div className="absolute bottom-full left-0 z-50 mb-1 min-w-[180px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg">
                  {MODELS.map((m) => (
                    <button key={m.id} type="button" onClick={() => { setSelectedModel(m.id); setShowModelPicker(false) }}
                      className={`w-full px-3 py-2.5 text-left text-sm transition-colors ${selectedModel === m.id ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]'}`}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <textarea
            ref={textareaRef}
            id="home-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={hasMessages ? '继续提问…' : '输入你的问题…'}
            rows={1}
            className="min-h-[44px] max-h-[200px] min-w-0 flex-1 resize-none border-0 bg-transparent px-3 py-3 text-lg text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] overflow-y-auto"
            disabled={sending}
          />
          <Button
            type="submit"
            size="icon"
            disabled={!input.trim() || sending}
            className="shrink-0 self-center rounded-xl"
            aria-label="发送"
            icon={<Send className="size-4" />}
          />
        </form>
        {!hasMessages && (
          <p className="pt-1 text-center text-sm text-[var(--text-muted)]">Axiom 可能产生不准确的信息，请核实重要信息。</p>
        )}
      </div>
    </div>
  )
}
