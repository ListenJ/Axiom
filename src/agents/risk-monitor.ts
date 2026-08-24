/**
 * 高危操作双层复核监视器 —— 边缘初筛 → 主模型复核 → 强制 HITL
 *
 * 定位：execution-mode.ts 的 executeWithModeGuard 在执行前调用。
 * 监视对象为正则硬底线（permissions.ts，不可绕过）覆盖不到的**灰区**操作：
 * 静态分级表按工具名定级（如 terminal_exec=caution），但无法感知
 * 负载内容（`rm -rf /usr` 与 `ls` 同为 terminal_exec）。
 *
 * 双层流程：
 *   1. 边缘小模型初筛（~0.3-1s）：low → 直接放行
 *   2. medium/high → 主模型（router decision 角色）复核
 *   3. 复核确认 dangerous → "require-approval"（由调用方强制 HITL，YOLO 也不豁免）
 *
 * 回退语义：
 *   - 初筛失败/降级 → 放行（fail-open，不打断 agent）
 *   - 复核失败 + 初筛 high → 升级审批（fail-closed）
 *   - 复核失败 + 初筛 medium → 放行（fail-open）
 *   - EDGE_RISK_MONITOR=0 → 完全旁路
 *
 * 所有升级判定写 auditLogger（security.alert 事件）。
 */

import { isEdgeEnabled, extractJson } from "../local-llm/edge-client.js";
import { screenPayloadWithEdge, type EdgeRiskResult, type PayloadKind } from "../local-llm/risk-screen.js";
import { TOOL_CLASSIFICATIONS } from "./tool-classifications.js";
import { auditLogger } from "../utils/audit-logger.js";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";

/** 监视结论 */
export type RiskVerdict = "pass" | "require-approval";

/**
 * 审计 C-4（2026-08-24）：初筛降级/失败导致的旁路此前完全不可观测。
 * 计数器 + 审计事件让"本次判定来自降级"可见；EDGE_RISK_FAIL_CLOSED=1
 * 时升级为强制审批（默认保持 fail-open 以不阻断离线环境）。
 */
let degradedBypassCount = 0;
export function getDegradedBypassCount(): number {
  return degradedBypassCount;
}
export function resetDegradedBypassCount(): void {
  degradedBypassCount = 0;
}

function isFailClosedEnabled(): boolean {
  return readString("EDGE_RISK_FAIL_CLOSED", "0") === "1";
}

/** 复核结果（null = 复核不可用） */
export interface ReviewResult {
  dangerous: boolean;
  reason?: string;
}

/** 可注入依赖（测试用 fake；生产为真实实现） */
export interface RiskMonitorDeps {
  screen?: (payload: string, kind: PayloadKind) => Promise<EdgeRiskResult>;
  review?: (payload: string, kind: PayloadKind) => Promise<ReviewResult | null>;
}

/** 类别 → 负载形态映射（仅收录可识别 command/path 形态的类别） */
const CATEGORY_SPEC: Partial<Record<string, { kind: PayloadKind; fields: string[] }>> = {
  terminal: { kind: "command", fields: ["command", "script"] },
  filesystem: { kind: "path", fields: ["path", "file", "target", "destination", "from", "to"] },
  snapshot: { kind: "path", fields: ["path", "name", "target"] },
};

/**
 * M4 审计修复：审查清单由 TOOL_CLASSIFICATIONS 单一数据源动态派生，
 * 并显式补齐注册表遗漏的高危工具（browser_launch / knowledge_ingest_document）。
 */
const SCREENED_TOOLS: Record<string, { kind: PayloadKind; fields: string[] }> = (() => {
  const map: Record<string, { kind: PayloadKind; fields: string[] }> = {};
  for (const t of TOOL_CLASSIFICATIONS) {
    if (t.risk === "safe") continue;
    const spec = CATEGORY_SPEC[t.category];
    if (spec) map[t.name] = spec;
  }
  // 漏网高危补齐（审计 P6）：负载形态特殊，无法由类别推导
  map["browser_launch"] = { kind: "url", fields: ["url"] };
  map["knowledge_ingest_document"] = { kind: "path", fields: ["file"] };
  return map;
})();

/** 当前被双层复核监视的工具名集合（供测试与可观测性使用） */
export const SCREENED_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(SCREENED_TOOLS));

/**
 * 从工具参数中提取被监视负载。无需监视的工具/无有效负载返回 null。
 */
export function extractPayload(
  toolName: string,
  args: unknown,
): { kind: PayloadKind; payload: string } | null {
  const spec = SCREENED_TOOLS[toolName];
  if (!spec || typeof args !== "object" || args === null) return null;

  const record = args as Record<string, unknown>;
  for (const field of spec.fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return { kind: spec.kind, payload: value.trim() };
    }
  }
  return null;
}

/**
 * 对工具调用做双层风险监视。
 *
 * @returns "pass" 放行 | "require-approval" 升级强制人工审批
 */
