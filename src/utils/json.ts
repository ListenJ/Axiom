/**
 * JSON 工具函数 — 消除重复的 safeJsonParse
 */

/**
 * 安全解析 JSON 字符串，失败时返回 fallback
 */
export function safeJsonParse<T>(str: string | undefined | null, fallback: T): T {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}
