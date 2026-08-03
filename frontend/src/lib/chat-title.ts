/**
 * Chat conversation title helpers.
 *
 * 纯函数 + localStorage 持久化：首次用户消息自动生成标题，
 * 也允许用户在画布左上角手动改名；标题按 session id 存储。
 */

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

/** 保存会话标题；无 session 或空标题时忽略。 */
export function saveChatTitle(sessionId: string | null | undefined, title: string): void {
  if (!sessionId || !title.trim()) return
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_PREFIX + sessionId, title.trim())
}
