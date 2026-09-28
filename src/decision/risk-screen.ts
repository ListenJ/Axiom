/**
 * 风险灰区初筛（Laya 多语言承载）—— permissions.ts 正则硬底线之外的分类层
 *
 * 迁移说明（2026-09-28）：原 `src/local-llm/risk-screen.ts`（边缘 LLM 分类）退役，
 * 灰区初筛改由内网 Laya 决策服务承载（`src/decision/laya-http.ts`，multilingual 模型，
 * choice 题型 low/medium/high）。公开形状（`EdgeRiskResult`/`PayloadKind`/降级语义）
 * 与旧实现一致，编排层（risk-monitor）与全部调用方零感知迁移。
 *
 * 保留的架构纪律：
 *  - fail-open：任何失败都降级为 { risk:"low", degraded:true }，由编排层决定第二层复核；
 *  - 正则硬底线不受影响（本层只看正则未命中的灰区）；
 *  - Laya 裁定细节与失败方向见 `laya-triage.ts`；"模型只能提高警觉"由编排层的
 *    第二层复核承接——本层结论为 high 时仍会走复核，不会因模型说 low 而放行硬底线外的高危。
 *
 * 契约注意：`confidence` 是分布置信度不是正确率；阈值标定属业务层（见契约文档第六节）。
 */
import { layaDecide } from "./laya-http.js";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";

/**
 * 功能开关（原 local-llm/edge-client 同语义搬迁）：设置且非 0/false/no 即启用。
 * 全部 EDGE_* 开关默认关闭（未设置 = 不调用任何模型），需显式授权——与
 * tests/unit/llm-default-off-policy.test.ts 的默认关闭策略同一口径。
 */
export function isEdgeEnabled(flag: string): boolean {
  const v = readString(flag).trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no";
}

export type PayloadKind = "command" | "path" | "url";
export type EdgeRisk = "low" | "medium" | "high";

export interface EdgeRiskResult {
  risk: EdgeRisk;
  reason?: string;
  /** true = 本次结果来自降级路径（服务不可用/输出非法/未配置），实际未初筛 */
  degraded: boolean;
}

const VALID_RISKS = new Set<EdgeRisk>(["low", "medium", "high"]);
const TIMEOUT_MS = 8_000;

/** 判据面集中一处：与原 risk-screen 的三分类同口径，只是分类器从边缘 LLM 换成 Laya。 */
const INSTRUCTIONS = [
  "Classify the overall risk of performing this action in a production runtime.",
  "high = destructive or irreversible (data deletion, force push, credential exposure, system modification).",
  "medium = external side effects beyond local files (network calls, service restarts, outbound requests).",
  "low = local, reversible, read-only-ish operations.",
  "Answer with the best-fitting label.",
].join(" ");

/**
 * 灰区负载风险初筛。失败一律 fail-open 返回 degraded:true（调用方按需复核），
 * 绝不抛错——本层在调用链里的契约是"尽力而为的分类信号"。
 */
export async function screenPayloadWithEdge(
  payload: string,
  kind: PayloadKind,
  config: Parameters<typeof layaDecide>[2] = {},
): Promise<EdgeRiskResult> {
  const kindText = kind === "command" ? "shell command" : kind === "path" ? "filesystem path" : "URL";
  try {
    const resp = await layaDecide(
      `${kindText}: ${payload}`,
      { risk: { type: "choice", instructions: INSTRUCTIONS, criteria: ["low", "medium", "high"] } },
      config,
    );
    const ans = resp.answers.risk;
    if (!ans || ans.type !== "choice") {
      return { risk: "low", degraded: true, reason: "laya-answer-shape" };
    }
    const label = ans.choice ?? "";
    if (!VALID_RISKS.has(label as EdgeRisk)) {
      return { risk: "low", degraded: true, reason: "laya-invalid-label" };
    }
    return {
      risk: label as EdgeRisk,
      degraded: false,
      // 分布置信度只作留痕参考（不是正确率，不做阈值裁定）。
      reason: `laya choice=${label} p=${ans.probabilities?.[label]?.toFixed(3) ?? "?"}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`[RiskScreenLaya] degraded: ${msg.slice(0, 120)}`);
    return { risk: "low", degraded: true, reason: msg.slice(0, 80) };
  }
}
