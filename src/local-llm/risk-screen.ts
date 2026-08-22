/**
 * 边缘风险初筛 —— 灰区操作的第一层 LLM 分类
 *
 * 定位：permissions.ts 的正则硬底线（不可绕过）之外，对正则不命中的
 * 灰区命令/路径做风险初筛。本层 fail-open：任何失败都降级为
 * { risk: "low", degraded: true }，由编排层（risk-monitor.ts）决定
 * 是否需要第二层复核。
 *
 * 实测（Qwopus3.5-4B，2026-07-25）：rm -rf / dd / force-push → high，
 * ls → low，JSON 输出稳定。
 */

import { getEdgeClient, extractJson } from "./edge-client.js";
import type { LLMClient } from "../dre/llm/client.js";
import { logger } from "../utils/logger.js";

/** 被筛查的负载类型（M4：新增 url —— browser_launch 等外开地址） */
export type PayloadKind = "command" | "path" | "url";

/** 边缘风险等级 */
export type EdgeRisk = "low" | "medium" | "high";

export interface EdgeRiskResult {
  risk: EdgeRisk;
  reason?: string;
  /** true = 本次结果来自降级路径（模型失败/输出非法），实际未筛查 */
  degraded: boolean;
}

const VALID_RISKS = new Set<EdgeRisk>(["low", "medium", "high"]);

/** 降级结果（fail-open） */
function degradedResult(): EdgeRiskResult {
  return { risk: "low", degraded: true };
}

/**
 * 用边缘小模型对命令/路径做风险初筛。
 *
 * @param payload 命令或路径文本
 * @param kind    负载类型（command / path）
 * @param client  可注入客户端（测试用；默认边缘单例）
 */
export async function screenPayloadWithEdge(
  payload: string,
  kind: PayloadKind,
  client?: Pick<LLMClient, "generate">,
): Promise<EdgeRiskResult> {
  try {
    const llm = client ?? getEdgeClient();
    const kindLabel =
      kind === "command" ? "shell command" : kind === "url" ? "URL to open in browser" : "file operation on path";
    const truncated = payload.length > 500 ? payload.slice(0, 500) : payload;

    const resp = await llm.generate(
      `Classify risk of the following ${kindLabel}: ${truncated}. Reply JSON {"risk":"low|medium|high","reason":"<=15 words"}`,
      { maxTokens: 60, answerPrefix: '{"risk":"' },
    );

    const parsed = extractJson<{ risk?: unknown; reason?: unknown }>(resp.content ?? "");
    if (parsed && VALID_RISKS.has(parsed.risk as EdgeRisk)) {
      return {
        risk: parsed.risk as EdgeRisk,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
        degraded: false,
      };
    }

    logger.debug("[RiskScreen] invalid edge output, degraded", {
      content: (resp.content ?? "").slice(0, 80),
    });
    return degradedResult();
  } catch (err) {
    logger.debug("[RiskScreen] edge call failed, degraded", {
      error: (err as Error).message,
    });
    return degradedResult();
  }
}
