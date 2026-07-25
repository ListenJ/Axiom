/**
 * 知识库边缘增强 —— 边缘小模型驱动的知识管理四能力
 *
 *   1. structureKnowledgeWithEdge    — 文档结构化（pipeline 优先边缘，失败回退 GLM）
 *   2. rewriteKnowledgeQueryWithEdge — 自然语言问题 → 检索关键词
 *   3. judgeKnowledgeQualityWithEdge — validateContent 灰区质量裁决
 *   4. isNearDuplicateWithEdge       — 采集前近重复判断
 *   5. summarizeKnowledgeWithEdge    — 采集摘要
 *
 * 全部可空返回（null = 不可用，调用方回退规则/云端路径）。
 * 开关：EDGE_KNOWLEDGE_ASSIST=0 全部禁用（默认启用）。
 */

import { getEdgeClient, isEdgeEnabled, extractJson } from "../local-llm/edge-client.js";
import type { LLMClient } from "../dre/llm/client.js";
import { logger } from "../utils/logger.js";

type GenerateClient = Pick<LLMClient, "generate">;

/** 结构化结果（与 pipeline.ts StructureResult 对齐） */
export interface EdgeStructureResult {
  title: string;
  summary: string;
  keywords: string[];
  quality_score: number;
  sections: Array<{ heading: string; content: string }>;
  entities: Array<{ name: string; type: string }>;
  structured_data: unknown | null;
}

const MAX_INPUT_CHARS = 4000;

