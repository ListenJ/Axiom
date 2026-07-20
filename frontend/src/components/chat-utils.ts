/**
 * Chat 工具函数与常量
 *
 * 从 pages/Chat.tsx 提取的纯函数，便于复用并控制页面文件行数。
 * 包含：
 *  - nextId / formatTime / formatTokens / extractTotalTokens：UI 展示辅助
 *  - EXAMPLE_PROMPTS：空状态示例提问
 *  - toChatMessages：将内部 Message[] 转为 API ChatMessage[]
 *  - copyToClipboard：跨浏览器兼容的复制实现
 */
import type { Message } from './chat-panels'

/** 生成短随机 ID（用于消息标识）。结合 Math.random 与 Date.now，碰撞概率极低。 */
export function nextId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/** 格式化时间戳（秒级 epoch）为相对时间（now / 5m / 3h / 日期）。 */
export function formatTime(epoch: number): string {
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

/** 格式化 token 数为紧凑表示（1.2K / 3.4M）。 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
  return String(tokens)
}

/** 从 OpenAI 风格 usage 对象中提取总 token 数（若有）。
 *  优先取 total_tokens；否则回退到 prompt_tokens + completion_tokens。
 */
export function extractTotalTokens(usage: Record<string, unknown> | undefined): number | null {
  if (!usage) return null
  const total = usage.total_tokens
  if (typeof total === 'number') return total
  const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const completion = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
  return prompt + completion > 0 ? prompt + completion : null
}

/** 空状态示例提问——点击即发送，降低首问门槛。 */
export const EXAMPLE_PROMPTS = [
  '帮我分析这段代码的性能瓶颈',
  '总结今天的工作进展',
  '查找关于 React Server Components 的资料',
  '生成一个 TypeScript 工具函数',
] as const

/** 将内部 Message[] 转为 API 所需的 { role, content }[] 格式。
 *  过滤掉错误消息和空内容消息，避免污染上下文。
 */
export function toChatMessages(messages: Message[]): Array<{ role: string; content: string }> {
  return messages
    .filter((m) => !m.error && m.content.trim() !== '')
    .map((m) => ({ role: m.role, content: m.content }))
}

/** 跨浏览器兼容的复制到剪贴板。
 *  优先使用 navigator.clipboard（HTTPS / localhost），失败时回退到 execCommand。
 *  返回是否复制成功。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // 现代 API：Clipboard API（要求 secure context）
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 权限拒绝或非 secure context — 回退到 execCommand
    }
  }
  // 回退：临时 textarea + execCommand（兼容旧浏览器 / 非 HTTPS 环境）
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}