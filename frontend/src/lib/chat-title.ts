/**
 * Chat conversation title helpers.
 *
 * 纯函数 + 双层持久化：localStorage 为即时层（同步读），后端 chat_sessions 表为
 * 持久层（异步写，PATCH /chat/sessions/:id）。首次用户消息自动生成标题，
 * 也允许用户在画布左上角手动改名；标题按 session id 存储。
 */
import { endpoints } from './api'

const STORAGE_PREFIX = 'axiom:chat-title:'
const MAX_TITLE_LENGTH = 28

/** 从用户首条消息生成会话标题：压缩空白并截断到 28 字符。 */
export function generateChatTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= MAX_TITLE_LENGTH) return clean
  return `${clean.slice(0, MAX_TITLE_LENGTH).trimEnd()}…`
}

/** 读取指定会话的标题；无 session 或未保存时返回 null。 */
export function loadChatTitle(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(STORAGE_PREFIX + sessionId)
}

/** 保存会话标题；无 session 或空标题时忽略。localStorage 即时写入 + 后端异步持久化。 */
export function saveChatTitle(sessionId: string | null | undefined, title: string): void {
  if (!sessionId || !title.trim()) return
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_PREFIX + sessionId, title.trim())
  }
  // 后端持久化（fire-and-forget；失败不阻塞本地体验，下次写入重试）
  endpoints.chat
    .renameSession(sessionId, title.trim())
    .then(() => {})
    .catch(() => {})
}

/** 列表展示用标题：优先已保存标题，无标题时回退 session id 前 16 字符。 */
export function sessionListTitle(sessionId: string, serverTitle?: string | null): string {
  return loadChatTitle(sessionId) ?? (serverTitle || sessionId.slice(0, 16))
}
