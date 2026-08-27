/**
 * vault 边缘辅助 —— 文档/记忆管理的轻量 LLM 增强
 *
 * 三个能力（全部可空返回：null = 边缘不可用，调用方回退规则路径）：
 *   1. judgeSignificanceWithEdge — MemoryGate 灰区显著性裁决
 *   2. generateTitleWithEdge     — 语义化笔记标题（替代 40 字符截断）
 *   3. generateTagsWithEdge      — 2-5 个检索标签
 *
 * 开关：EDGE_MEMORY_ASSIST=0 全部禁用（默认启用）。
 */

import { getEdgeClient, isEdgeEnabled, extractJson } from "../local-llm/edge-client.js";
import type { LLMClient } from "../dre/llm/client.js";
import { logger } from "../utils/logger.js";

type GenerateClient = Pick<LLMClient, "generate">;

/** 输入截断上限（辅助判断不需要全量内容） */
const MAX_INPUT_CHARS = 1500;

function truncate(s: string): string {
  return s.length > MAX_INPUT_CHARS ? s.slice(0, MAX_INPUT_CHARS) : s;
}

/**
 * 灰区显著性裁决：该问答是否值得写入记忆库。
 * @returns { worth, reason } | null（null = 不可用/输出非法）
 */
export async function judgeSignificanceWithEdge(
  userMessage: string,
  response: string,
  client?: GenerateClient,
): Promise<{ worth: boolean; reason?: string } | null> {
  if (!isEdgeEnabled("EDGE_MEMORY_ASSIST")) return null;

  try {
    const llm = client ?? getEdgeClient();
    const resp = await llm.generate(
      `判断以下问答是否包含值得长期记忆的信息（可复用的方案/配置/决策/事实，而非闲聊客套）。用户：【${truncate(userMessage)}】回答：【${truncate(response)}】只回答JSON {"worth": true或false, "reason": "<=15字"}`,
      { maxTokens: 60, answerPrefix: '{"worth":' },
    );
    const parsed = extractJson<{ worth?: unknown; reason?: unknown }>(resp.content ?? "");
    if (parsed && typeof parsed.worth === "boolean") {
      return {
        worth: parsed.worth,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      };
    }
    return null;
  } catch (err) {
    logger.debug("[EdgeAssist] significance judge failed", { error: (err as Error).message });
    return null;
  }
}

/**
 * 生成语义化笔记标题（≤60 字符）。
 * @returns 标题 | null
 */
export async function generateTitleWithEdge(
  content: string,
  client?: GenerateClient,
): Promise<string | null> {
  if (!isEdgeEnabled("EDGE_MEMORY_ASSIST")) return null;

  try {
    const llm = client ?? getEdgeClient();
    const resp = await llm.generate(
      `为以下内容生成一个简短标题（不超过20字，只输出标题本身）：【${truncate(content)}】`,
      { maxTokens: 40 },
    );
    const title = (resp.content ?? "").trim().replace(/[\r\n].*$/, "").trim();
    if (title.length < 2) return null;
    return title.length > 60 ? title.slice(0, 60) : title;
  } catch (err) {
    logger.debug("[EdgeAssist] title generation failed", { error: (err as Error).message });
    return null;
  }
}

/**
 * 生成 2-5 个检索标签。
 * @returns 标签数组 | null
 */
export async function generateTagsWithEdge(
  content: string,
  client?: GenerateClient,
): Promise<string[] | null> {
  if (!isEdgeEnabled("EDGE_MEMORY_ASSIST")) return null;

  try {
    const llm = client ?? getEdgeClient();
    const resp = await llm.generate(
      `为以下内容生成 2-5 个检索标签（简短关键词）。内容：【${truncate(content)}】只回答JSON {"tags": ["标签1", "标签2"]}`,
      { maxTokens: 60, answerPrefix: '{"tags":["' },
    );
    const parsed = extractJson<{ tags?: unknown }>(resp.content ?? "");
    if (parsed && Array.isArray(parsed.tags)) {
      const tags = parsed.tags
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim())
        .slice(0, 5);
      return tags.length > 0 ? tags : null;
    }
    return null;
  } catch (err) {
    logger.debug("[EdgeAssist] tags generation failed", { error: (err as Error).message });
    return null;
  }
}
