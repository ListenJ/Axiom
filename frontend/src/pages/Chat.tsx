import { useEffect, useRef, useState, useCallback } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import {
  MessageSquare,
  ChevronDown, Code2,
  Brain, FileEdit, ShieldCheck,
  ArrowDown, Activity,
  PanelRight, TerminalSquare, FileText,
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
import {
  nextId,
  toChatMessages,
  copyToClipboard,
} from '@/components/chat-utils'
import {
  ChatComposer,
  type ChatAttachment,
  type PermissionLevel,
} from '@/components/chat/ChatComposer'
import { IdeOpenMenu } from '@/components/chat/IdeOpenMenu'
import WelcomePanel from '@/components/chat/WelcomePanel'
import { type ModelOption, type ReasoningEffort } from '@/components/chat/ModelPicker'
import RightToolbar from '@/components/rightbar/RightToolbar'
import { endpoints, HttpError, type ChatMessage, type ChatStreamEvent } from '@/lib/api'
import { generateChatTitle, loadChatTitle, saveChatTitle } from '@/lib/chat-title'
import { openWorkspaceIn, type OpenTarget } from '@/lib/open-in'
import { useApp } from '@/state/useApp'
import { useChatPrefs } from '@/state/useChatPrefs'

/** 模型列表回退（后端 /models 不可用时的本地兜底） */
const FALLBACK_MODELS: ModelOption[] = [
  { id: 'glm-4-flash-zhipu', name: 'GLM-4-Flash (智谱)', provider: 'zhipu' },
  { id: 'glm-4.7-flash-free', name: 'GLM-4.7-Flash (免费)', provider: 'zhipu' },
]

/** 画布工具栏图标按钮通用样式（原生 button，避免与 Button size 类冲突） */
const canvasIconBtn =
  'press flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--canvas-hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]'

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
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [sending, setSending] = useState(false)
  const [models, setModels] = useState<ModelOption[]>(FALLBACK_MODELS)
  const [selectedModel, setSelectedModel] = useState(FALLBACK_MODELS[0]!.id)
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium')
  const scroller = useRef<HTMLDivElement | null>(null)
  const toast = useApp((s) => s.toast)
  const openRightTool = useApp((s) => s.openRightTool)
  const setTerminalOpen = useApp((s) => s.setTerminalOpen)
  const rightbarOpen = useApp((s) => s.rightbarOpen)
  const setRightbarOpen = useApp((s) => s.setRightbarOpen)
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
  const permissionLevel = useChatPrefs((s) => s.permissionLevel)
  const expandToolCalls = useChatPrefs((s) => s.expandToolCalls)
  const toggleShowThinking = useChatPrefs((s) => s.toggleShowThinking)
  const toggleExpandFileChanges = useChatPrefs((s) => s.toggleExpandFileChanges)
  const setPermissionLevel = useChatPrefs((s) => s.setPermissionLevel)

  // 权限模式：与后端 /permissions/mode 同步
  const [serverAutoAccept, setServerAutoAccept] = useState(false)
  useEffect(() => {
    endpoints.permissions
      .getMode()
      .then((d) => setServerAutoAccept(!!(d as { autoAccept?: boolean })?.autoAccept))
      .catch(() => {})
  }, [])
  // 三级权限切换：自动 => 后端 autoAccept=true；询问/只读 => false。失败回滚
  const handlePermissionLevel = useCallback(
    (level: PermissionLevel) => {
      const nextAuto = level === 'auto'
      if (nextAuto === autoAcceptPermissions && permissionLevel === level) return
      const prevLevel = permissionLevel
      const prevAuto = autoAcceptPermissions
      setPermissionLevel(level)
      endpoints.permissions
        .setMode(nextAuto)
        .then(() => {
          setServerAutoAccept(nextAuto)
          toast(
            `权限等级：${level === 'auto' ? '自动接收（低风险）' : level === 'ask' ? '手动确认' : '只读（不执行写操作）'}`,
            'info',
          )
        })
        .catch(() => {
          // 后端同步失败时回滚本地状态
          setPermissionLevel(prevLevel)
          setServerAutoAccept(prevAuto)
          toast('权限模式同步后端失败，已回滚', 'error')
        })
    },
    [autoAcceptPermissions, permissionLevel, setPermissionLevel, toast],
  )

  // 当前会话（由外壳侧栏会话浮层经 ?session= 切换，或新对话为 null）
  const [activeSession, setActiveSession] = useState<string | null>(null)

  // 画布工具栏：会话题目（自动生成 + 手动改名，按 session 持久化）
  const [chatTitle, setChatTitle] = useState('新对话')
  // 画布工具栏：IDE 打开下拉（VS Code / Cursor / 文件管理器）
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [openMenu, setOpenMenu] = useState<'ide' | null>(null)
  const ideRef = useRef<HTMLDivElement | null>(null)

  // 会话切换时载入对应标题
  useEffect(() => {
    setChatTitle(loadChatTitle(activeSession) ?? '新对话')
  }, [activeSession])

  // 读取当前工作区绝对路径（供 IDE/文件管理器协议使用）
  useEffect(() => {
    endpoints.workspaces
      .list()
      .then((d) => {
        const ws = (d as { workspaces?: Array<{ path?: string }> } | null)?.workspaces?.[0]
        if (ws?.path) setWorkspacePath(ws.path)
      })
      .catch(() => {})
  }, [])

  // 点击画布其他区域时收起 IDE 下拉
  useEffect(() => {
    if (!openMenu) return
    const onDown = (e: MouseEvent) => {
      if (ideRef.current && !ideRef.current.contains(e.target as Node)) setOpenMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [openMenu])

  const commitChatTitle = () => {
    const t = chatTitle.trim()
    if (!t) {
      setChatTitle(loadChatTitle(activeSession) ?? '新对话')
      return
    }
    setChatTitle(t)
    saveChatTitle(activeSession, t)
  }

  const openIn = (target: OpenTarget) => {
    setOpenMenu(null)
    if (!workspacePath) {
      toast('未获取到工作区路径，请稍候重试', 'warning')
      return
    }
    openWorkspaceIn(target, workspacePath)
  }

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

  // 左栏工作区会话浮层跳转：/chat?session=<id> 到达后自动加载对应会话
  useEffect(() => {
    const sessionId = searchParams.get('session')
    if (!sessionId) return
    void loadSession(sessionId)
    setSearchParams({}, { replace: true })
    // 仅在 query 变化时触发；setSearchParams 清空后 effect 不会再重复执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])
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
    if ((!msg && attachments.length === 0) || sending) return
    // 附件以 [附件] 行并入消息正文，作为文本上下文传给后端
    const attachmentNote = attachments
      .map((a) => `[附件] ${a.name}`)
      .join('\n')
    const payload = [attachmentNote, msg].filter(Boolean).join('\n\n')
    // 首条用户消息自动生成会话题目（已有 session 时同步持久化）
    const firstTurnTitle = messages.length === 0
      ? generateChatTitle(msg || attachments.map((a) => a.name).join('、'))
      : null
    if (firstTurnTitle) {
      setChatTitle(firstTurnTitle)
      saveChatTitle(activeSession, firstTurnTitle)
    }
    const userMsg: Message = { id: nextId(), role: 'user', content: payload }
    const assistantId = nextId()
    setMessages((m) => [...m, userMsg, { id: assistantId, role: 'assistant', content: '', streaming: true }])
    setInput('')
    setAttachments([])
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
        { role: 'user', content: payload },
      ]
      await endpoints.chat.stream(
        streamMessages,
        (event: ChatStreamEvent) => {
          switch (event.type) {
            case 'start':
              updateMeta({ model: event.model, provider: event.provider })
              if (event.sessionId) {
                setActiveSession(event.sessionId)
                if (firstTurnTitle) saveChatTitle(event.sessionId, firstTurnTitle)
              }
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
        { signal: controller.signal, model: selectedModel, reasoningEffort, sessionId: activeSession ?? undefined },
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

  // 编辑用户消息：截断该消息及其后全部内容，用新文本重新发送
  const editAndResend = (userMsgId: string, newText: string) => {
    if (sending) return
    const text = newText.trim()
    if (!text) return
    const idx = messages.findIndex((m) => m.id === userMsgId)
    if (idx < 0) return
    setMessages((m) => m.slice(0, idx))
    void send(text)
  }

  // 重新生成：截断该助手消息及其后全部内容，重发其前一条用户消息
  const regenerate = (assistantMsgId: string) => {
    if (sending) return
    const idx = messages.findIndex((m) => m.id === assistantMsgId)
    if (idx < 1) return
    let userIdx = idx - 1
    while (userIdx >= 0 && messages[userIdx].role !== 'user') userIdx--
    if (userIdx < 0) return
    const userText = messages[userIdx].content
    setMessages((m) => m.slice(0, userIdx))
    void send(userText)
  }

  return (
    <div className="relative flex h-full gap-0">
      {/* Main Chat Area */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Scroll container — sub-header and input bar are sticky inside for glass overlay effect */}
        <div
          ref={scroller}
          onScroll={handleScroll}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
        {/* 画布工具栏：行1 = 会话题目 + IDE/摘要/终端/工具台，行2 = 页签 + 功能开关 — sticky glass */}
        <div className="sticky top-0 z-20 flex flex-col gap-2 px-3 py-2 sm:px-4">
          <div className="flex items-center gap-2">
            <MessageSquare size={16} className="shrink-0 text-[var(--accent)]" />
            <input
              value={chatTitle}
              onChange={(e) => setChatTitle(e.target.value)}
              onBlur={commitChatTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              aria-label="会话题目"
              title="点击可重命名会话"
              className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-1.5 text-sm font-semibold text-[var(--text)] outline-none transition-colors hover:bg-[var(--canvas-hover)] focus:bg-[var(--surface)] focus:ring-1 focus:ring-[var(--accent)] sm:max-w-72"
            />
            {activeSession && (
              <span className="hidden shrink-0 text-2xs text-[var(--text-muted)] md:inline">
                ({activeSession.slice(0, 8)})
              </span>
            )}

            <div className="ml-auto flex items-center gap-1">
              {/* 用 IDE / 文件管理器打开当前工作区 */}
              <div className="relative" ref={ideRef}>
                <button
                  type="button"
                  onClick={() => setOpenMenu(openMenu === 'ide' ? null : 'ide')}
                  aria-label="打开工作区"
                  title="在外部工具中打开工作区"
                  className="press flex h-8 shrink-0 items-center gap-0.5 rounded-lg px-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--canvas-hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  <Code2 size={16} />
                  <ChevronDown size={12} />
                </button>
                {openMenu === 'ide' && <IdeOpenMenu open onOpen={openIn} />}
              </div>
              <button
                type="button"
                onClick={() => openRightTool('summary')}
                aria-label="打开摘要"
                title="工作摘要"
                className={canvasIconBtn}
              >
                <FileText size={16} />
              </button>
              <button
                type="button"
                onClick={() => setTerminalOpen(true)}
                aria-label="打开终端"
                title="唤出终端（Ctrl+`）"
                className={canvasIconBtn}
              >
                <TerminalSquare size={16} />
              </button>
              <button
                type="button"
                onClick={() => setRightbarOpen(!rightbarOpen)}
                aria-label="工具台"
                title={rightbarOpen ? '收起右侧工具台' : '唤出右侧工具台'}
                className={`${canvasIconBtn} ${rightbarOpen ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : ''}`}
              >
                <PanelRight size={16} />
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Hub 页签：对话 / 使用统计（?tab=chat|usage 同步，默认对话） */}
            <Tabs
              tabs={hubTabs}
              active={activeTab}
              onChange={setActiveTab}
              size="sm"
            />

            {/* 可配置功能切换（权限等级已移入输入框三级选择器） */}
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
            </div>
            )}
          </div>
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
          className={`stagger flex flex-col gap-3 p-4 ${messages.length === 0 ? 'min-h-full justify-center' : ''}`}
        >
          {messages.length === 0 && (
            <WelcomePanel
              onSuggestion={(query) => {
                setInput(query)
                void send(query)
              }}
            />
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
              onEdit={editAndResend}
              onRegenerate={regenerate}
            />
          ))}
        </div>

        {/* Input bar — sticky glass, content scrolls underneath */}
        <ChatComposer
          value={input}
          onChange={setInput}
          sending={sending}
          disabled={!input.trim() && attachments.length === 0}
          models={models}
          selectedModel={selectedModel}
          reasoningEffort={reasoningEffort}
          onModelSelect={(modelId, effort) => {
            if (modelId) setSelectedModel(modelId)
            if (effort) setReasoningEffort(effort)
          }}
          onSend={() => void send()}
          onStop={stop}
          attachments={attachments}
          onAttach={(files) => {
            const list = Array.from(files)
            const next = list.map((f) => ({
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name: f.name,
              size: f.size,
              kind: (f.type.startsWith('image/') ? 'image' : 'file') as ChatAttachment['kind'],
            }))
            setAttachments((prev) => [...prev, ...next])
          }}
          onRemoveAttachment={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
          permissionLevel={permissionLevel}
          onPermissionLevelChange={handlePermissionLevel}
        />
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

      {/* 右侧工具台：仅聊天页挂载，与聊天画布并排同属画布层（移动端抽屉由内部处理） */}
      <RightToolbar />
    </div>
  )
}
