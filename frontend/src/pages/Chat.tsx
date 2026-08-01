import { useEffect, useRef, useState, useCallback } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import {
  Send, MessageSquare,
  ChevronRight,
  Square, Brain, FileEdit, ShieldCheck, ShieldAlert,
  ArrowDown, Sparkles, Activity, TrendingUp, Cpu, Search as SearchIcon,
} from 'lucide-react'
import {
  Button,
  Tabs,
} from '@/components/ui'
import {
  ToggleChip,
  MessageItem,
  UsageStatsPanel,
  parseTokenContent,
  type Message,
} from '@/components/chat-panels'
import { PageTransition } from '@/components/motion'
import {
  nextId,
  toChatMessages,
  copyToClipboard,
} from '@/components/chat-utils'
import { ChatSessionsSidebar, type ChatSession } from '@/components/chat-sessions-sidebar'
import { FisheyeNav } from '@/components/fisheye/FisheyeNav'
import { ModelPicker, type ModelOption, type ReasoningEffort } from '@/components/chat/ModelPicker'
import { endpoints, HttpError, type ChatMessage, type ChatStreamEvent } from '@/lib/api'
import { useApp } from '@/state/useApp'
import { useChatPrefs } from '@/state/useChatPrefs'

/** 首页欢迎建议卡片（与合并后的对话页共用） */
const suggestions = [
  { label: '深度研究', icon: TrendingUp, query: '帮我深入研究一个技术主题' },
  { label: '代码审查', icon: Cpu, query: '审查以下代码是否有问题' },
  { label: '知识问答', icon: SearchIcon, query: '解释一下什么是确定性记忆引擎' },
  { label: '创意写作', icon: Sparkles, query: '写一篇关于AI未来的短文' },
]

/** 模型列表回退（后端 /models 不可用时的本地兜底） */
const FALLBACK_MODELS: ModelOption[] = [
  { id: 'glm-4-flash-zhipu', name: 'GLM-4-Flash (智谱)', provider: 'zhipu' },
  { id: 'glm-4.7-flash-free', name: 'GLM-4.7-Flash (免费)', provider: 'zhipu' },
]

