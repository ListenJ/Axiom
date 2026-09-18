/**
 * 宽容 JSON 提取（纯函数，叶子层）。
 * 原位于 src/local-llm/edge-client.ts；2026-08-29 迁至 utils 以消除
 * services->local-llm 架构边（P0-A chat-preflight 注入化），edge-client 经
 * re-export 保持既有调用方（risk-monitor 等）兼容。
 */

export function extractJson<T = Record<string, unknown>>(content: string): T | null {
  let text = content.trim();

  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    // 不是纯 JSON, 尝试提取首个对象
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      // 提取后仍解析失败
    }
  }

  return null;
}
