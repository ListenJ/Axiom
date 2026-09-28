/**
 * 知识库边缘增强（判别式化版）—— 决策类走 Laya，生成类回规则路径
 *
 * 2026-09-28 迁移（src/local-llm 删除）：
 *   1. structureKnowledgeWithEdge    — 文档结构化（生成类）→ 退役：恒 null，
 *                                      pipeline 回退 GLM → fallbackTFIDF（链路原样保留）。
 *   2. judgeKnowledgeQualityWithEdge — 灰区质量裁决（判别式）→ **Laya noul**。
 *   3. isNearDuplicateWithEdge       — 近重复判断（判别式）→ **Laya noul**。
 *   4. summarizeKnowledgeWithEdge    — 采集摘要（生成类）→ 退役：恒 null。
 *
 * 全部可空返回（null = 不可用，调用方回退规则/云端路径）——与原"边缘增强·失败回退"同向。
 *
 * 开关（**默认全关**，用户指令 2026-09-18 / 审计 C-01+A6-2 收口，口径不变）：
 *   任务形态授权 KNOWLEDGE_USE_LLM=1  且  能力开关 EDGE_KNOWLEDGE_ASSIST=1
 */

import { isEdgeEnabled } from "../decision/risk-screen.js";
import { layaDecide } from "../decision/laya-http.js";
import { readBool } from "../utils/env.js";
import { logger } from "../utils/logger.js";

/**
 * 知识采集/结构化链路的授权判定。
 * 任务形态授权（KNOWLEDGE_USE_LLM，默认 false）与能力开关（EDGE_KNOWLEDGE_ASSIST，
 * 默认关闭）必须同时成立 —— 与 src/knowledge/pipeline.ts 的 zero-LLM 默认口径对齐。
 */
function isKnowledgeEdgeEnabled(): boolean {
  return readBool("KNOWLEDGE_USE_LLM", false) && isEdgeEnabled("EDGE_KNOWLEDGE_ASSIST");
}

/** 结构化结果（与 pipeline.ts StructureResult 对齐；生成类退役后仅保留类型导出兼容） */
export interface EdgeStructureResult {
  title: string;
  summary: string;
  keywords: string[];
  quality_score: number;
  sections: Array<{ heading: string; content: string }>;
  entities: Array<{ name: string; type: string }>;
  structured_data: unknown | null;
}

/**
 * 生成类能力退役（src/local-llm 删除）：文档结构化恒 null。
 * pipeline 链路：本函数 null → structureWithGLM → fallbackTFIDF，行为语义不变。
 */
export async function structureKnowledgeWithEdge(_rawMarkdown: string): Promise<EdgeStructureResult | null> {
  return null;
}

/** 灰区质量裁决：规则评分略低于阈值时给内容第二次机会。null = 不可用（回退规则结果）。 */
export async function judgeKnowledgeQualityWithEdge(
  title: string,
  snippet: string,
): Promise<{ pass: boolean; reason?: string } | null> {
  if (!isKnowledgeEdgeEnabled()) return null;
  try {
    const resp = await layaDecide(
      `标题：【${title.slice(0, 200)}】内容：【${snippet.slice(0, 1000)}】`,
      {
        pass: {
          type: "noul",
          instructions:
            "Does this crawled content have substantive knowledge value (not an ad, navigation page, or scraped filler)?",
        },
      },
    );
    const ans = resp.answers.pass;
    if (!ans || ans.type !== "noul" || typeof ans.noul !== "number") return null;
    return { pass: ans.noul >= 0.5, reason: ans.noul >= 0.5 ? `laya noul=${ans.noul.toFixed(3)}` : undefined };
  } catch (err) {
    logger.debug("[EdgeKnowledge] quality judge (laya) failed", { error: (err as Error).message });
    return null;
  }
}

/**
 * 近重复判断：新内容与候选标题集合是否实质重复。
 * 无候选 → false（不调模型）；Laya 不可用 → null（调用方按不重复处理）。
 */
export async function isNearDuplicateWithEdge(
  newTitle: string,
  newSnippet: string,
  candidateTitles: string[],
): Promise<boolean | null> {
  if (candidateTitles.length === 0) return false;
  if (!isKnowledgeEdgeEnabled()) return null;
  try {
    const candidates = candidateTitles.slice(0, 5).map((t, i) => `${i + 1}. ${t}`).join("\n");
    const resp = await layaDecide(
      `新文档：【${newTitle.slice(0, 200)}】摘要：【${newSnippet.slice(0, 500)}】\n已有文档：\n${candidates}`,
      {
        duplicate: {
          type: "noul",
          instructions:
            "Is the new document substantively the same content as any listed existing document (same topic and same content, not merely related)?",
        },
      },
    );
    const ans = resp.answers.duplicate;
    if (!ans || ans.type !== "noul" || typeof ans.noul !== "number") return null;
    return ans.noul >= 0.5;
  } catch (err) {
    logger.debug("[EdgeKnowledge] near-dup (laya) failed", { error: (err as Error).message });
    return null;
  }
}

/** 生成类能力退役：采集摘要恒 null，调用方按"无摘要"处理。 */
export async function summarizeKnowledgeWithEdge(_markdown: string): Promise<string | null> {
  return null;
}