export default function Chat() {
  const location = useLocation()
  const initialMessage = (location.state as { initialMessage?: string } | null)?.initialMessage
  // Hub 页签：对话 / 使用统计（自 Sessions 页并入），通过 ?tab=chat|usage 同步，默认对话
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = searchParams.get('tab') === 'usage' ? 'usage' : 'chat'
  const setActiveTab = (id: string) =>
    setSearchParams(id === 'chat' ? {} : { tab: id }, { replace: true })
  const hubTabs = [
    { id: 'chat' as const, label: '对话', icon: <MessageSquare className="size-3.5" /> },
    { id: 'usage' as const, label: '使用统计', icon: <Activity className="size-3.5" /> },
  ]
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [models, setModels] = useState<ModelOption[]>(FALLBACK_MODELS)
  const [selectedModel, setSelectedModel] = useState(FALLBACK_MODELS[0]!.id)
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium')
  const scroller = useRef<HTMLDivElement | null>(null)
  const toast = useApp((s) => s.toast)
  const abortRef = useRef<AbortController | null>(null)

  // 模型列表：优先拉取后端 /models（含供应商），失败回退本地列表
  useEffect(() => {
    endpoints.models
      .list()
      .then((d) => {
        const list = (d?.models ?? []).filter((m) => m.enabled)
        if (list.length > 0) {
          setModels(list)
          setSelectedModel((cur) => (list.some((m) => m.id === cur) ? cur : list[0]!.id))
        }
      })
      .catch(() => {})
  }, [])

  // 聊天偏好（持久化到 localStorage）
  const showThinking = useChatPrefs((s) => s.showThinking)
  const expandFileChanges = useChatPrefs((s) => s.expandFileChanges)
  const autoAcceptPermissions = useChatPrefs((s) => s.autoAcceptPermissions)
  const expandToolCalls = useChatPrefs((s) => s.expandToolCalls)
  const toggleShowThinking = useChatPrefs((s) => s.toggleShowThinking)
  const toggleExpandFileChanges = useChatPrefs((s) => s.toggleExpandFileChanges)
  const toggleAutoAcceptPermissions = useChatPrefs((s) => s.toggleAutoAcceptPermissions)

  // 权限模式：与后端 /permissions/mode 同步
  const [serverAutoAccept, setServerAutoAccept] = useState(false)
  useEffect(() => {
    endpoints.permissions
      .getMode()
      .then((d) => setServerAutoAccept(!!(d as { autoAccept?: boolean })?.autoAccept))
      .catch(() => {})
  }, [])
  // 当本地切换时，同步到后端
  const handlePermissionToggle = useCallback(() => {
    const next = !autoAcceptPermissions
    toggleAutoAcceptPermissions()
    endpoints.permissions
      .setMode(next)
      .then(() => {
        setServerAutoAccept(next)
        toast(`权限模式：${next ? '自动接收（低风险）' : '手动确认'}`, 'info')
      })
      .catch(() => {
        // 后端同步失败时回滚本地状态
        toggleAutoAcceptPermissions()
        toast('权限模式同步后端失败，已回滚', 'error')
      })
  }, [autoAcceptPermissions, toggleAutoAcceptPermissions, toast])

  // Sessions sidebar
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [activeSession, setActiveSession] = useState<string | null>(null)

  const loadSessions = useCallback(() => {
    endpoints.memory
      .sessions()
      .then((d) => {
        const data = d as { sessions: ChatSession[] }
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

  // 智能滚动：仅当用户已在底部附近时自动滚动，避免打断用户阅读历史
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  const isNearBottomRef = useRef(true)
  const handleScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const threshold = 80 // 距底部 80px 内视为"在底部"
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
    isNearBottomRef.current = near
    setShowJumpToBottom(!near && messages.length > 0)
  }, [messages.length])
  const jumpToBottom = useCallback(() => {
    if (scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight
      isNearBottomRef.current = true
      setShowJumpToBottom(false)
    }
  }, [])

  useEffect(() => {
    if (scroller.current && isNearBottomRef.current) {
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
        m.map((item) => {
          if (item.id !== assistantId) return item
          const { text, msg: updated } = parseTokenContent(chunk, item)
          return { ...updated, content: item.content + text }
        }),
      )
    }
    const updateMeta = (meta: { model?: string; provider?: string; usage?: Record<string, unknown> }) => {
      setMessages((m) =>
        m.map((item) => (item.id === assistantId ? { ...item, meta: { ...item.meta, ...meta } } : item)),
      )
    }
    const clearStreaming = () => {
      setMessages((m) =>
        m.map((item) => {
          if (item.id !== assistantId) return item
          // 流结束但无任何内容（也无思考片段）时，显示友好占位文本
          const isEmpty = item.content.trim() === '' && !item.thinking?.length
          return {
            ...item,
            streaming: false,
            content: isEmpty ? '（未收到响应内容，请重试）' : item.content,
          }
        }),
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
      // 构建完整对话上下文：历史消息 + 当前用户消息（过滤错误/空消息）
      const streamMessages: ChatMessage[] = [
        ...toChatMessages(messages).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        { role: 'user', content: msg },
      ]
      await endpoints.chat.stream(
        streamMessages,
        (event: ChatStreamEvent) => {
          switch (event.type) {
            case 'start':
              updateMeta({ model: event.model, provider: event.provider })
              break
            case 'token':
              appendToken(event.content)
              break
            case 'done':
              if (event.model || event.provider || event.usage) {
                updateMeta({ model: event.model, provider: event.provider, usage: event.usage })
              }
              clearStreaming()
              break
            case 'error':
              appendError(event.message ?? event.content ?? 'stream error')
              toast('Stream error: ' + (event.message ?? 'unknown'), 'error')
              break
          }
        },
        { signal: controller.signal, model: selectedModel, reasoningEffort },
      )
    } catch (e) {
      // 用户主动中止 — 静默停止流式，保留已接收的部分内容
      if ((e as Error)?.name === 'AbortError') {
        clearStreaming()
      } else {
        const errMsg = e instanceof HttpError ? e.message : String((e as Error)?.message ?? e)
        appendError(errMsg)
        toast('发送失败：' + errMsg, 'error')
      }
    } finally {
      setSending(false)
      abortRef.current = null
    }
  }

  const stop = () => {
    abortRef.current?.abort()
  }

  // 复制消息内容到剪贴板（带 2s 的"已复制"反馈）
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const handleCopy = async (messageId: string, content: string) => {
    if (!content.trim()) return
    const ok = await copyToClipboard(content)
    if (ok) {
      setCopiedId(messageId)
      window.setTimeout(() => setCopiedId((cur) => (cur === messageId ? null : cur)), 2000)
      toast('已复制到剪贴板', 'info')
    } else {
      toast('复制失败，请手动选择文本', 'error')
    }
  }

  // 重试失败的回复：定位到错误助手消息前最近的用户消息，
  // 移除该用户消息及其后的所有内容（包括错误消息），然后重新发送。
  const retryFromError = (errorAssistantId: string) => {
    if (sending) return
    const errorIdx = messages.findIndex((m) => m.id === errorAssistantId)
    if (errorIdx < 1) return
    let userIdx = errorIdx - 1
    while (userIdx >= 0 && messages[userIdx].role !== 'user') userIdx--
    if (userIdx < 0) return
    const userText = messages[userIdx].content
    setMessages((m) => m.slice(0, userIdx))
    void send(userText)
  }

  return (
    <PageTransition className="flex h-full gap-0">
      {/* Sessions Sidebar */}
      <ChatSessionsSidebar
        sessions={sessions}
        activeSession={activeSession}
        sidebarOpen={sidebarOpen}
        onSelect={(id) => void loadSession(id)}
        onNewChat={newChat}
        onClose={() => setSidebarOpen(false)}
      />

      {/* 折叠态鱼眼导航：会话侧栏收起时以窄条圆点呈现（hover 高斯展开，点击加载） */}
      {!sidebarOpen && sessions.length > 0 && (
        <FisheyeNav
          sessions={sessions}
          activeSession={activeSession}
          onSelect={(id) => void loadSession(id)}
        />
      )}

      {/* Main Chat Area */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Scroll container — sub-header and input bar are sticky inside for glass overlay effect */}
        <div
          ref={scroller}
          onScroll={handleScroll}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
        {/* Header with three toggle controls + hub 页签 — sticky glass */}
        <div className="sticky top-0 z-20 glass-sm flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2">
          {!sidebarOpen && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open sessions"
              icon={<ChevronRight size={16} />}
            />
          )}
          <MessageSquare size={16} className="text-[var(--accent)]" />
          <span className="text-sm font-semibold text-[var(--text)]">Chat</span>
          {activeSession && (
            <span className="text-2xs text-[var(--text-muted)]">
              ({activeSession.slice(0, 8)})
            </span>
          )}

          {/* Hub 页签：对话 / 使用统计（?tab=chat|usage 同步，默认对话） */}
          <Tabs
            tabs={hubTabs}
            active={activeTab}
            onChange={setActiveTab}
            size="sm"
          />

          {/* 三项可配置功能切换 */}
          {activeTab === 'chat' && (
          <div className="ml-auto flex items-center gap-1.5">
            <ToggleChip
              active={showThinking}
              onClick={toggleShowThinking}
              icon={<Brain size={12} />}
              label="思考"
              title={showThinking ? '显示思考过程（已开启）' : '隐藏思考过程（已关闭）'}
            />
            <ToggleChip
              active={expandFileChanges}
              onClick={toggleExpandFileChanges}
              icon={<FileEdit size={12} />}
              label="文件变更"
              title={expandFileChanges ? '默认展开文件修改明细（已开启）' : '默认折叠文件修改明细（已关闭）'}
            />
            <ToggleChip
              active={autoAcceptPermissions}
              onClick={handlePermissionToggle}
              icon={autoAcceptPermissions ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}
              label={autoAcceptPermissions ? '自动接收' : '手动确认'}
              title={
                autoAcceptPermissions
                  ? '权限模式：自动接收低风险操作（高风险仍需确认）'
                  : '权限模式：所有操作手动确认'
              }
              variant={autoAcceptPermissions ? 'success' : 'default'}
            />
          </div>
          )}
        </div>

        {/* Permission mode banner (visible when auto-accept is on) */}
        {autoAcceptPermissions && (
          <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--success-soft)] px-4 py-1.5 text-2xs text-[var(--success)]">
            <ShieldCheck size={12} />
            <span>权限自动接收已开启 — 低风险操作将自动放行，高风险操作仍需手动确认</span>
            <span className="ml-auto">服务器状态：{serverAutoAccept ? '已同步' : '同步中…'}</span>
          </div>
        )}

        {activeTab === 'usage' ? (
          <UsageStatsPanel />
        ) : (
          <>
        {/* Messages */}
        <div
          className="flex flex-col gap-3 p-4"
        >
          {messages.length === 0 && (
            <div className="m-auto flex w-full max-w-2xl flex-col items-center gap-6 text-center">
              {/* 欢迎标题（首页与对话合并：无消息时即首页） */}
              <div className="fade-in">
                <h1 className="font-display text-3xl font-bold tracking-tight text-[var(--text)] sm:text-4xl">
                  有什么可以帮助你的？
                </h1>
                <p className="mt-2 text-base text-[var(--text-secondary)]">
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
                      onClick={() => { setInput(s.query); void send(s.query) }}
                      className="group flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-left shadow-[var(--shadow-sm)] transition-all duration-200 hover:border-[var(--accent)] hover:shadow-[var(--shadow-md)]"
                    >
                      <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] transition-transform group-hover:scale-110">
                        <Icon className="size-6" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-base font-medium text-[var(--text)]">{s.label}</p>
                        <p className="mt-0.5 truncate text-sm text-[var(--text-secondary)]">{s.query}</p>
                      </div>
                      <Sparkles className="size-4 shrink-0 text-[var(--text-muted)] opacity-0 transition-all group-hover:opacity-100" />
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          {messages.map((msg) => (
            <MessageItem
              key={msg.id}
              msg={msg}
              showThinking={showThinking}
              expandFileChanges={expandFileChanges}
              expandToolCalls={expandToolCalls}
              copiedId={copiedId}
              onCopy={handleCopy}
              onRetry={retryFromError}
            />
          ))}
        </div>

        {/* Input bar — sticky glass, content scrolls underneath */}
        <div className="sticky bottom-0 z-20 glass-sm flex items-end gap-2 border-t border-[var(--border)] p-3 sm:gap-3">
          <textarea
            id="home-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder="输入消息…（Enter 发送 · Shift+Enter 换行）"
            aria-label="消息输入框"
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
          {/* 模型选择圆环（右下角）+ 思考强度弹窗 */}
          <ModelPicker
            models={models}
            selectedModel={selectedModel}
            effort={reasoningEffort}
            onSelect={(modelId, effort) => {
              if (modelId) setSelectedModel(modelId)
              if (effort) setReasoningEffort(effort)
            }}
          />
        </div>
          </>
        )}
        </div>

        {/* 浮动"回到底部"按钮——用户上滑阅读历史时出现（用负边距居中，避免与 framer-motion 的 transform 冲突） */}
        {showJumpToBottom && (
          <Button
            variant="secondary"
            size="icon"
            onClick={jumpToBottom}
            aria-label="回到底部"
            title="回到底部"
            className="absolute bottom-24 left-1/2 z-30 -ml-[22px] rounded-full shadow-lg"
            icon={<ArrowDown size={16} />}
          />
        )}
      </div>
    </PageTransition>
  )
}
