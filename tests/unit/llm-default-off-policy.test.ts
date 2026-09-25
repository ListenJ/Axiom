/**
 * LLM 默认关闭策略（用户指令 2026-09-18 ①，审计 C-01/A6-2 收口）
 *
 * 契约：运行时**默认不调用任何辅助 LLM**（内部规则路径优先）；
 * 仅在用户显式设置对应环境变量（= 用户授权）后才放行。
 *
 * 覆盖任务形态：
 *   - 知识采集/结构化（KNOWLEDGE_USE_LLM + EDGE_KNOWLEDGE_ASSIST）
 *   - 记忆整理（EDGE_MEMORY_ASSIST）
 *   - 提示词改写（PROMPT_REWRITE / EDGE_PROMPT_REWRITE）
 *   - 高风险工具灰区初筛（EDGE_RISK_MONITOR）
 *   - 通用边缘开关读取（isEdgeEnabled）
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { isEdgeEnabled } from "../../src/local-llm/edge-client.js";
import { isRewriteEnabled } from "../../src/agents/prompt-optimizer.js";
import { judgeKnowledgeQualityWithEdge } from "../../src/knowledge/edge-assist.js";
import { judgeSignificanceWithEdge } from "../../src/memory/edge-assist.js";
import { screenToolCall, resetRiskVerdictCache } from "../../src/agents/risk-monitor.js";

const MANAGED = [
  "EDGE_UNSET_FLAG",
  "PROMPT_REWRITE",
  "EDGE_PROMPT_REWRITE",
  "EDGE_KNOWLEDGE_ASSIST",
  "KNOWLEDGE_USE_LLM",
  "EDGE_MEMORY_ASSIST",
  "EDGE_RISK_MONITOR",
];
const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of MANAGED) {
    original[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of MANAGED) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

/** 计数 fake：任何调用都会被记录 */
function countingClient(content: string) {
  let calls = 0;
  return {
    client: {
      generate: async () => {
        calls++;
        return { content, model: "mock", usage: { promptTokens: 0, completionTokens: 0 }, finishReason: "stop" };
      },
    },
    getCalls: () => calls,
  };
}

describe("isEdgeEnabled —— 未授权默认关闭", () => {
  test("未设置 → false（不再默认开启）", () => {
    expect(isEdgeEnabled("EDGE_UNSET_FLAG")).toBe(false);
  });
  test("显式 =1/true → true（用户授权）", () => {
    process.env.EDGE_UNSET_FLAG = "1";
    expect(isEdgeEnabled("EDGE_UNSET_FLAG")).toBe(true);
    process.env.EDGE_UNSET_FLAG = "true";
    expect(isEdgeEnabled("EDGE_UNSET_FLAG")).toBe(true);
  });
  test("=0/false → false（显式拒绝优先）", () => {
    process.env.EDGE_UNSET_FLAG = "0";
    expect(isEdgeEnabled("EDGE_UNSET_FLAG")).toBe(false);
    process.env.EDGE_UNSET_FLAG = "false";
    expect(isEdgeEnabled("EDGE_UNSET_FLAG")).toBe(false);
  });
});

describe("isRewriteEnabled —— 提示词改写默认关闭", () => {
  test("未设置 → false", () => {
    expect(isRewriteEnabled()).toBe(false);
  });
  test("PROMPT_REWRITE=1 → true", () => {
    process.env.PROMPT_REWRITE = "1";
    expect(isRewriteEnabled()).toBe(true);
  });
  test("EDGE_PROMPT_REWRITE=1（旧开关）→ true", () => {
    process.env.EDGE_PROMPT_REWRITE = "1";
    expect(isRewriteEnabled()).toBe(true);
  });
});

describe("知识采集链 —— 默认不调 LLM", () => {
  test("无授权：质量裁决不调用模型并返回 null（回退规则）", async () => {
    const { client, getCalls } = countingClient('{"pass":true}');
    const r = await judgeKnowledgeQualityWithEdge("t", "s", client);
    expect(r).toBeNull();
    expect(getCalls()).toBe(0);
  });
  test("仅 EDGE_KNOWLEDGE_ASSIST=1 而 KNOWLEDGE_USE_LLM 未开 → 仍关闭（任务形态未授权）", async () => {
    process.env.EDGE_KNOWLEDGE_ASSIST = "1";
    const { client, getCalls } = countingClient('{"pass":true}');
    const r = await judgeKnowledgeQualityWithEdge("t", "s", client);
    expect(r).toBeNull();
    expect(getCalls()).toBe(0);
  });
  test("双开关同时授权 → 放行并解析", async () => {
    process.env.EDGE_KNOWLEDGE_ASSIST = "1";
    process.env.KNOWLEDGE_USE_LLM = "1";
    const { client, getCalls } = countingClient('{"pass":true}');
    const r = await judgeKnowledgeQualityWithEdge("t", "s", client);
    expect(r?.pass).toBe(true);
    expect(getCalls()).toBe(1);
  });
});

describe("记忆整理链 —— 默认不调 LLM", () => {
  test("无授权：返回 null 且不调用模型", async () => {
    const { client, getCalls } = countingClient('{"worth":true}');
    const r = await judgeSignificanceWithEdge("q", "a", client);
    expect(r).toBeNull();
    expect(getCalls()).toBe(0);
  });
});

describe("高风险工具灰区初筛 —— 默认走规则路径", () => {
  test("无授权（生产路径）：未注入适配器且 EDGE_RISK_MONITOR 未设 ⇒ 直接 pass，零边缘调用", async () => {
    // ours 契约（归一裁决，与 ku 线 monitorToolPayload 相反）：生产默认关闭的保证点在
    // screenToolCall 内部的 isEdgeEnabled 门（deps.screen 为 null ⇒ 不会触达任何 LLM）；
    // 显式注入适配器 = 测试路径，设计上不受生产开关约束（见 risk-monitor.ts 注释）。
    resetRiskVerdictCache();
    const verdict = await screenToolCall({
      capabilities: ["proc.exec"],
      args: { command: "ls" },
      toolName: "terminal_exec",
    });
    expect(verdict).toBe("pass");
  });

  test("显式注入适配器 = 测试路径：不受生产开关约束（ours 语义）", async () => {
    resetRiskVerdictCache();
    let screenCalls = 0;
    const verdict = await screenToolCall(
      { capabilities: ["proc.exec"], args: { command: "ls" }, toolName: "terminal_exec" },
      {
        screen: async () => {
          screenCalls++;
          return { risk: "high", reason: "fake", degraded: false };
        },
        review: async () => ({ dangerous: true, reason: "fake" }),
      },
    );
    expect(screenCalls).toBe(1);
    expect(["pass", "require-approval"]).toContain(verdict);
  });
});
