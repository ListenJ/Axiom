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
import { isEdgeEnabled } from "../../src/decision/risk-screen.js";
import { layaHealth } from "../../src/decision/laya-http.js";
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

/** fetch 计数器：验证"未授权零调用"（2026-09-28 起边缘链路经 Laya HTTP） */
const REAL_FETCH = globalThis.fetch;
function installCountingFetch(impl: (body: { questions?: Record<string, unknown> }) => unknown) {
  let calls = 0;
  process.env.LAYA_DECISION_URL = process.env.LAYA_DECISION_URL ?? "http://laya.test:18081";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return new Response(JSON.stringify(impl(body)), { status: 200 });
  }) as typeof fetch;
  return {
    getCalls: () => calls,
    restore: () => {
      globalThis.fetch = REAL_FETCH;
    },
  };
}

/** 按请求的问题键回填 noul 答案（mock 与问题键解耦） */
function noulRespFor(body: { questions?: Record<string, unknown> }, v: number) {
  const answers: Record<string, unknown> = {};
  for (const k of Object.keys(body.questions ?? {})) {
    answers[k] = { type: "noul", noul: v, confidence: v };
  }
  return {
    model: "laya-rl-agent",
    answers,
    usage: { input_tokens: 10, output_tokens: 0 },
    routing: { model: "multilingual" },
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

describe("知识采集链 —— 默认不调 Laya", () => {
  test("无授权：质量裁决不调用模型并返回 null（回退规则）", async () => {
    const f = installCountingFetch((body: { questions?: Record<string, unknown> }) => noulRespFor(body, 0.9));
    try {
      const r = await judgeKnowledgeQualityWithEdge("t", "s");
      expect(r).toBeNull();
      expect(f.getCalls()).toBe(0);
    } finally {
      f.restore();
    }
  });
  test("仅 EDGE_KNOWLEDGE_ASSIST=1 而 KNOWLEDGE_USE_LLM 未开 → 仍关闭（任务形态未授权）", async () => {
    process.env.EDGE_KNOWLEDGE_ASSIST = "1";
    const f = installCountingFetch((body: { questions?: Record<string, unknown> }) => noulRespFor(body, 0.9));
    try {
      const r = await judgeKnowledgeQualityWithEdge("t", "s");
      expect(r).toBeNull();
      expect(f.getCalls()).toBe(0);
    } finally {
      f.restore();
    }
  });
  test("双开关同时授权 → 放行（Laya noul ≥0.5 = 值得）", async () => {
    process.env.EDGE_KNOWLEDGE_ASSIST = "1";
    process.env.KNOWLEDGE_USE_LLM = "1";
    const f = installCountingFetch((body: { questions?: Record<string, unknown> }) => noulRespFor(body, 0.9));
    try {
      const r = await judgeKnowledgeQualityWithEdge("t", "s");
      expect(r?.pass).toBe(true);
      expect(f.getCalls()).toBe(1);
    } finally {
      f.restore();
    }
  });
});

describe("记忆整理链 —— 默认不调 Laya", () => {
  test("无授权：返回 null 且不调用模型", async () => {
    const f = installCountingFetch((body: { questions?: Record<string, unknown> }) => noulRespFor(body, 0.9));
    try {
      const r = await judgeSignificanceWithEdge("q", "a");
      expect(r).toBeNull();
      expect(f.getCalls()).toBe(0);
    } finally {
      f.restore();
    }
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