export async function monitorToolPayload(
  toolName: string,
  args: unknown,
  deps?: RiskMonitorDeps,
): Promise<RiskVerdict> {
  if (!isEdgeEnabled("EDGE_RISK_MONITOR")) return "pass";

  const extracted = extractPayload(toolName, args);
  if (!extracted) return "pass";

  const { kind, payload } = extracted;
  const screen = deps?.screen ?? screenPayloadWithEdge;
  const review = deps?.review ?? reviewWithDecisionModel;

  // ── 第一层：边缘初筛 ──
  let edge: EdgeRiskResult;
  try {
    edge = await screen(payload, kind);
  } catch (err) {
    // 初筛实现本身应自降级；此处兜底防 DI 实现抛异常
    logger.debug("[RiskMonitor] screen threw, fail-open", { error: (err as Error).message });
    degradedBypassCount++;
    auditLogger.log({
      event: "security.degraded_bypass",
      actor: "risk-monitor",
      resource: `${toolName}(${kind})`,
      outcome: "allowed",
      reason: `screen threw: ${(err as Error).message}`,
    });
    if (isFailClosedEnabled()) {
      escalate(toolName, kind, payload, "screen unavailable (EDGE_RISK_FAIL_CLOSED=1)");
      return "require-approval";
    }
    return "pass";
  }

  if (edge.risk === "low") {
    if ((edge as { degraded?: boolean }).degraded === true) {
      degradedBypassCount++;
      logger.warn("[RiskMonitor] edge screening degraded; bypass recorded", {
        toolName,
        payload: payload.slice(0, 120),
        failClosed: isFailClosedEnabled(),
      });
      auditLogger.log({
        event: "security.degraded_bypass",
        actor: "risk-monitor",
        resource: `${toolName}(${kind})`,
        outcome: "allowed",
        reason: "edge screening degraded",
      });
      if (isFailClosedEnabled()) {
        escalate(toolName, kind, payload, "edge degraded (EDGE_RISK_FAIL_CLOSED=1)");
        return "require-approval";
      }
    }
    return "pass";
  }

  logger.warn(`[RiskMonitor] edge flagged ${edge.risk} risk: ${toolName}`, {
    payload: payload.slice(0, 120),
    reason: edge.reason,
  });

  // ── 第二层：主模型复核 ──
  let reviewResult: ReviewResult | null = null;
  try {
    reviewResult = await review(payload, kind);
  } catch (err) {
    logger.warn("[RiskMonitor] review threw, treating as unavailable", {
      error: (err as Error).message,
    });
    reviewResult = null;
  }

  if (reviewResult?.dangerous === true) {
    escalate(toolName, kind, payload, `edge=${edge.risk}, review=dangerous: ${reviewResult.reason ?? ""}`);
    return "require-approval";
  }

  if (reviewResult === null && edge.risk === "high") {
    // 复核不可用 + 初筛 high → fail-closed
    escalate(toolName, kind, payload, "edge=high, review=unavailable (fail-closed)");
    return "require-approval";
  }

  logger.info(`[RiskMonitor] cleared after review: ${toolName}`, {
    edgeRisk: edge.risk,
    review: reviewResult === null ? "unavailable" : "not-dangerous",
  });
  return "pass";
}

/** 升级记录：审计日志 + warn */
function escalate(toolName: string, kind: PayloadKind, payload: string, detail: string): void {
  logger.warn(`[RiskMonitor] ESCALATED ${toolName}: ${detail}`, { payload: payload.slice(0, 120) });
  auditLogger.log({
    event: "security.alert",
    actor: "risk-monitor",
    resource: `${toolName}(${kind})`,
    outcome: "denied",
    reason: detail,
    metadata: { payload: payload.slice(0, 500) },
  });
}

/**
 * 主模型复核（生产实现）：经 router decision 角色。
 * 返回 null 表示复核不可用（无模型/网络失败/输出非法）。
 */
async function reviewWithDecisionModel(
  payload: string,
  kind: PayloadKind,
): Promise<ReviewResult | null> {
  try {
    const { router } = await import("../router/model-router.js");
    const label = kind === "command" ? "shell 命令" : kind === "url" ? "浏览器打开的 URL" : "文件路径操作";
    const resp = await router.execute({
      role: "decision",
      messages: [
        {
          role: "user",
          content: `审查以下${label}是否会导致不可逆破坏、数据丢失或安全风险：${payload.slice(0, 500)}。只回答 JSON {"dangerous": true/false, "reason": "<=30字"}`,
        },
      ],
    });
    const parsed = extractJson<{ dangerous?: unknown; reason?: unknown }>(resp?.content ?? "");
    if (parsed && typeof parsed.dangerous === "boolean") {
      return {
        dangerous: parsed.dangerous,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      };
    }
    return null;
  } catch (err) {
    logger.warn("[RiskMonitor] decision-model review failed", {
      error: (err as Error).message,
    });
    return null;
  }
}