function truncate(s: string, n = MAX_INPUT_CHARS): string {
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * 文档结构化：提取 title/summary/keywords/quality_score。
 * sections/entities/structured_data 由下游 zod 默认值兜底。
 */
export async function structureKnowledgeWithEdge(
  rawMarkdown: string,
  client?: GenerateClient,
): Promise<EdgeStructureResult | null> {
  if (!isEdgeEnabled("EDGE_KNOWLEDGE_ASSIST")) return null;

  try {
    const llm = client ?? getEdgeClient();
    const resp = await llm.generate(
      `将以下文档结构化为 JSON：{"title":"文档标题","summary":"100字以内摘要","keywords":["关键词1","关键词2"],"quality_score":0.0-1.0}。文档：【${truncate(rawMarkdown, 8000)}】`,
      { maxTokens: 400, answerPrefix: '{"title":"' },
    );
    const parsed = extractJson<{
      title?: unknown; summary?: unknown; keywords?: unknown; quality_score?: unknown;
    }>(resp.content ?? "");

    if (!parsed || typeof parsed.title !== "string" || parsed.title.trim().length === 0) return null;
    if (typeof parsed.summary !== "string") return null;

    const quality = typeof parsed.quality_score === "number"
      ? Math.max(0, Math.min(1, parsed.quality_score))
      : 0.5;

    return {
      title: parsed.title.trim(),
      summary: parsed.summary,
      keywords: Array.isArray(parsed.keywords)
        ? parsed.keywords.filter((k): k is string => typeof k === "string").slice(0, 10)
        : [],
      quality_score: quality,
      sections: [],
      entities: [],
      structured_data: null,
    };
  } catch (err) {
    logger.debug("[EdgeKnowledge] structure failed", { error: (err as Error).message });
    return null;
  }
}

/**
 * 检索查询改写：自然语言 → 空格分隔关键词（JSON 数组引导，防跑题）。
 */
export async function rewriteKnowledgeQueryWithEdge(
  query: string,
  client?: GenerateClient,
): Promise<string | null> {
  if (!isEdgeEnabled("EDGE_KNOWLEDGE_ASSIST")) return null;

  try {
    const llm = client ?? getEdgeClient();
    const resp = await llm.generate(
      `把以下问题改写为知识库检索关键词（2-6 个词）。问题：【${truncate(query, 500)}】只回答JSON {"keywords":["词1","词2"]}`,
      { maxTokens: 60, answerPrefix: '{"keywords":["' },
    );
    const parsed = extractJson<{ keywords?: unknown }>(resp.content ?? "");
    if (parsed && Array.isArray(parsed.keywords)) {
      const words = parsed.keywords
        .filter((w): w is string => typeof w === "string" && w.trim().length > 0)
        .map((w) => w.trim())
        .slice(0, 8);
      if (words.length > 0) return words.join(" ");
    }
    return null;
  } catch (err) {
    logger.debug("[EdgeKnowledge] query rewrite failed", { error: (err as Error).message });
    return null;
  }
}

/**
 * 灰区质量裁决：规则评分略低于阈值时给内容第二次机会。
 */
export async function judgeKnowledgeQualityWithEdge(
  title: string,
  snippet: string,
  client?: GenerateClient,
): Promise<{ pass: boolean; reason?: string } | null> {
  if (!isEdgeEnabled("EDGE_KNOWLEDGE_ASSIST")) return null;

  try {
    const llm = client ?? getEdgeClient();
    const resp = await llm.generate(
      `判断以下采集内容是否有实质知识价值（非广告/导航页/拼凑内容）。标题：【${truncate(title, 200)}】内容：【${truncate(snippet, 1000)}】只回答JSON {"pass": true或false, "reason": "<=15字"}`,
      { maxTokens: 60, answerPrefix: '{"pass":' },
    );
    const parsed = extractJson<{ pass?: unknown; reason?: unknown }>(resp.content ?? "");
    if (parsed && typeof parsed.pass === "boolean") {
      return { pass: parsed.pass, reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
    }
    return null;
  } catch (err) {
    logger.debug("[EdgeKnowledge] quality judge failed", { error: (err as Error).message });
    return null;
  }
}

/**
 * 近重复判断：新内容与候选标题集合是否实质重复。
 * 无候选 → false（不调模型）；模型不可用 → null（调用方按不重复处理）。
 */
export async function isNearDuplicateWithEdge(
  newTitle: string,
  newSnippet: string,
  candidateTitles: string[],
  client?: GenerateClient,
): Promise<boolean | null> {
  if (candidateTitles.length === 0) return false;
  if (!isEdgeEnabled("EDGE_KNOWLEDGE_ASSIST")) return null;

  try {
    const llm = client ?? getEdgeClient();
    const candidates = candidateTitles.slice(0, 5).map((t, i) => `${i + 1}. ${t}`).join("\n");
    const resp = await llm.generate(
      `判断新文档是否与已有文档实质重复（同一主题同一内容，而非仅相关）。新文档：【${truncate(newTitle, 200)}】摘要：【${truncate(newSnippet, 500)}】已有：\n${candidates}\n只回答JSON {"duplicate": true或false}`,
      { maxTokens: 40, answerPrefix: '{"duplicate":' },
    );
    const parsed = extractJson<{ duplicate?: unknown }>(resp.content ?? "");
    if (parsed && typeof parsed.duplicate === "boolean") return parsed.duplicate;
    return null;
  } catch (err) {
    logger.debug("[EdgeKnowledge] near-dup check failed", { error: (err as Error).message });
    return null;
  }
}

/**
 * 采集摘要（100 字以内）。
 */
export async function summarizeKnowledgeWithEdge(
  markdown: string,
  client?: GenerateClient,
): Promise<string | null> {
  if (!isEdgeEnabled("EDGE_KNOWLEDGE_ASSIST")) return null;

  try {
    const llm = client ?? getEdgeClient();
    const resp = await llm.generate(
      `用不超过100字概括以下内容的核心要点，只输出概括本身：【${truncate(markdown, 2000)}】`,
      { maxTokens: 160 },
    );
    const summary = (resp.content ?? "").trim().split(/\r?\n/)[0].trim();
    return summary.length >= 10 ? summary : null;
  } catch (err) {
    logger.debug("[EdgeKnowledge] summarize failed", { error: (err as Error).message });
    return null;
  }
}
