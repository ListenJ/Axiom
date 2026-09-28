/**
 * vault 边缘辅助（判别式化版）—— 决策类增强走 Laya，生成类回规则路径
 *
 * 2026-09-28 迁移（src/local-llm 删除）：
 *   1. judgeSignificanceWithEdge — MemoryGate 灰区显著性裁决 → **Laya noul**（判别式，
 *      multilingual 多语言，无生成）；返回形状不变（{worth, reason?} | null）。
 *   2. generateTitleWithEdge     — 语义化标题（生成类）→ 退役：恒 null，调用方规则回退。
 *   3. generateTagsWithEdge      — 2-5 个检索标签（生成类）→ 退役：恒 null，调用方规则回退。
 *
 * 开关：EDGE_MEMORY_ASSIST 显式授权（默认关闭，同 llm-default-off-policy 口径）。
 * Laya 不可用/未配置 ⇒ null（fail-open 到规则路径），与原"边缘增强·失败回退"同向。
 */
import { isEdgeEnabled } from "../decision/risk-screen.js";
import { layaDecide } from "../decision/laya-http.js";
import { logger } from "../utils/logger.js";

const MAX_INPUT_CHARS = 1500;

function truncate(s: string): string {
  return s.length > MAX_INPUT_CHARS ? s.slice(0, MAX_INPUT_CHARS) : s;
}

/** 灰区显著性裁决：该问答是否值得写入记忆库。null = 不可用/未授权（回退规则）。 */
export async function judgeSignificanceWithEdge(
  userMessage: string,
  response: string,
  _client?: unknown,
): Promise<{ worth: boolean; reason?: string } | null> {
  if (!isEdgeEnabled("EDGE_MEMORY_ASSIST")) return null;
  try {
    const resp = await layaDecide(
      `用户：【${truncate(userMessage)}】\n回答：【${truncate(response)}】`,
      {
        worth: {
          type: "noul",
          instructions:
            "Does this exchange contain information worth storing in a long-term memory base (reusable solutions, configurations, decisions, facts) rather than small talk?",
        },
      },
    );
    const ans = resp.answers.worth;
    if (!ans || ans.type !== "noul" || typeof ans.noul !== "number") return null;
    // 与旧实现同形：worth 即"值得写入"；noul>=0.5 为 YES（契约取值规则）。
    return {
      worth: ans.noul >= 0.5,
      reason: ans.noul >= 0.5 ? `laya noul=${ans.noul.toFixed(3)}` : undefined,
    };
  } catch (err) {
    logger.debug("[EdgeAssist] significance judge (laya) failed", { error: (err as Error).message });
    return null;
  }
}

/** 生成类能力退役：标题生成恒 null，调用方走规则回退（40 字符截断等）。 */
export async function generateTitleWithEdge(
  _content: string,
  _fallback?: string,
): Promise<string | null> {
  return null;
}

/** 生成类能力退役：标签生成恒 null，调用方走规则回退（无附加标签）。 */
export async function generateTagsWithEdge(_content: string): Promise<string[] | null> {
  return null;
}
