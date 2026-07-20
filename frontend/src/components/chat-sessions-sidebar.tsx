/**
 * Chat 会话侧边栏组件
 *
 * 从 pages/Chat.tsx 拆分出来，以满足"页面 < 600 行"的架构约束。
 * 显示历史会话列表，支持新建会话、选择会话、关闭侧边栏。
 */
import { Plus, ChevronLeft, MessageSquare, Clock } from 'lucide-react'
import { formatTime, formatTokens } from './chat-utils'

export interface ChatSession {
  session_id: string
  message_count: number
  total_tokens: number
  last_active: number
}

export interface ChatSessionsSidebarProps {
  sessions: ChatSession[]
  activeSession: string | null
  sidebarOpen: boolean
  onSelect: (sessionId: string) => void
  onNewChat: () => void
  onClose: () => void
}

/** 会话侧边栏——宽度由 sidebarOpen 控制通过 transition 平滑展开/收起。 */
export function ChatSessionsSidebar({
  sessions,
  activeSession,
  sidebarOpen,
  onSelect,
  onNewChat,
  onClose,
}: ChatSessionsSidebarProps) {
  return (
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
              onClick={onNewChat}
              className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
              title="New chat"
              aria-label="New chat"
            >
              <Plus size={14} />
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
              aria-label="Close sidebar"
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
                  onClick={() => onSelect(s.session_id)}
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
  )
}